package repo

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"golang.org/x/sync/errgroup"
)

// gitEmptyTreeSHA is git's well-known empty tree object. Used when
// diffing a root commit: there's no parent SHA to hand to `git diff`,
// so we substitute this sentinel and git treats the other side as the
// "add everything" baseline.
const gitEmptyTreeSHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// gitDiffAll runs the entire whole-range diff through the native git
// binary. Returns the concatenated unified patch plus per-file metadata
// (status, renames, +/- stats). Used by GetDiff when the caller opts
// into full_range because the go-git path does 8k+ serial tree lookups
// and two Myers passes per file — on Koha-scale ranges that's minutes
// where git finishes in seconds.
//
// Three parallel invocations:
//   - `git diff`           → the unified patch itself (big).
//   - `git diff --raw`     → status codes + renames per file.
//   - `git diff --numstat` → per-file add/delete counts.
//
// -z keeps paths NUL-separated so unicode / whitespace / quoted names
// round-trip verbatim. core.quotePath=off is belt-and-braces for paths
// that escape -z (shouldn't happen, but cheap to set).
//
// fromSHA may be empty — caller passes resolveCommit's result, which
// is "" for a root commit. We swap in the empty-tree SHA so git treats
// the left side as "nothing existed".
func gitDiffAll(ctx context.Context, repoDir, fromSHA, toSHA string, detectRenames bool) (patch string, files []*gitchatv1.ChangedFile, err error) {
	if fromSHA == "" {
		fromSHA = gitEmptyTreeSHA
	}
	mkArgs := func(extra ...string) []string {
		a := make([]string, 0, 4+len(extra))
		a = append(a, "diff")
		if detectRenames {
			a = append(a, "-M")
		}
		a = append(a, extra...)
		a = append(a, fromSHA, toSHA)
		return a
	}
	cfg := []string{"core.quotePath=off"}

	var patchB, statB, rawB []byte
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		b, e := gitCmd{repoDir: repoDir, config: cfg, args: mkArgs()}.run(gctx)
		patchB = b
		return e
	})
	g.Go(func() error {
		b, e := gitCmd{repoDir: repoDir, config: cfg, args: mkArgs("--numstat", "-z")}.run(gctx)
		statB = b
		return e
	})
	g.Go(func() error {
		b, e := gitCmd{repoDir: repoDir, config: cfg, args: mkArgs("--raw", "-z")}.run(gctx)
		rawB = b
		return e
	})
	if werr := g.Wait(); werr != nil {
		return "", nil, werr
	}

	byPath := make(map[string]*gitchatv1.ChangedFile)
	if perr := parseRawZ(rawB, byPath); perr != nil {
		return "", nil, fmt.Errorf("parse --raw: %w", perr)
	}
	if perr := parseNumstatZ(statB, byPath); perr != nil {
		return "", nil, fmt.Errorf("parse --numstat: %w", perr)
	}

	files = make([]*gitchatv1.ChangedFile, 0, len(byPath))
	for _, f := range byPath {
		files = append(files, f)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return string(patchB), files, nil
}

// parseRawZ walks `git diff --raw -z` output.
//
// Each record is ":<mode1> <mode2> <sha1> <sha2> <status>" (space-
// separated fields, then NUL), followed by the path — or, for rename
// and copy statuses, two NUL-terminated paths (src then dst). Status
// codes: A/M/D/T for single-path, Rnnn/Cnnn for the two-path variants
// where nnn is a similarity score we ignore.
func parseRawZ(b []byte, m map[string]*gitchatv1.ChangedFile) error {
	for len(b) > 0 {
		nul := bytes.IndexByte(b, 0)
		if nul < 0 {
			break
		}
		meta := b[:nul]
		b = b[nul+1:]
		if len(meta) == 0 || meta[0] != ':' {
			continue
		}
		fields := bytes.Fields(meta)
		if len(fields) < 5 {
			continue
		}
		statusField := fields[4]
		if len(statusField) == 0 {
			continue
		}
		statusByte := statusField[0]

		p1, rest, ok := cutNUL(b)
		if !ok {
			break
		}
		b = rest
		var p2 string
		if statusByte == 'R' || statusByte == 'C' {
			var ok2 bool
			p2, b, ok2 = cutNUL(b)
			if !ok2 {
				break
			}
		}

		var path, fromPath, status string
		switch statusByte {
		case 'R':
			path, fromPath, status = p2, p1, "renamed"
		case 'C':
			path, status = p2, "copied"
		case 'A':
			path, status = p1, "added"
		case 'D':
			path, status = p1, "deleted"
		case 'M', 'T':
			// Type change (symlink ↔ regular) renders the same as a
			// content modification from the UI's point of view; collapse
			// it so the file list doesn't sprout a rare status.
			path, status = p1, "modified"
		default:
			continue
		}
		m[path] = &gitchatv1.ChangedFile{Path: path, Status: status, FromPath: fromPath}
	}
	return nil
}

// parseNumstatZ walks `git diff --numstat -z` output.
//
// Regular entry: "<adds>\t<dels>\t<path>\0".
// Rename entry:  "<adds>\t<dels>\t\0<from>\0<to>\0" — the path slot is
// empty and the two renamed paths follow as separate NUL tokens.
// Binary files emit "-" instead of a line count; we treat those as
// 0/0 since the sidebar has no meaningful number to show.
func parseNumstatZ(b []byte, m map[string]*gitchatv1.ChangedFile) error {
	for len(b) > 0 {
		head, rest, ok := cutNUL(b)
		if !ok {
			break
		}
		b = rest
		// Split only the first two tabs so paths with tabs survive.
		parts := strings.SplitN(head, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		addsS, delsS, pathField := parts[0], parts[1], parts[2]

		var path, fromPath string
		if pathField == "" {
			var ok1, ok2 bool
			fromPath, b, ok1 = cutNUL(b)
			if !ok1 {
				break
			}
			path, b, ok2 = cutNUL(b)
			if !ok2 {
				break
			}
		} else {
			path = pathField
		}

		adds, dels := parseStatNumber(addsS), parseStatNumber(delsS)
		f, ok := m[path]
		if !ok {
			// Raw didn't emit a status for this path. Shouldn't happen
			// in practice — both commands see the same tree delta — but
			// fall back to "modified" so the file still appears with
			// correct stats rather than vanishing.
			f = &gitchatv1.ChangedFile{Path: path, Status: "modified"}
			m[path] = f
		}
		f.Additions = adds
		f.Deletions = dels
		if f.FromPath == "" && fromPath != "" {
			f.FromPath = fromPath
		}
	}
	return nil
}

// cutNUL returns the slice up to the next NUL, the rest past the NUL,
// and ok=false when no NUL remains. Keeps the two -z parsers readable
// by pushing the index-arithmetic out of the loop body.
func cutNUL(b []byte) (token string, rest []byte, ok bool) {
	n := bytes.IndexByte(b, 0)
	if n < 0 {
		return "", b, false
	}
	return string(b[:n]), b[n+1:], true
}

// parseStatNumber parses a numstat field. "-" (binary) becomes 0;
// anything unparseable also becomes 0 rather than failing the whole
// diff over one weird entry.
func parseStatNumber(s string) int32 {
	if s == "-" || s == "" {
		return 0
	}
	n, err := strconv.ParseInt(s, 10, 32)
	if err != nil {
		return 0
	}
	return int32(n)
}
