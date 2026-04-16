package repo

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// gitBlamePorcelain runs `git blame --porcelain <sha> -- <path>` in the
// given repo directory and parses the output into blame lines. Only the
// per-line Text, AuthorName, AuthorEmail, Date, and CommitSha are filled
// in here; CommitMessage is left empty and populated by the caller.
//
// sha is expected to be a full 40-char hex SHA (not a user-supplied ref),
// and path is passed after `--` so a leading `-` is safe as argv. No
// shell is ever invoked, so there is no injection surface beyond git
// itself. Returns ErrNotFound if the file isn't present at that commit.
//
// The context is threaded through gitCmd.pipe so a client cancel (or
// deadline) actually terminates the git subprocess instead of
// orphaning it.
func gitBlamePorcelain(ctx context.Context, repoDir, sha, path string) ([]*gitchatv1.BlameLine, error) {
	stdout, done, err := gitCmd{
		repoDir: repoDir,
		config:  []string{"core.quotePath=off"},
		args:    []string{"blame", "--porcelain", sha, "--", path},
	}.pipe(ctx)
	if err != nil {
		return nil, err
	}
	lines, parseErr := parseBlamePorcelain(stdout)
	if waitErr := done(); waitErr != nil {
		// `git blame` emits "no such path ..." to stderr when the file
		// isn't present at the commit; translate that into ErrNotFound
		// so callers can surface a clean 404 instead of a raw message.
		if strings.Contains(strings.ToLower(waitErr.Error()), "no such path") {
			return nil, ErrNotFound
		}
		return nil, waitErr
	}
	if parseErr != nil {
		return nil, fmt.Errorf("git blame parse: %w", parseErr)
	}
	return lines, nil
}

// parseBlamePorcelain reads the porcelain output stream. Format:
//
//	<sha> <srcLine> <finalLine> [<numLines>]   ← group header
//	author <name>                              ← metadata, first time each sha is seen
//	author-mail <<email>>
//	author-time <unix>
//	... (committer, summary, previous, filename)
//	\t<content>
//	<sha> <srcLine> <finalLine>                ← subsequent line of the same group
//	\t<content>
//
// Metadata is only repeated on first encounter of each commit SHA, so we
// keep a meta cache and re-use it for every line attributed to that SHA.
func parseBlamePorcelain(r io.Reader) ([]*gitchatv1.BlameLine, error) {
	type commitMeta struct {
		author string
		email  string
		date   int64
	}
	metaBySHA := map[string]*commitMeta{}

	br := bufio.NewReaderSize(r, 64*1024)
	var out []*gitchatv1.BlameLine
	var current *commitMeta
	var currentSHA string

	readLine := func() (string, error) {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\n")
		}
		return line, err
	}

	for {
		header, err := readLine()
		if err == io.EOF && header == "" {
			break
		}
		if err != nil && err != io.EOF {
			return nil, err
		}
		if header == "" {
			continue
		}

		// Header: "<40-hex-sha> <src> <final> [<count>]"
		parts := strings.SplitN(header, " ", 4)
		if len(parts) < 3 || len(parts[0]) != 40 {
			return nil, fmt.Errorf("unexpected porcelain header: %q", header)
		}
		currentSHA = parts[0]
		current = metaBySHA[currentSHA]

		// Metadata block follows only on first encounter for this SHA.
		// Keep reading key/value lines until we hit the tab-prefixed
		// content line.
		for {
			meta, err := readLine()
			if err != nil && err != io.EOF {
				return nil, err
			}
			if len(meta) > 0 && meta[0] == '\t' {
				// Tab-prefixed content line.
				if current == nil {
					// Commit had no metadata block (shouldn't happen for
					// the first group of a SHA, but be defensive).
					current = &commitMeta{}
					metaBySHA[currentSHA] = current
				}
				out = append(out, &gitchatv1.BlameLine{
					Text:        meta[1:],
					AuthorName:  current.author,
					AuthorEmail: current.email,
					Date:        current.date,
					CommitSha:   currentSHA, // full 40-char SHA; caller truncates
				})
				break
			}
			if current == nil {
				current = &commitMeta{}
				metaBySHA[currentSHA] = current
			}
			switch {
			case strings.HasPrefix(meta, "author "):
				current.author = strings.TrimPrefix(meta, "author ")
			case strings.HasPrefix(meta, "author-mail "):
				email := strings.TrimPrefix(meta, "author-mail ")
				email = strings.TrimPrefix(email, "<")
				email = strings.TrimSuffix(email, ">")
				current.email = email
			case strings.HasPrefix(meta, "author-time "):
				if n, err := strconv.ParseInt(strings.TrimPrefix(meta, "author-time "), 10, 64); err == nil {
					current.date = n
				}
			}
			if err == io.EOF {
				break
			}
		}
	}
	return out, nil
}
