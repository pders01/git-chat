// Package tools owns the read-only tool catalog that the chat service
// exposes to the LLM for agentic multi-turn reasoning. Every tool is
// scoped to a single repo.Entry, takes structured JSON arguments, and
// returns a text result with hard per-tool output caps so a runaway
// model cannot blow the prompt budget.
//
// Tools live here (not in internal/chat) so the catalog is easy to
// test in isolation and so the LLM-adapter glue in internal/chat can
// import it without pulling in the whole service graph.
package tools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/repo"
)


// ErrUnknownTool is returned when the model emits a tool_use for a
// name that is not in the registry. The service surfaces this as a
// tool_result with isError=true so the model can recover rather than
// hanging the stream.
var ErrUnknownTool = errors.New("tools: unknown tool")

// Spec describes one tool for the LLM: its name, a short description,
// and the JSON Schema for its arguments. The schema is a free-form
// json.RawMessage so adapters can hand it straight to the provider
// (Anthropic and OpenAI both want draft-07-ish schemas verbatim).
type Spec struct {
	Name        string
	Description string
	InputSchema json.RawMessage
}

// Handler executes a single tool invocation and returns the text
// result the model will see. Handlers must respect the output cap
// documented on their Spec so no single call dominates the prompt.
type Handler func(ctx context.Context, entry *repo.Entry, args json.RawMessage) (string, error)

// Registry pairs Specs with Handlers. All tools in the registry are
// exposed to the LLM on every SendMessage call; visibility is not
// request-scoped in v1.
type Registry struct {
	specs    []Spec
	handlers map[string]Handler
}

// Default returns the production registry. Callers should not mutate
// the returned registry — it is safe to share across goroutines.
func Default() *Registry {
	r := &Registry{handlers: map[string]Handler{}}
	r.Register(readFileSpec, handleReadFile)
	r.Register(listTreeSpec, handleListTree)
	r.Register(searchPathsSpec, handleSearchPaths)
	r.Register(searchCodeSpec, handleSearchCode)
	r.Register(outlineSpec, handleOutline)
	r.Register(getDiffSpec, handleGetDiff)
	r.Register(listBranchesSpec, handleListBranches)
	r.Register(getBlameSpec, handleGetBlame)
	return r
}

// Register adds a new tool to the registry. Duplicate names overwrite
// silently; callers are expected to wire registration once at
// construction time.
func (r *Registry) Register(s Spec, h Handler) {
	r.specs = append(r.specs, s)
	r.handlers[s.Name] = h
}

// Specs returns the list of declared tool specs in registration order.
func (r *Registry) Specs() []Spec {
	return r.specs
}

// Execute dispatches a tool call. On an unknown name it returns
// ErrUnknownTool; handler errors flow through unchanged so callers can
// distinguish "tool failed" from "tool does not exist".
func (r *Registry) Execute(ctx context.Context, entry *repo.Entry, name string, args json.RawMessage) (string, error) {
	h, ok := r.handlers[name]
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
	return h(ctx, entry, args)
}

// ── Caps ────────────────────────────────────────────────────────────
// Per-tool caps on bytes / entries / matches. Tuned conservatively —
// the model can always call a tool again with a narrower scope if it
// needs more. Better to force several pinpoint calls than to hand
// back a megabyte of context that drowns out subsequent reasoning.
const (
	readFileMaxBytes   = 64 * 1024
	listTreeMaxEntries = 200
	searchPathsMaxHits = 50
	searchCodeMaxHits  = 80
	searchCodeMaxBytes = 32 * 1024
	outlineMaxEntries  = 200
	outlineMaxBytes    = 32 * 1024
	getDiffMaxBytes    = 32 * 1024
)

// ── read_file ───────────────────────────────────────────────────────

var readFileSpec = Spec{
	Name: "read_file",
	Description: "Return the contents of a file in the repository at " +
		"a given ref. Binary files return a placeholder. Results are " +
		"capped at 64KB — ask for a specific subpath or call again " +
		"for more.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "Repository-relative file path, e.g. internal/auth/service.go"},
			"ref":  {"type": "string", "description": "Optional git ref (branch, tag, SHA). Defaults to HEAD."}
		},
		"required": ["path"]
	}`),
}

type readFileArgs struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
}

func handleReadFile(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args readFileArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("read_file: %w", err)
	}
	if args.Path == "" {
		return "", errors.New("read_file: path is required")
	}
	resp, err := entry.GetFile(args.Ref, args.Path, readFileMaxBytes)
	if err != nil {
		return "", err
	}
	if resp.IsBinary {
		return fmt.Sprintf("(binary file %q, %d bytes, blob %s)",
			args.Path, resp.Size, resp.BlobSha), nil
	}
	body := string(resp.Content)
	if resp.Truncated {
		body += fmt.Sprintf("\n… (truncated, full file is %d bytes)", resp.Size)
	}
	return body, nil
}

// ── list_tree ───────────────────────────────────────────────────────

var listTreeSpec = Spec{
	Name: "list_tree",
	Description: "List the direct children of a directory in the " +
		"repository. Pass an empty path for the repo root.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "Repository-relative directory path. Empty = repo root."},
			"ref":  {"type": "string", "description": "Optional git ref. Defaults to HEAD."}
		}
	}`),
}

type listTreeArgs struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
}

func handleListTree(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args listTreeArgs
	if raw != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", fmt.Errorf("list_tree: %w", err)
		}
	}
	entries, _, err := entry.ListTree(args.Ref, args.Path)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return fmt.Sprintf("(empty directory %q)", args.Path), nil
	}
	truncated := false
	if len(entries) > listTreeMaxEntries {
		entries = entries[:listTreeMaxEntries]
		truncated = true
	}
	var sb strings.Builder
	for _, e := range entries {
		suffix := ""
		if e.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR {
			suffix = "/"
		}
		sb.WriteString(e.Name)
		sb.WriteString(suffix)
		sb.WriteString("\n")
	}
	if truncated {
		fmt.Fprintf(&sb, "… (showing first %d entries)\n", listTreeMaxEntries)
	}
	return sb.String(), nil
}

// ── search_paths ────────────────────────────────────────────────────

var searchPathsSpec = Spec{
	Name: "search_paths",
	Description: "Find file paths in the repository whose name or " +
		"path contains the query substring (case-insensitive). " +
		"Returns up to 50 matches — refine the query for more precision.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"query": {"type": "string", "description": "Substring to match, case-insensitive."}
		},
		"required": ["query"]
	}`),
}

type searchPathsArgs struct {
	Query string `json:"query"`
}

func handleSearchPaths(_ context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args searchPathsArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("search_paths: %w", err)
	}
	if args.Query == "" {
		return "", errors.New("search_paths: query is required")
	}
	paths, err := entry.AllFilePaths()
	if err != nil {
		return "", err
	}
	q := strings.ToLower(args.Query)
	matches := make([]string, 0, 64)
	for _, p := range paths {
		if strings.Contains(strings.ToLower(p), q) {
			matches = append(matches, p)
			if len(matches) >= searchPathsMaxHits+1 {
				break
			}
		}
	}
	if len(matches) == 0 {
		return fmt.Sprintf("(no files matching %q)", args.Query), nil
	}
	truncated := false
	if len(matches) > searchPathsMaxHits {
		matches = matches[:searchPathsMaxHits]
		truncated = true
	}
	sort.Strings(matches)
	var sb strings.Builder
	for _, m := range matches {
		sb.WriteString(m)
		sb.WriteString("\n")
	}
	if truncated {
		fmt.Fprintf(&sb, "… (showing first %d matches — narrow the query)\n", searchPathsMaxHits)
	}
	return sb.String(), nil
}

// ── get_diff ────────────────────────────────────────────────────────

var getDiffSpec = Spec{
	Name: "get_diff",
	Description: "Return a unified diff between two refs. Omit `from` " +
		"to diff against the parent of `to`; omit `to` for HEAD. Pass " +
		"`path` to scope to a single file or directory prefix. Result " +
		"is capped at 32KB.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"from": {"type": "string", "description": "Base ref. Default: parent of to."},
			"to":   {"type": "string", "description": "Target ref. Default: HEAD."},
			"path": {"type": "string", "description": "Optional file or directory to scope the diff to."}
		}
	}`),
}

type getDiffArgs struct {
	From string `json:"from"`
	To   string `json:"to"`
	Path string `json:"path"`
}

func handleGetDiff(ctx context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args getDiffArgs
	if raw != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return "", fmt.Errorf("get_diff: %w", err)
		}
	}
	diff, _, _, empty, _, err := entry.GetDiff(ctx, args.From, args.To, args.Path, false)
	if err != nil {
		return "", err
	}
	if empty {
		return fmt.Sprintf("(no changes between %q and %q at %q)",
			firstNonEmpty(args.From, "parent"), firstNonEmpty(args.To, "HEAD"),
			firstNonEmpty(args.Path, "whole repo")), nil
	}
	if len(diff) > getDiffMaxBytes {
		return diff[:getDiffMaxBytes] + "\n… (diff truncated — narrow by path or range)", nil
	}
	return diff, nil
}

// ── search_code ─────────────────────────────────────────────────────

var searchCodeSpec = Spec{
	Name: "search_code",
	Description: "Search file CONTENTS across the repository using " +
		"ripgrep with PCRE2. Query is always a regex — metacharacters " +
		"(. * + ? | ( ) [ ] { }) have their usual meaning. To match a " +
		"literal string that contains those characters, either escape " +
		"them with backslash or pass literal=true. Scope with path " +
		"(directory prefix) or glob (e.g. '**/*.go', '!**/*_test.go'). " +
		"Returns up to 80 matches as path:line:text; narrow the " +
		"query if results truncate.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"query":          {"type": "string", "description": "PCRE2 regex pattern. Metacharacters are active unless escaped or literal=true."},
			"path":           {"type": "string", "description": "Optional directory prefix to scope the search."},
			"glob":           {"type": "string", "description": "Optional glob filter, e.g. '**/*.go' or '!**/*_test.go'."},
			"literal":        {"type": "boolean", "description": "Treat query as a literal fixed string (disables regex). Default false."},
			"case_sensitive": {"type": "boolean", "description": "Match case. Default false (smart-case)."}
		},
		"required": ["query"]
	}`),
}

type searchCodeArgs struct {
	Query         string `json:"query"`
	Path          string `json:"path"`
	Glob          string `json:"glob"`
	Literal       bool   `json:"literal"`
	CaseSensitive bool   `json:"case_sensitive"`
}

func handleSearchCode(ctx context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args searchCodeArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("search_code: %w", err)
	}
	if args.Query == "" {
		return "", errors.New("search_code: query is required")
	}
	if _, err := exec.LookPath("rg"); err != nil {
		return "", errors.New("search_code: ripgrep (rg) not installed on this host")
	}
	cli := []string{
		"--no-heading",
		"--line-number",
		"--color=never",
		"--max-columns=240",
		"--max-count=" + fmt.Sprintf("%d", searchCodeMaxHits),
		"--pcre2",
	}
	if args.Literal {
		cli = append(cli, "--fixed-strings")
	}
	if args.CaseSensitive {
		cli = append(cli, "--case-sensitive")
	} else {
		cli = append(cli, "--smart-case")
	}
	if args.Glob != "" {
		cli = append(cli, "--glob", args.Glob)
	}
	cli = append(cli, "--", args.Query)
	scope := "."
	if args.Path != "" {
		clean, err := repo.SafePath(args.Path)
		if err != nil {
			return "", fmt.Errorf("search_code: %w", err)
		}
		scope = clean
	}
	cli = append(cli, scope)

	cmd := exec.CommandContext(ctx, "rg", cli...)
	cmd.Dir = entry.Path
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	// rg exits 1 when no matches, 2+ on error. Treat 1 as empty
	// result rather than a failure.
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return fmt.Sprintf("(no matches for %q)", args.Query), nil
		}
		return "", fmt.Errorf("search_code: rg failed: %s", strings.TrimSpace(stderr.String()))
	}

	// Cap total output bytes so one chatty file doesn't drown the
	// prompt budget. Count lines for the trailing summary too.
	var out strings.Builder
	lines := 0
	truncatedBytes := false
	sc := bufio.NewScanner(&stdout)
	sc.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if out.Len()+len(line)+1 > searchCodeMaxBytes {
			truncatedBytes = true
			break
		}
		out.WriteString(line)
		out.WriteByte('\n')
		lines++
	}
	if lines == 0 {
		return fmt.Sprintf("(no matches for %q)", args.Query), nil
	}
	if truncatedBytes {
		fmt.Fprintf(&out, "… (output capped at %d bytes — narrow the search)\n", searchCodeMaxBytes)
	} else if lines >= searchCodeMaxHits {
		fmt.Fprintf(&out, "… (stopped at %d matches — narrow the search)\n", searchCodeMaxHits)
	}
	return out.String(), nil
}

// ── outline ─────────────────────────────────────────────────────────

var outlineSpec = Spec{
	Name: "outline",
	Description: "List the top-level symbols (functions, types, " +
		"classes, interfaces) in a file or directory using " +
		"universal-ctags. Much cheaper than read_file when you only " +
		"need to orient yourself. Accepts either a single file path " +
		"or a directory; directories recurse. Returns up to 200 " +
		"entries as `line  kind  scope.name`.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "File or directory, repo-relative. Dirs recurse."}
		},
		"required": ["path"]
	}`),
}

type outlineArgs struct {
	Path string `json:"path"`
}

// ctagsTag mirrors the JSON lines universal-ctags produces with
// --output-format=json. Only the fields we render are parsed.
type ctagsTag struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Kind      string `json:"kind"`
	Scope     string `json:"scope"`
	ScopeKind string `json:"scopeKind"`
}

func handleOutline(ctx context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args outlineArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("outline: %w", err)
	}
	if args.Path == "" {
		return "", errors.New("outline: path is required")
	}
	clean, err := repo.SafePath(args.Path)
	if err != nil {
		return "", fmt.Errorf("outline: %w", err)
	}
	if _, err := exec.LookPath("ctags"); err != nil {
		return "", errors.New("outline: ctags not installed (install universal-ctags)")
	}
	cli := []string{
		"--output-format=json",
		"--fields=+nKs",
		"--extras=",
		"--sort=no",
		"-R",
		"--languages=Go,TypeScript,JavaScript,Python,Rust,C,C++,Java,Ruby",
		"-f", "-",
		clean,
	}
	cmd := exec.CommandContext(ctx, "ctags", cli...)
	cmd.Dir = entry.Path
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("outline: ctags failed: %s", strings.TrimSpace(stderr.String()))
	}

	// Bucket tags by file so long directory outlines stay readable.
	type entryLine struct {
		line  int
		kind  string
		label string
	}
	byFile := map[string][]entryLine{}
	fileOrder := []string{}
	total := 0
	truncated := false
	sc := bufio.NewScanner(&stdout)
	sc.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for sc.Scan() {
		if total >= outlineMaxEntries {
			truncated = true
			break
		}
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var t ctagsTag
		if err := json.Unmarshal(line, &t); err != nil {
			continue
		}
		if !isInterestingKind(t.Kind) {
			continue
		}
		label := t.Name
		if t.Scope != "" {
			label = t.Scope + "." + t.Name
		}
		if _, ok := byFile[t.Path]; !ok {
			fileOrder = append(fileOrder, t.Path)
		}
		byFile[t.Path] = append(byFile[t.Path], entryLine{
			line: t.Line, kind: t.Kind, label: label,
		})
		total++
	}
	if total == 0 {
		return fmt.Sprintf("(no symbols found in %q)", args.Path), nil
	}

	var out strings.Builder
	for _, f := range fileOrder {
		if out.Len() > outlineMaxBytes {
			truncated = true
			break
		}
		fmt.Fprintf(&out, "── %s\n", f)
		rows := byFile[f]
		sort.Slice(rows, func(i, j int) bool { return rows[i].line < rows[j].line })
		for _, r := range rows {
			fmt.Fprintf(&out, "  %4d  %-10s  %s\n", r.line, r.kind, r.label)
		}
	}
	if truncated {
		fmt.Fprintf(&out, "… (output capped — narrow the path)\n")
	}
	return out.String(), nil
}

// isInterestingKind drops noisy ctags kinds (local vars, parameters,
// struct fields, imports) that blow up large files without adding
// navigational value. Keep funcs, methods, types, structs, classes,
// interfaces, enums, constants, global variables.
func isInterestingKind(k string) bool {
	switch k {
	case "function", "func", "method", "procedure",
		"type", "struct", "interface", "class", "enum", "enumerator",
		"constant", "const", "variable", "var",
		"module", "namespace", "trait":
		return true
	}
	return false
}

// ── list_branches ──────────────────────────────────────────────────

var listBranchesSpec = Spec{
	Name:        "list_branches",
	Description: "List local git branches sorted by most recent commit. Returns branch name, short SHA, and subject.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {}
	}`),
}

func handleListBranches(ctx context.Context, entry *repo.Entry, _ json.RawMessage) (string, error) {
	branches, err := entry.ListBranches(ctx)
	if err != nil {
		return "", fmt.Errorf("list_branches: %w", err)
	}
	if len(branches) == 0 {
		return "(no branches)", nil
	}
	var sb strings.Builder
	for _, b := range branches {
		fmt.Fprintf(&sb, "%s %s %s\n", b.Name, repo.ShortSHA(b.Commit), b.Subject)
	}
	return sb.String(), nil
}

// ── get_blame ──────────────────────────────────────────────────────

const blameMaxBytes = 64 * 1024

var getBlameSpec = Spec{
	Name: "get_blame",
	Description: "Get per-line blame annotation for a file. Shows commit SHA, " +
		"author, and line content. Useful for understanding who changed what.",
	InputSchema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"path": {"type": "string", "description": "File path relative to repo root."},
			"ref":  {"type": "string", "description": "Git ref (branch, tag, SHA). Empty = HEAD."}
		},
		"required": ["path"]
	}`),
}

type getBlameArgs struct {
	Path string `json:"path"`
	Ref  string `json:"ref"`
}

func handleGetBlame(ctx context.Context, entry *repo.Entry, raw json.RawMessage) (string, error) {
	var args getBlameArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", fmt.Errorf("get_blame: %w", err)
	}
	if args.Path == "" {
		return "", errors.New("get_blame: path is required")
	}
	lines, err := entry.GetBlame(ctx, args.Ref, args.Path)
	if err != nil {
		return "", fmt.Errorf("get_blame: %w", err)
	}
	var sb strings.Builder
	for i, l := range lines {
		fmt.Fprintf(&sb, "%s %-16s %4d: %s\n",
			repo.ShortSHA(l.CommitSha), l.AuthorName, i+1, l.Text)
	}
	out := sb.String()
	if len(out) > blameMaxBytes {
		out = out[:blameMaxBytes] + "\n…(truncated)"
	}
	return out, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
