package repo

import (
	"bytes"
	"context"
	"sort"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// gitStatusPorcelain runs `git status --porcelain=v1 -z` in the repo
// directory and parses the result into the same (staged / unstaged /
// untracked) buckets go-git's worktree.Status() produced, but without
// the O(tree) staleness walk go-git does internally. On Koha the native
// git binary is ~30-50× faster than go-git for this operation.
//
// `-z` gives us NUL-terminated entries so filenames with spaces, quotes,
// or UTF-8 just pass through verbatim. `-c core.quotePath=off` keeps
// non-ASCII paths readable in the rare case something leaks through.
func gitStatusPorcelain(ctx context.Context, repoDir string) (staged, unstaged, untracked []*gitchatv1.StatusFile, err error) {
	out, err := gitCmd{
		repoDir: repoDir,
		config:  []string{"core.quotePath=off"},
		args:    []string{"status", "--porcelain=v1", "-z"},
	}.run(ctx)
	if err != nil {
		return nil, nil, nil, err
	}

	// Walk NUL-separated entries. Rename lines consume a second NUL-
	// terminated token for the old path, which we currently discard
	// (the UI shows the new name + "renamed" status).
	for len(out) > 0 {
		end := bytes.IndexByte(out, 0)
		if end < 0 {
			end = len(out)
		}
		entry := out[:end]
		if end < len(out) {
			out = out[end+1:]
		} else {
			out = nil
		}
		if len(entry) < 4 {
			continue
		}
		staging := entry[0]
		worktree := entry[1]
		// entry[2] is a space; path starts at entry[3]
		path := string(entry[3:])

		// Rename / copy entries are followed by a second NUL-terminated
		// token giving the pre-rename path. Consume and discard it.
		if staging == 'R' || staging == 'C' || worktree == 'R' || worktree == 'C' {
			if n := bytes.IndexByte(out, 0); n >= 0 {
				out = out[n+1:]
			} else {
				out = nil
			}
		}

		if staging == '?' && worktree == '?' {
			untracked = append(untracked, &gitchatv1.StatusFile{Path: path, Status: "added"})
			continue
		}
		if s := statusCharToName(staging); s != "" {
			staged = append(staged, &gitchatv1.StatusFile{Path: path, Status: s})
		}
		if s := statusCharToName(worktree); s != "" {
			unstaged = append(unstaged, &gitchatv1.StatusFile{Path: path, Status: s})
		}
	}

	sort.Slice(staged, func(i, j int) bool { return staged[i].Path < staged[j].Path })
	sort.Slice(unstaged, func(i, j int) bool { return unstaged[i].Path < unstaged[j].Path })
	sort.Slice(untracked, func(i, j int) bool { return untracked[i].Path < untracked[j].Path })
	return staged, unstaged, untracked, nil
}

// statusCharToName maps a porcelain v1 status character to the string
// the UI displays. Matches the mapStatusCode coverage for go-git.
func statusCharToName(c byte) string {
	switch c {
	case 'M':
		return "modified"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'U':
		return "unmerged"
	default:
		return ""
	}
}
