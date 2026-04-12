package repo

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// DefaultMaxFileBytes is used when GetFileRequest.max_bytes is zero.
var DefaultMaxFileBytes int64 = envInt64Reader("GITCHAT_DEFAULT_FILE_BYTES", 512*1024)

// Package-level tunables, configurable via environment variables.
var (
	maxWholeDiffBytes_  = envIntReader("GITCHAT_MAX_DIFF_BYTES", 32*1024)
	defaultCommitLimit  = envIntReader("GITCHAT_DEFAULT_COMMIT_LIMIT", 50)
	diffContextLines    = envIntReader("GITCHAT_DIFF_CONTEXT_LINES", 3)
)

// ListBranches returns local branches sorted by committer time, newest first.
func (e *Entry) ListBranches() ([]*gitchatv1.Branch, error) {
	iter, err := e.repo.Branches()
	if err != nil {
		return nil, fmt.Errorf("iterate branches: %w", err)
	}
	var out []*gitchatv1.Branch
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		commit, err := e.repo.CommitObject(ref.Hash())
		if err != nil {
			// Skip branches whose commit is missing rather than failing
			// the whole list (happens on broken refs in pathological repos).
			return nil
		}
		out = append(out, &gitchatv1.Branch{
			Name:          ref.Name().Short(),
			Commit:        ref.Hash().String(),
			CommitterTime: commit.Committer.When.Unix(),
			Subject:       firstLine(commit.Message),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CommitterTime > out[j].CommitterTime
	})
	return out, nil
}

// ListTree returns entries at a path under a given ref. Empty path lists
// the repository root. Empty ref uses the default branch.
func (e *Entry) ListTree(ref, path string) ([]*gitchatv1.TreeEntry, string, error) {
	commit, resolved, err := e.resolveCommit(ref)
	if err != nil {
		return nil, "", err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, "", fmt.Errorf("get tree: %w", err)
	}

	var target *object.Tree
	if path == "" || path == "." || path == "/" {
		target = tree
	} else {
		sub, err := tree.Tree(path)
		if err != nil {
			if errors.Is(err, object.ErrDirectoryNotFound) {
				return nil, "", ErrNotFound
			}
			return nil, "", fmt.Errorf("locate %q: %w", path, err)
		}
		target = sub
	}

	out := make([]*gitchatv1.TreeEntry, 0, len(target.Entries))
	for _, entry := range target.Entries {
		te := &gitchatv1.TreeEntry{
			Name:    entry.Name,
			Type:    entryType(entry.Mode),
			BlobSha: entry.Hash.String(),
		}
		if te.Type == gitchatv1.EntryType_ENTRY_TYPE_FILE {
			// Size is only cheaply available for blobs; fetch it from the
			// object store. On failure we leave Size=0.
			if blob, err := e.repo.BlobObject(entry.Hash); err == nil {
				te.Size = blob.Size
			}
		}
		out = append(out, te)
	}

	sort.Slice(out, func(i, j int) bool {
		// Directories first, then files, alphabetical within each group.
		ai, bi := out[i], out[j]
		if (ai.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR) != (bi.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR) {
			return ai.Type == gitchatv1.EntryType_ENTRY_TYPE_DIR
		}
		return ai.Name < bi.Name
	})
	return out, resolved, nil
}

// AllFilePaths returns every blob path at HEAD, sorted. Used by the
// chat prompt's "did you mean …?" hint when a user's @-mention misses.
// Not indexed — callers should only invoke this on the slow path (when
// there's already a miss to explain).
func (e *Entry) AllFilePaths() ([]string, error) {
	commit, _, err := e.resolveCommit("")
	if err != nil {
		return nil, err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, fmt.Errorf("get tree: %w", err)
	}
	iter := tree.Files()
	var out []string
	err = iter.ForEach(func(f *object.File) error {
		out = append(out, f.Name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// GetFile returns the blob contents at path under ref.
func (e *Entry) GetFile(ref, path string, maxBytes int64) (*gitchatv1.GetFileResponse, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxFileBytes
	}
	commit, _, err := e.resolveCommit(ref)
	if err != nil {
		return nil, err
	}
	tree, err := commit.Tree()
	if err != nil {
		return nil, fmt.Errorf("get tree: %w", err)
	}
	file, err := tree.File(path)
	if err != nil {
		if errors.Is(err, object.ErrFileNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("find file: %w", err)
	}

	reader, err := file.Reader()
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	defer reader.Close()

	buf := make([]byte, maxBytes+1)
	n, err := io.ReadFull(reader, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("read blob: %w", err)
	}
	content := buf[:min64(int64(n), maxBytes)]
	truncated := int64(n) > maxBytes || file.Size > maxBytes

	return &gitchatv1.GetFileResponse{
		Content:   append([]byte(nil), content...), // defensive copy
		Size:      file.Size,
		Truncated: truncated,
		IsBinary:  isBinary(content),
		BlobSha:   file.Hash.String(),
		Language:  LanguageForPath(path),
	}, nil
}

// maxWholeDiffBytes caps the total size of a whole-commit diff. Large
// commits get truncated with a "(N more files truncated)" notice so
// the LLM can still reason about the start of the patch without
// blowing its context window. Configured via GITCHAT_MAX_DIFF_BYTES.

// ListCommits returns the most recent commits on a ref, newest first.
// Includes diff stats (files changed, additions, deletions) per commit.
func (e *Entry) ListCommits(ref string, limit, offset int) ([]*gitchatv1.CommitEntry, bool, error) {
	if limit <= 0 {
		limit = defaultCommitLimit
	}
	commit, _, err := e.resolveCommit(ref)
	if err != nil {
		return nil, false, err
	}

	// Walk the commit history.
	iter := object.NewCommitIterCTime(commit, nil, nil)
	defer iter.Close()

	// Skip `offset` commits.
	for i := 0; i < offset; i++ {
		if _, err := iter.Next(); err != nil {
			return nil, false, nil // past the end
		}
	}

	var out []*gitchatv1.CommitEntry
	for i := 0; i < limit+1; i++ {
		c, err := iter.Next()
		if err != nil {
			break
		}
		if i == limit {
			// One extra to detect has_more.
			return out, true, nil
		}
		entry := &gitchatv1.CommitEntry{
			Sha:         c.Hash.String(),
			ShortSha:    c.Hash.String()[:7],
			Message:     firstLine(c.Message),
			Body:        commitBody(c.Message),
			AuthorName:  c.Author.Name,
			AuthorEmail: c.Author.Email,
			AuthorTime:  c.Author.When.Unix(),
		}
		// Diff stats — compare against first parent (root commits
		// show as all-additions).
		if stats := commitDiffStats(c); stats != nil {
			entry.FilesChanged = int32(stats.files)
			entry.Additions = int32(stats.additions)
			entry.Deletions = int32(stats.deletions)
		}
		out = append(out, entry)
	}
	return out, false, nil
}

type diffStats struct {
	files, additions, deletions int
}

func commitDiffStats(c *object.Commit) *diffStats {
	cTree, err := c.Tree()
	if err != nil {
		return nil
	}
	var pTree *object.Tree
	if c.NumParents() > 0 {
		parent, err := c.Parents().Next()
		if err == nil {
			pTree, _ = parent.Tree()
		}
	}
	if pTree == nil {
		// Root commit: count files and estimate lines from size to avoid
		// reading entire blob contents for every file.
		var files, lines int
		cTree.Files().ForEach(func(f *object.File) error {
			files++
			lines += int(f.Size) / 40 // rough estimate: ~40 bytes/line
			return nil
		})
		return &diffStats{files: files, additions: lines}
	}
	changes, err := pTree.Diff(cTree)
	if err != nil {
		return nil
	}
	patch, err := changes.Patch()
	if err != nil {
		return nil
	}
	stats := patch.Stats()
	s := &diffStats{files: len(stats)}
	for _, st := range stats {
		s.additions += st.Addition
		s.deletions += st.Deletion
	}
	return s
}

// CompareBranches returns the files changed between two refs with
// per-file add/delete stats.
func (e *Entry) CompareBranches(baseRef, headRef string) ([]*gitchatv1.ChangedFile, int32, int32, error) {
	baseCommit, _, err := e.resolveCommit(baseRef)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("resolve base: %w", err)
	}
	headCommit, _, err := e.resolveCommit(headRef)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("resolve head: %w", err)
	}
	baseTree, err := baseCommit.Tree()
	if err != nil {
		return nil, 0, 0, err
	}
	headTree, err := headCommit.Tree()
	if err != nil {
		return nil, 0, 0, err
	}
	changes, err := baseTree.Diff(headTree)
	if err != nil {
		return nil, 0, 0, err
	}
	patch, err := changes.Patch()
	if err != nil {
		return nil, 0, 0, err
	}
	stats := patch.Stats()
	var totalAdd, totalDel int32
	out := make([]*gitchatv1.ChangedFile, 0, len(stats))
	for _, s := range stats {
		status := "modified"
		// Detect add/delete from the change set.
		for _, c := range changes {
			name := c.To.Name
			if name == "" {
				name = c.From.Name
			}
			if name == s.Name {
				if c.From.Name == "" {
					status = "added"
				} else if c.To.Name == "" {
					status = "deleted"
				} else if c.From.Name != c.To.Name {
					status = "renamed"
				}
				break
			}
		}
		out = append(out, &gitchatv1.ChangedFile{
			Path:      s.Name,
			Status:    status,
			Additions: int32(s.Addition),
			Deletions: int32(s.Deletion),
		})
		totalAdd += int32(s.Addition)
		totalDel += int32(s.Deletion)
	}
	return out, totalAdd, totalDel, nil
}

// GetBlame returns per-line author attribution for a file.
func (e *Entry) GetBlame(ref, path string) ([]*gitchatv1.BlameLine, error) {
	commit, _, err := e.resolveCommit(ref)
	if err != nil {
		return nil, err
	}
	result, err := git.Blame(commit, path)
	if err != nil {
		return nil, fmt.Errorf("blame %q: %w", path, err)
	}
	// Cache commit messages by hash to avoid repeated lookups.
	msgCache := map[string]string{}
	out := make([]*gitchatv1.BlameLine, 0, len(result.Lines))
	for _, l := range result.Lines {
		shortSHA := l.Hash.String()[:7]
		msg, ok := msgCache[shortSHA]
		if !ok {
			if c, err := e.repo.CommitObject(l.Hash); err == nil {
				msg = strings.TrimSpace(c.Message)
			}
			msgCache[shortSHA] = msg
		}
		out = append(out, &gitchatv1.BlameLine{
			Text:          l.Text,
			AuthorName:    l.AuthorName,
			AuthorEmail:   l.Author,
			Date:          l.Date.Unix(),
			CommitSha:     shortSHA,
			CommitMessage: msg,
		})
	}
	return out, nil
}

// GetDiff returns a unified-diff patch for either a single file or an
// entire commit range, depending on whether `path` is provided.
//
//   - path != "":  patch for just that file between fromRef and toRef.
//   - path == "":  patch for every file changed between fromRef and
//     toRef, concatenated into one multi-file unified diff, capped at
//     maxWholeDiffBytes_ with a truncation note.
//
// Empty fromRef defaults to the parent of toRef (i.e. "what did this
// commit do"); empty toRef defaults to HEAD. Returns empty=true if
// nothing changed between the two commits for the scope requested.
func (e *Entry) GetDiff(fromRef, toRef, path string) (diff, fromSHA, toSHA string, empty bool, files []*gitchatv1.ChangedFile, err error) {
	// Resolve to-side first so we can default fromRef to its parent.
	toCommit, toResolved, err := e.resolveCommit(toRef)
	if err != nil {
		return "", "", "", false, nil, err
	}

	var fromCommit *object.Commit
	var fromResolved string
	if fromRef == "" {
		// Default: diff against first parent. Root commits have no
		// parent — treat the "from" side as empty (everything is new).
		if toCommit.NumParents() > 0 {
			parent, perr := toCommit.Parents().Next()
			if perr != nil {
				return "", "", "", false, nil, fmt.Errorf("get parent: %w", perr)
			}
			fromCommit = parent
			fromResolved = parent.Hash.String()
		}
	} else {
		fc, resolved, rerr := e.resolveCommit(fromRef)
		if rerr != nil {
			return "", "", "", false, nil, rerr
		}
		fromCommit = fc
		fromResolved = resolved
	}

	// ── Single-file path ───────────────────────────────────────────
	if path != "" {
		fromContent, fromErr := fileContent(fromCommit, path)
		toContent, toErr := fileContent(toCommit, path)
		if fromErr != nil && toErr != nil {
			return "", fromResolved, toResolved, false, nil, ErrNotFound
		}
		if fromContent == toContent {
			return "", fromResolved, toResolved, true, nil, nil
		}
		patch := renderUnifiedDiff(path, fromResolved, toResolved, fromContent, toContent)
		return patch, fromResolved, toResolved, false, nil, nil
	}

	// ── Whole-commit path ──────────────────────────────────────────
	// Enumerate every path touched between from and to, compute each
	// file's single-file patch, and concatenate. Sort for determinism.
	// Also builds per-file metadata in a single tree-diff pass.
	changed, files, err := changedPathsWithFiles(fromCommit, toCommit)
	if err != nil {
		return "", fromResolved, toResolved, false, nil, err
	}
	if len(changed) == 0 {
		return "", fromResolved, toResolved, true, nil, nil
	}

	var sb bytes.Buffer
	truncated := 0
	for i, p := range changed {
		fromContent, _ := fileContent(fromCommit, p)
		toContent, _ := fileContent(toCommit, p)
		if fromContent == toContent {
			continue
		}
		filePatch := renderUnifiedDiff(p, fromResolved, toResolved, fromContent, toContent)
		if sb.Len()+len(filePatch) > maxWholeDiffBytes_ {
			truncated = len(changed) - i
			break
		}
		sb.WriteString(filePatch)
	}
	if truncated > 0 {
		fmt.Fprintf(&sb, "\n… (%d more file(s) truncated)\n", truncated)
	}
	if sb.Len() == 0 {
		return "", fromResolved, toResolved, true, files, nil
	}
	return sb.String(), fromResolved, toResolved, false, files, nil
}

// changedPathsWithFiles returns sorted changed paths AND per-file metadata
// in a single tree-diff pass, avoiding the double diff that changedPaths +
// a separate buildChangedFiles would incur.
func changedPathsWithFiles(from, to *object.Commit) ([]string, []*gitchatv1.ChangedFile, error) {
	toTree, err := to.Tree()
	if err != nil {
		return nil, nil, fmt.Errorf("to tree: %w", err)
	}
	if from == nil {
		// Root commit — every file is new. No patch stats available
		// without materialising the full patch, so skip per-file stats.
		var paths []string
		err := toTree.Files().ForEach(func(f *object.File) error {
			paths = append(paths, f.Name)
			return nil
		})
		if err != nil {
			return nil, nil, err
		}
		sort.Strings(paths)
		// Build files without stats (status = "added", counts = 0).
		files := make([]*gitchatv1.ChangedFile, len(paths))
		for i, p := range paths {
			files[i] = &gitchatv1.ChangedFile{Path: p, Status: "added"}
		}
		return paths, files, nil
	}

	fromTree, err := from.Tree()
	if err != nil {
		return nil, nil, fmt.Errorf("from tree: %w", err)
	}
	changes, err := fromTree.Diff(toTree)
	if err != nil {
		return nil, nil, fmt.Errorf("tree diff: %w", err)
	}

	// Extract sorted paths.
	seen := map[string]struct{}{}
	for _, c := range changes {
		name := c.To.Name
		if name == "" {
			name = c.From.Name
		}
		seen[name] = struct{}{}
	}
	paths := make([]string, 0, len(seen))
	for p := range seen {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	// Build per-file metadata from patch stats.
	patch, err := changes.Patch()
	if err != nil {
		// Paths are valid, stats are best-effort.
		return paths, nil, nil
	}
	stats := patch.Stats()
	files := make([]*gitchatv1.ChangedFile, 0, len(stats))
	for _, s := range stats {
		status := "modified"
		for _, c := range changes {
			name := c.To.Name
			if name == "" {
				name = c.From.Name
			}
			if name == s.Name {
				if c.From.Name == "" {
					status = "added"
				} else if c.To.Name == "" {
					status = "deleted"
				} else if c.From.Name != c.To.Name {
					status = "renamed"
				}
				break
			}
		}
		files = append(files, &gitchatv1.ChangedFile{
			Path:      s.Name,
			Status:    status,
			Additions: int32(s.Addition),
			Deletions: int32(s.Deletion),
		})
	}
	return paths, files, nil
}


// fileContent returns the contents of `path` at `commit`. Returns the
// empty string with no error if the path doesn't exist at that commit
// (treated as "not present" — the caller distinguishes from/to sides).
// Any other error (binary read failure, object store miss) is returned.
func fileContent(commit *object.Commit, path string) (string, error) {
	if commit == nil {
		return "", nil
	}
	tree, err := commit.Tree()
	if err != nil {
		return "", fmt.Errorf("get tree: %w", err)
	}
	f, err := tree.File(path)
	if err != nil {
		if errors.Is(err, object.ErrFileNotFound) {
			return "", nil
		}
		return "", fmt.Errorf("find file: %w", err)
	}
	// Skip oversized or binary files to avoid O(m×n) diff on huge blobs.
	if f.Size > int64(maxWholeDiffBytes_) {
		return "(file too large for inline diff)", nil
	}
	contents, err := f.Contents()
	if err != nil {
		return "", fmt.Errorf("read blob: %w", err)
	}
	if isBinary([]byte(contents[:min(len(contents), 8192)])) {
		return "(binary file)", nil
	}
	return contents, nil
}

// renderUnifiedDiff produces a `diff --git` style unified patch for a
// single file. Uses the stdlib-free unified diff builder via
// github.com/go-git/go-git's own patch machinery would require a full
// tree diff; for a single-file view we compute it directly from the
// two content strings with a line-level LCS. That's cheaper and gives
// us full control over the output format.
func renderUnifiedDiff(path, fromSHA, toSHA, fromContent, toContent string) string {
	fromLines := splitLinesKeepNL(fromContent)
	toLines := splitLinesKeepNL(toContent)
	hunks := diffHunks(fromLines, toLines)

	var sb bytes.Buffer
	// Header mimics git's shape so Shiki's diff grammar highlights it.
	fmt.Fprintf(&sb, "diff --git a/%s b/%s\n", path, path)
	if fromSHA != "" && toSHA != "" {
		fmt.Fprintf(&sb, "index %s..%s\n", shortSHA(fromSHA), shortSHA(toSHA))
	}
	if fromContent == "" {
		sb.WriteString("--- /dev/null\n")
	} else {
		fmt.Fprintf(&sb, "--- a/%s\n", path)
	}
	if toContent == "" {
		sb.WriteString("+++ /dev/null\n")
	} else {
		fmt.Fprintf(&sb, "+++ b/%s\n", path)
	}
	for _, h := range hunks {
		fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", h.fromStart, h.fromLen, h.toStart, h.toLen)
		for _, line := range h.lines {
			sb.WriteString(line)
		}
	}
	return sb.String()
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// splitLinesKeepNL splits s into lines, keeping trailing newlines so
// the diff output preserves line terminators. An input ending in "\n"
// produces N lines; an input without the trailing newline produces the
// final line without one (matching git's "\ No newline at end of file"
// behaviour, though we don't emit that marker here).
func splitLinesKeepNL(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i+1])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// diffHunk is one contiguous change block.
type diffHunk struct {
	fromStart, fromLen int
	toStart, toLen     int
	lines              []string // each prefixed with ' ', '-', or '+'
}

// diffHunks computes hunks from line arrays using a simple LCS-based
// diff. Good enough for file-pair diffing; not optimized for huge
// files. The file cap is already ~16 KiB via GetFile's max, so
// O(m*n) here is fine.
func diffHunks(a, b []string) []diffHunk {
	ops := lcsDiffOps(a, b)
	if len(ops) == 0 {
		return nil
	}

	// Group non-equal ops into hunks with context lines around.
	context := diffContextLines
	var hunks []diffHunk
	n := len(ops)
	i := 0
	for i < n {
		// Skip leading equals.
		for i < n && ops[i].kind == opEqual {
			i++
		}
		if i >= n {
			break
		}
		// Start of a change block. Back up for context.
		ctxStart := i - context
		if ctxStart < 0 {
			ctxStart = 0
		}
		// Find end of the change block: stretch through 2*context
		// equals (i.e. merge adjacent changes into one hunk).
		j := i
		for j < n {
			if ops[j].kind != opEqual {
				j++
				continue
			}
			// Count run of equals from j.
			k := j
			for k < n && ops[k].kind == opEqual {
				k++
			}
			runLen := k - j
			if runLen >= 2*context || k >= n {
				break
			}
			j = k
		}
		ctxEnd := j + context
		if ctxEnd > n {
			ctxEnd = n
		}
		// Don't extend forward past the file into more context than
		// we have equals for — recompute from the actual ops.
		actualEnd := j
		for actualEnd < ctxEnd && actualEnd < n && ops[actualEnd].kind == opEqual {
			actualEnd++
		}

		h := buildHunk(ops[ctxStart:actualEnd])
		hunks = append(hunks, h)
		i = actualEnd
	}
	return hunks
}

// diffOp kinds.
type diffOp struct {
	kind     int    // opEqual | opDel | opIns
	line     string // the line from a or b
	aIdx     int    // 1-based line number in a (0 for inserts)
	bIdx     int    // 1-based line number in b (0 for deletes)
}

const (
	opEqual = iota
	opDel
	opIns
)

// lcsDiffOps returns a sequence of ops (equal/del/ins) describing the
// transformation from a to b. Standard dynamic-programming LCS — O(m*n)
// space and time. Adequate for file-pair diffs up to ~10k lines.
func lcsDiffOps(a, b []string) []diffOp {
	m, n := len(a), len(b)
	// dp[i][j] = length of LCS of a[:i] and b[:j]
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			if a[i-1] == b[j-1] {
				dp[i][j] = dp[i-1][j-1] + 1
			} else if dp[i-1][j] >= dp[i][j-1] {
				dp[i][j] = dp[i-1][j]
			} else {
				dp[i][j] = dp[i][j-1]
			}
		}
	}
	// Walk back to produce ops in forward order.
	var ops []diffOp
	i, j := m, n
	for i > 0 || j > 0 {
		switch {
		case i > 0 && j > 0 && a[i-1] == b[j-1]:
			ops = append(ops, diffOp{kind: opEqual, line: a[i-1], aIdx: i, bIdx: j})
			i--
			j--
		case j > 0 && (i == 0 || dp[i][j-1] >= dp[i-1][j]):
			ops = append(ops, diffOp{kind: opIns, line: b[j-1], bIdx: j})
			j--
		default:
			ops = append(ops, diffOp{kind: opDel, line: a[i-1], aIdx: i})
			i--
		}
	}
	// Reverse.
	for l, r := 0, len(ops)-1; l < r; l, r = l+1, r-1 {
		ops[l], ops[r] = ops[r], ops[l]
	}
	return ops
}

// buildHunk renders a slice of ops into a diffHunk with proper line
// numbers and prefixed lines.
func buildHunk(slice []diffOp) diffHunk {
	var h diffHunk
	// Establish starting line numbers from the first op in the slice.
	for _, op := range slice {
		if op.aIdx > 0 {
			h.fromStart = op.aIdx
			break
		}
	}
	for _, op := range slice {
		if op.bIdx > 0 {
			h.toStart = op.bIdx
			break
		}
	}
	if h.fromStart == 0 {
		h.fromStart = 1
	}
	if h.toStart == 0 {
		h.toStart = 1
	}
	for _, op := range slice {
		switch op.kind {
		case opEqual:
			h.lines = append(h.lines, " "+ensureNL(op.line))
			h.fromLen++
			h.toLen++
		case opDel:
			h.lines = append(h.lines, "-"+ensureNL(op.line))
			h.fromLen++
		case opIns:
			h.lines = append(h.lines, "+"+ensureNL(op.line))
			h.toLen++
		}
	}
	return h
}

func ensureNL(s string) string {
	if s == "" || s[len(s)-1] == '\n' {
		return s
	}
	return s + "\n"
}

// resolveCommit returns the commit for a ref. Empty ref uses the default
// branch. The returned string is the full SHA that was used.
func (e *Entry) resolveCommit(ref string) (*object.Commit, string, error) {
	if ref == "" {
		ref = e.DefaultBranch
	}
	hash, err := e.repo.ResolveRevision(plumbing.Revision(ref))
	if err != nil {
		return nil, "", fmt.Errorf("resolve ref %q: %w", ref, err)
	}
	commit, err := e.repo.CommitObject(*hash)
	if err != nil {
		return nil, "", fmt.Errorf("read commit %s: %w", hash, err)
	}
	return commit, hash.String(), nil
}

func entryType(m filemode.FileMode) gitchatv1.EntryType {
	switch m {
	case filemode.Dir:
		return gitchatv1.EntryType_ENTRY_TYPE_DIR
	case filemode.Symlink:
		return gitchatv1.EntryType_ENTRY_TYPE_SYMLINK
	case filemode.Submodule:
		return gitchatv1.EntryType_ENTRY_TYPE_SUBMODULE
	case filemode.Regular, filemode.Executable, filemode.Deprecated:
		return gitchatv1.EntryType_ENTRY_TYPE_FILE
	default:
		return gitchatv1.EntryType_ENTRY_TYPE_UNSPECIFIED
	}
}

// isBinary is a coarse heuristic: a file is binary if the first 8KB
// contains a NUL byte. Same rule git itself uses.
func isBinary(content []byte) bool {
	check := content
	if len(check) > 8192 {
		check = check[:8192]
	}
	return bytes.IndexByte(check, 0) >= 0
}

func commitBody(s string) string {
	// Body is everything after the subject + blank separator line.
	idx := strings.Index(s, "\n\n")
	if idx < 0 {
		return ""
	}
	return strings.TrimSpace(s[idx+2:])
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// envIntReader reads an env var as int, returning def if unset or invalid.
func envIntReader(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// envInt64Reader reads an env var as int64, returning def if unset or invalid.
func envInt64Reader(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}
