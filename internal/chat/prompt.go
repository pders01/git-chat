package chat

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
)

// Context budget caps. Each has a sensible default for small local
// models (Gemma 4B, 4K practical context) and can be overridden via
// environment variable for users running larger models (Claude, GPT-4)
// where the context window is 128K+ and the defaults are wastefully
// conservative.
//
// Env vars:
//   GITCHAT_MAX_FILE_BYTES      — per @-file injection cap (default 4096)
//   GITCHAT_MAX_TOTAL_INJECT    — total @-file budget per turn (default 12288)
//   GITCHAT_MAX_BASELINE_BYTES  — overview doc cap (default 4096)
//   GITCHAT_MAX_HISTORY_DIFF    — per-diff in history expansion (default 4096)
var (
	maxInjectedFileBytes    = envInt("GITCHAT_MAX_FILE_BYTES", 4*1024)
	maxTotalInjectedBytes   = envInt("GITCHAT_MAX_TOTAL_INJECT", 12*1024)
	maxBaselineContextBytes = envInt("GITCHAT_MAX_BASELINE_BYTES", 4*1024)
	maxHistoryDiffBytes     = envInt("GITCHAT_MAX_HISTORY_DIFF", 4*1024)
	maxTreeLines            = envInt("GITCHAT_MAX_TREE_LINES", 60)
	maxTreeBytes            = envInt("GITCHAT_MAX_TREE_BYTES", 2*1024)
	recentCommitCount       = envInt("GITCHAT_RECENT_COMMITS", 5)
)

func envInt(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// diffMarkerPattern matches [[diff]] or [[diff key=value …]] in
// historical assistant messages. Kept in sync with the frontend
// regex in web/src/lib/markdown.ts.
var diffMarkerPattern = regexp.MustCompile(`\[\[diff(?:\s+([^\]\n]+))?\]\]`)

// diffAttrPattern matches key=value pairs inside a marker's attr
// list, accepting either bare values or "double-quoted" values with
// spaces.
var diffAttrPattern = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|(\S+))`)

// recentCommits returns a short git log (last 5 commits) for baseline
// context. Lets the model answer "what changed recently?" without the
// user switching to the log tab. ~200 bytes, negligible context cost.
func recentCommits(ctx context.Context, r *repo.Entry) string {
	commits, _, err := r.ListCommits(ctx, "", int(recentCommitCount), 0, "")
	if err != nil || len(commits) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, c := range commits {
		fmt.Fprintf(&sb, "- %s %s (%s)\n", c.ShortSha, c.Message, c.AuthorName)
	}
	return strings.TrimRight(sb.String(), "\n")
}

// overviewFiles is the ordered fallback list for "the file that describes
// this repo." First one that exists at HEAD wins. README-like conventions
// first, then architecture docs, then meta-context files.
var overviewFiles = []string{
	"README.md",
	"README",
	"readme.md",
	"docs/ARCHITECTURE.md",
	"ARCHITECTURE.md",
	"docs/architecture.md",
	"CLAUDE.md",
	"AGENTS.md",
	"CONTRIBUTING.md",
}

// filePattern matches `@path/to/file` references. We intentionally keep
// the character class narrow (no spaces, no parentheses, no escaped
// characters) to avoid false positives inside prose like "see @app.ts".
var filePattern = regexp.MustCompile(`@([A-Za-z0-9][\w\-./]*\.[A-Za-z0-9]+|[A-Za-z0-9][\w\-./]*/)`)

// buildPrompt turns the session history + new user turn into a llm.Request
// messages slice. Prompt assembly order (outermost → innermost):
//
//  1. Baseline system instructions (honest, non-hallucination behaviour)
//  2. Repo fingerprint: name, default branch, HEAD SHA
//  3. Top-level file/directory listing
//  4. Overview file (README / ARCHITECTURE.md / etc) — truncated
//  5. @file mentions from the user's message — truncated per file and in aggregate
//  6. Prior chat history
//  7. Current user turn
//
// Steps 3-5 are what the grounding story depends on. Without them, Gemma
// is happy to confabulate from the repo name alone.
func (s *Service) buildPrompt(
	ctx context.Context,
	repoEntry *repo.Entry,
	sessionHistory []*storage.MessageRow,
	userText string,
) []llm.Message {
	var sb strings.Builder
	sb.WriteString(s.baseSystemPrompt(repoEntry))

	if tree := baselineTree(repoEntry); tree != "" {
		sb.WriteString("\n\n## Repository layout (2 levels)\n\n")
		sb.WriteString(tree)
	}
	if overview, label := overviewDoc(repoEntry); overview != "" {
		fmt.Fprintf(&sb, "\n\n## Project overview (from `%s`)\n\n```\n%s\n```", label, overview)
	}
	if recentLog := recentCommits(ctx, repoEntry); recentLog != "" {
		sb.WriteString("\n\n## Recent commits\n\n")
		sb.WriteString(recentLog)
	}
	if inj := s.resolveMentions(ctx, repoEntry, userText); inj != "" {
		sb.WriteString("\n\n## Files you were shown\n\n")
		sb.WriteString(inj)
	}

	// Per-turn memoization so repeated references to the same (from,
	// to, path) tuple in history hit go-git exactly once.
	diffCache := map[string]string{}

	msgs := make([]llm.Message, 0, len(sessionHistory)+2)
	msgs = append(msgs, llm.Message{Role: llm.RoleSystem, Content: sb.String()})
	for _, m := range sessionHistory {
		content := m.Content
		if m.Role == "assistant" && diffMarkerPattern.MatchString(content) {
			content = expandHistoryDiffMarkers(repoEntry, content, diffCache)
		}
		msgs = append(msgs, llm.Message{
			Role:    llm.Role(m.Role),
			Content: content,
		})
	}
	msgs = append(msgs, llm.Message{Role: llm.RoleUser, Content: userText})
	return msgs
}

// expandHistoryDiffMarkers replaces every `[[diff …]]` marker in a
// historical assistant message with a fenced ```diff block carrying
// the actual patch text. The user already saw the rendered diff in
// the UI at the time; this pass makes the content available to the
// LLM so follow-up questions like "explain those changes" have real
// content to ground on.
//
// Unresolvable markers are left as-is — it's better for the model to
// see the raw marker than to silently drop a reference it might have
// been about to explain.
func expandHistoryDiffMarkers(r *repo.Entry, text string, cache map[string]string) string {
	return diffMarkerPattern.ReplaceAllStringFunc(text, func(match string) string {
		sub := diffMarkerPattern.FindStringSubmatch(match)
		attrs := ""
		if len(sub) > 1 {
			attrs = sub[1]
		}
		from, to, path := parseMarkerAttrs(attrs)
		cacheKey := from + "|" + to + "|" + path
		if cached, ok := cache[cacheKey]; ok {
			return cached
		}
		diff, _, _, empty, _, err := r.GetDiff(from, to, path, false)
		if err != nil {
			cache[cacheKey] = match
			return match
		}
		var expansion string
		if empty {
			expansion = fmt.Sprintf("(no changes for %s)", cacheKey)
		} else {
			body := diff
			if int64(len(body)) > maxHistoryDiffBytes {
				body = body[:maxHistoryDiffBytes] + "\n… (diff truncated for history)\n"
			}
			expansion = "\n```diff\n" + body + "\n```\n"
		}
		cache[cacheKey] = expansion
		return expansion
	})
}

// parseMarkerAttrs extracts from/to/path from a marker's attribute
// text (everything inside "[[diff …]]" after the "diff" keyword).
// Missing attributes stay empty so the caller relies on GetDiff's
// defaults (empty to = HEAD, empty from = parent of to, empty path =
// whole commit).
func parseMarkerAttrs(attrs string) (from, to, path string) {
	for _, m := range diffAttrPattern.FindAllStringSubmatch(attrs, -1) {
		key := m[1]
		val := m[2]
		if val == "" {
			val = m[3]
		}
		switch key {
		case "from":
			from = val
		case "to":
			to = val
		case "path":
			path = val
		}
	}
	return
}

func (s *Service) baseSystemPrompt(r *repo.Entry) string {
	return fmt.Sprintf(
		`You are a concise, accurate assistant helping a developer reason about the git repository %q (default branch: %s, HEAD: %s).

Rules:
- Prefer short, focused replies. No filler, no restating the question.
- Cite file paths in backticks, e.g. `+"`internal/auth/service.go`"+`.
- If a file's contents are needed to answer a question and you do not have them, say so and suggest which files the user should prefix with @ to include them (e.g. "@internal/auth/service.go"). Do NOT guess file contents you have not been shown.
- If the user asks "what is this project" and you have not been shown an overview document, describe only what you can justify from the top-level contents listing. Do not extrapolate from the repository name.
- When the user mentions a file with @, its resolution result appears in a "Files you were shown" block below. Each entry is either the file's content OR a "NOT FOUND" line. If a path was NOT FOUND, tell the user explicitly that the path does not exist and ask them to double-check — do NOT ask them to re-send the same @-mention.
- Never invent file paths. Only reference paths you can see in the top-level listing or that have appeared in the conversation already.

## Showing diffs

When the user asks about changes to a file, a commit, or "the latest
change", you do NOT need the file contents or the git history in your
context. Instead, emit a diff-request marker on its own line:

    [[diff from=<ref> to=<ref> path=<file>]]

The client will replace this marker with a syntax-highlighted diff
rendered from the actual repository. Ref syntax: HEAD, HEAD~1, HEAD^,
HEAD~3, a branch name, a short or full SHA.

### Shapes

- Single file, latest change:            `+"`[[diff path=Y]]`"+`
- Single file in a specific commit:      `+"`[[diff to=X path=Y]]`"+`
- Single file between two refs:          `+"`[[diff from=A to=B path=Y]]`"+`
- Whole commit, all files it touched:    `+"`[[diff to=X]]`"+` (omit path)
- Latest commit, all files:              `+"`[[diff]]`"+` (omit everything; defaults to HEAD vs HEAD^)

Defaults: omit `+"`from=`"+` to use the parent of `+"`to`"+`; omit `+"`to=`"+` to use HEAD; omit `+"`path=`"+` to include every file changed in the range.

### Example — single file

User: "Show me the latest change to internal/repo/reader.go"

Your reply (exactly this, one marker on its own line, no fenced code block):

Here is the latest change to `+"`internal/repo/reader.go`"+`:

[[diff path=internal/repo/reader.go]]

### Example — whole commit

User: "Show me the diff of the most recent commit"

Your reply:

Here is the most recent commit:

[[diff]]

### Do NOT

- Do NOT say "I cannot show the diff because I do not have the file contents." You do not need them. Just emit the marker.
- Do NOT wrap the marker in a fenced code block. It must appear on its own line as plain text.
- Do NOT wrap the marker in inline-code backticks like `+"`[[diff]]`"+`. It must appear as bare text with no surrounding punctuation of any kind — no backticks, no quotes, no brackets. The client rewrites the marker into a diff block itself.
- Do NOT put anything else on the same line as the marker. Prose goes on the lines before or after it, never adjacent.
- Do NOT invent file paths; use real paths from the repository listing.
- Do NOT emit a diff marker for a diff the user has already seen. If earlier turns in this conversation already contain a fenced `+"`"+`diff`+"`"+` code block covering the same changes the user is asking about, just explain using that content — the user already has the diff on screen. Re-emitting would render a duplicate. You may emit a NEW marker only when the user is asking about different changes than what's already shown.`,
		r.Label, r.DefaultBranch, r.HeadCommit(),
	)
}

// baselineTree returns a two-level flat listing of the repo: the top
// level, then one level deeper for each top-level directory. Format is
// one line per directory, prefixed with its path, so the model can
// reference real paths instead of inventing plausible-looking ones.
//
// Two-level was chosen deliberately: depth=1 (top only) left Gemma
// guessing at everything under `internal/`; depth=3+ explodes on
// monorepos. Level 2 catches the vast majority of paths a user would
// @-mention in a chat without blowing the context window.
//
// Example output (git-chat's own repo):
//
//	/ (files: Makefile, README.md, go.mod, go.sum)
//	cmd/ (dirs: git-chat/)
//	docs/ (files: ARCHITECTURE.md)
//	internal/ (dirs: auth/, chat/, repo/, rpc/, storage/; files: assets/)
//	web/ (dirs: src/; files: index.html, package.json, tsconfig.json, vite.config.ts)
func baselineTree(r *repo.Entry) string {
	rootEntries, _, err := r.ListTree("", "")
	if err != nil || len(rootEntries) == 0 {
		return ""
	}

	var sb strings.Builder
	lines := 0

	// Root line first.
	if line := formatTreeLine("/", rootEntries); line != "" {
		sb.WriteString(line)
		sb.WriteString("\n")
		lines++
	}

	// One level deeper: each top-level directory gets its own line.
	// Gather top-level directory names in the order ListTree returned
	// them (alphabetical — go-git sorts).
	for _, e := range rootEntries {
		if e.Type != gitchatv1.EntryType_ENTRY_TYPE_DIR {
			continue
		}
		if int64(lines) >= maxTreeLines || int64(sb.Len()) >= maxTreeBytes {
			sb.WriteString("… (tree truncated)\n")
			break
		}
		sub, _, err := r.ListTree("", e.Name)
		if err != nil || len(sub) == 0 {
			continue
		}
		if line := formatTreeLine(e.Name+"/", sub); line != "" {
			sb.WriteString(line)
			sb.WriteString("\n")
			lines++
		}
	}

	return strings.TrimRight(sb.String(), "\n")
}

// formatTreeLine renders one directory's direct children as a compact
// line. Returns an empty string if there's nothing to render.
func formatTreeLine(label string, entries []*gitchatv1.TreeEntry) string {
	var dirs, files []string
	for _, e := range entries {
		switch e.Type {
		case gitchatv1.EntryType_ENTRY_TYPE_DIR:
			dirs = append(dirs, e.Name+"/")
		case gitchatv1.EntryType_ENTRY_TYPE_FILE:
			files = append(files, e.Name)
		}
	}
	if len(dirs) == 0 && len(files) == 0 {
		return ""
	}
	var parts []string
	if len(dirs) > 0 {
		parts = append(parts, "dirs: "+strings.Join(dirs, ", "))
	}
	if len(files) > 0 {
		parts = append(parts, "files: "+strings.Join(files, ", "))
	}
	return fmt.Sprintf("%s (%s)", label, strings.Join(parts, "; "))
}

// overviewDoc looks for the first file on overviewFiles that exists and
// returns its (possibly truncated) content plus the path we found it at.
// Returns empty strings if nothing matches.
func overviewDoc(r *repo.Entry) (content, label string) {
	for _, candidate := range overviewFiles {
		resp, err := r.GetFile("", candidate, maxBaselineContextBytes)
		if err != nil || resp.IsBinary || len(resp.Content) == 0 {
			continue
		}
		note := ""
		if resp.Truncated {
			note = "\n\n…[truncated]"
		}
		return string(resp.Content) + note, candidate
	}
	return "", ""
}

// resolveMentions finds @file references in text, fetches matching blobs
// from the repo at HEAD, and returns a formatted block suitable for
// appending to the system prompt.
//
// Crucially, unresolvable mentions are NOT silently dropped — they are
// emitted as explicit "does not exist" notes so the model can tell the
// user that their @-mention missed. When the miss is close to a real
// path (via Levenshtein distance on the whole path), we also inject
// "did you mean …?" hints so the model can propose corrections
// instead of asking the user to re-send blindly.
func (s *Service) resolveMentions(ctx context.Context, r *repo.Entry, text string) string {
	matches := filePattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return ""
	}
	seen := map[string]struct{}{}
	var blocks []string
	total := 0
	// Lazy: only walk the full file list if at least one @-mention
	// misses. For the common all-hit case, this stays zero cost.
	var allPaths []string
	var allPathsErr error
	var allPathsLoaded bool
	loadAllPaths := func() []string {
		if !allPathsLoaded {
			allPaths, allPathsErr = r.AllFilePaths()
			allPathsLoaded = true
		}
		if allPathsErr != nil {
			return nil
		}
		return allPaths
	}

	for _, m := range matches {
		path := strings.TrimSuffix(m[1], "/")
		if _, dup := seen[path]; dup {
			continue
		}
		seen[path] = struct{}{}
		resp, err := r.GetFile("", path, maxInjectedFileBytes)
		if err != nil {
			// Negative result with fuzzy suggestions.
			hint := ""
			if suggestions := suggestPaths(path, loadAllPaths()); len(suggestions) > 0 {
				hint = " Did you mean: " + strings.Join(
					backtickEach(suggestions), ", ",
				) + "?"
			}
			blocks = append(blocks, fmt.Sprintf(
				"File: `%s` — NOT FOUND in the repository at HEAD.%s "+
					"Tell the user this path does not exist. If a suggestion "+
					"is offered above, propose it to them — do NOT ask them "+
					"to re-send the same @-mention.",
				path, hint,
			))
			continue
		}
		if resp.IsBinary {
			blocks = append(blocks, fmt.Sprintf(
				"File: `%s` — binary file, contents not shown.",
				path,
			))
			continue
		}
		body := string(resp.Content)
		if int64(total+len(body)) > maxTotalInjectedBytes {
			blocks = append(blocks, fmt.Sprintf(
				"File: `%s` — skipped: per-turn file injection budget exhausted.",
				path,
			))
			break
		}
		total += len(body)
		truncNote := ""
		if resp.Truncated {
			truncNote = " (truncated)"
		}
		blocks = append(blocks, fmt.Sprintf("File: `%s`%s\n```\n%s\n```", path, truncNote, body))
	}
	_ = ctx
	return strings.Join(blocks, "\n\n")
}

// suggestPaths ranks `all` by Levenshtein distance from `missing` and
// returns up to 3 closest candidates whose distance is within a
// reasonable threshold. A typo distance <= 3 is always kept; longer
// distances only count if they're under a third of the missing path's
// length (to catch near-hits on long paths). An empty result means no
// candidate was close enough to be worth mentioning.
func suggestPaths(missing string, all []string) []string {
	if len(all) == 0 || missing == "" {
		return nil
	}
	type scored struct {
		path string
		dist int
	}
	var ranked []scored
	threshold := 3
	if lenBased := len(missing) / 3; lenBased > threshold {
		threshold = lenBased
	}
	for _, p := range all {
		d := levenshtein(missing, p)
		if d <= threshold {
			ranked = append(ranked, scored{p, d})
		}
	}
	if len(ranked) == 0 {
		return nil
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].dist < ranked[j].dist })
	if len(ranked) > 3 {
		ranked = ranked[:3]
	}
	out := make([]string, len(ranked))
	for i, r := range ranked {
		out[i] = r.path
	}
	return out
}

// levenshtein is the classic edit-distance algorithm, two-row variant
// to keep allocations flat. Good enough for ~100-1000 file lists; we
// call it on the slow path only (when an @-mention has already missed).
func levenshtein(a, b string) int {
	if a == b {
		return 0
	}
	la, lb := len(a), len(b)
	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}
	prev := make([]int, lb+1)
	curr := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = min(
				prev[j]+1,      // deletion
				curr[j-1]+1,    // insertion
				prev[j-1]+cost, // substitution
			)
		}
		prev, curr = curr, prev
	}
	return prev[lb]
}

// backtickEach wraps each string in backticks for markdown emphasis.
func backtickEach(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = "`" + s + "`"
	}
	return out
}
