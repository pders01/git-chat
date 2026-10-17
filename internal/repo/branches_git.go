package repo

import (
	"bytes"
	"context"
	"fmt"
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
	// Subjects can contain RS/US, but not NUL. Prefix each record with
	// NUL and terminate all five fields with NUL; for-each-ref appends
	// exactly one newline after each record. Never trim field contents.
	const fieldSep = "%00"
	format := fieldSep + "%(refname:short)" + fieldSep +
		"%(objectname)" + fieldSep +
		"%(committerdate:unix)" + fieldSep +
		"%(refname)" + fieldSep +
		"%(subject)" + fieldSep

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
	for record := 1; len(raw) > 0; record++ {
		if raw[0] != 0 {
			return nil, fmt.Errorf("for-each-ref record %d: missing NUL prefix", record)
		}
		raw = raw[1:]
		var fields [5]string
		for i := range fields {
			end := bytes.IndexByte(raw, 0)
			if end < 0 {
				return nil, fmt.Errorf("for-each-ref record %d: truncated field %d", record, i+1)
			}
			fields[i], raw = string(raw[:end]), raw[end+1:]
		}
		if len(raw) == 0 || raw[0] != '\n' {
			return nil, fmt.Errorf("for-each-ref record %d: missing record newline", record)
		}
		raw = raw[1:]
		if !validForEachRefName(fields[0]) {
			return nil, fmt.Errorf("for-each-ref record %d: invalid display name", record)
		}
		if !validForEachRefObjectID(fields[1]) {
			return nil, fmt.Errorf("for-each-ref record %d: invalid object ID", record)
		}
		// An annotated tag has no committerdate; retain its legacy zero.
		var ts int64
		if fields[2] != "" {
			ts, err = strconv.ParseInt(fields[2], 10, 64)
			if err != nil || strconv.FormatInt(ts, 10) != fields[2] {
				return nil, fmt.Errorf("for-each-ref record %d: invalid committer timestamp", record)
			}
		}
		if !strings.HasPrefix(fields[3], "refs/") || !validForEachRefName(fields[3]) {
			return nil, fmt.Errorf("for-each-ref record %d: invalid canonical ref", record)
		}
		out = append(out, &gitchatv1.Branch{
			Name:          fields[0],
			Commit:        fields[1],
			CommitterTime: ts,
			FullRef:       fields[3],
			Subject:       fields[4],
		})
	}
	return out, nil
}

// Validate Git ref spelling without cleaning paths or shortening namespaces.
// Short display names may be one-level (including "@"), and must stay verbatim.
func validForEachRefName(name string) bool {
	if name == "" || strings.HasSuffix(name, ".") || strings.Contains(name, "..") ||
		strings.Contains(name, "@{") || strings.ContainsAny(name, "~^:?*[\\") {
		return false
	}
	for i := range len(name) {
		if name[i] <= ' ' || name[i] == 0x7f {
			return false
		}
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

func validForEachRefObjectID(id string) bool {
	// Native Git supports both SHA-1 and SHA-256 object formats. Do not
	// decode through go-git's SHA-1 Hash, which can truncate/normalize IDs.
	if len(id) != 40 && len(id) != 64 {
		return false
	}
	nonzero := false
	for i := range len(id) {
		c := id[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
		nonzero = nonzero || c != '0'
	}
	return nonzero
}
