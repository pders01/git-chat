package repo

import (
	"bytes"
	"context"
	"io"
	"strconv"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// gitListBranches runs `git for-each-ref refs/heads` with a structured
// format and returns one Branch per local branch. One subprocess reads
// the packfile once and emits every field we need; go-git's per-branch
// CommitObject lookup was ~700ms on Koha for exactly this data.
//
// refspec picks the kind of ref we're enumerating: "refs/heads" for
// branches, "refs/tags" for tags. The Branch proto is intentionally
// wire-compatible for both.
func gitListBranches(ctx context.Context, repoDir, refspec string) ([]*gitchatv1.Branch, error) {
	// Separator: unit (\x1f) between fields, record (\x1e) between refs.
	// for-each-ref lets us choose any format string; using control bytes
	// removes any concern about subjects or branch names containing the
	// separator character.
	const fieldSep = "%1f"
	const recSep = "%1e"
	format := "%(refname:short)" + fieldSep +
		"%(objectname)" + fieldSep +
		"%(committerdate:unix)" + fieldSep +
		"%(subject)" + recSep

	out, err := gitCmd{
		repoDir: repoDir,
		config:  []string{"core.quotePath=off"},
		args: []string{
			"for-each-ref",
			"--sort=-committerdate",
			"--format=" + format,
			refspec,
		},
	}.run(ctx)
	if err != nil {
		return nil, err
	}
	return parseForEachRef(bytes.NewReader(out))
}

func parseForEachRef(r io.Reader) ([]*gitchatv1.Branch, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	var out []*gitchatv1.Branch
	// Records are \x1e-terminated.
	for _, rec := range bytes.Split(raw, []byte{0x1e}) {
		rec = bytes.TrimLeft(rec, "\n")
		if len(rec) == 0 {
			continue
		}
		parts := bytes.SplitN(rec, []byte{0x1f}, 4)
		if len(parts) < 4 {
			continue
		}
		ts, _ := strconv.ParseInt(strings.TrimSpace(string(parts[2])), 10, 64)
		out = append(out, &gitchatv1.Branch{
			Name:          string(parts[0]),
			Commit:        string(parts[1]),
			CommitterTime: ts,
			Subject:       string(parts[3]),
		})
	}
	return out, nil
}
