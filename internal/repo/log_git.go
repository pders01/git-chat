package repo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// Git pretty fields and paths cannot contain NUL. SOH/STX/RS/US, tabs and
// newlines are legal data and must never be searched as record boundaries.
const logFormat = "%x00%H%x00%an%x00%ae%x00%at%x00%P%x00%s%x00%b%x00"
const maxGitLogBytes = 8 * 1024 * 1024

// Legacy churn-only framing remains a separate contract. Commits history and
// search no longer use these sentinels; do not reintroduce them into this parser.
const logCommitStart = 0x01
const logCommitEnd = 0x02

var errNativeLogData = errors.New("invalid native Git log data")

func nativeLogArgs(count int) []string {
	return []string{"log", "-n", strconv.Itoa(count), "--format=" + logFormat,
		"--numstat", "-z", "--no-renames", "--no-diff-merges", "--no-color",
		"--no-show-signature", "--no-notes", "--no-ext-diff", "--no-textconv", "--encoding=UTF-8"}
}

// nativeLogPage bounds metadata before parsing. Cancel the exact subprocess
// before waiting after a read/parse failure, so a capped pipe cannot deadlock.
func nativeLogPage(ctx context.Context, repoDir string, args []string, count int) ([]*gitchatv1.CommitEntry, error) {
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout, done, err := (gitCmd{repoDir: repoDir, config: []string{"core.quotePath=off", "diff.renames=false"}, args: args}).pipe(childCtx)
	if err != nil {
		return nil, err
	}
	rows, parseErr := parseGitLog(stdout, count)
	if parseErr != nil {
		cancel()
	}
	waitErr := done()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if parseErr != nil {
		return nil, parseErr
	}
	if waitErr != nil {
		return nil, waitErr
	}
	return rows, nil
}

// gitLogCommits returns an immutable-ref page and one-row lookahead. The
// caller supplies ref/path validation; paths retain native literal bytes.
func gitLogCommits(ctx context.Context, repoDir, ref string, limit, offset int, path string) ([]*gitchatv1.CommitEntry, bool, error) {
	args := nativeLogArgs(limit + 1)
	args = append(args, "--skip="+strconv.Itoa(offset))
	if ref != "" {
		args = append(args, ref)
	}
	if path != "" {
		args = append(args, "--", path)
	}
	rows, err := nativeLogPage(ctx, repoDir, args, limit+1)
	if err != nil {
		return nil, false, err
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	return rows, more, nil
}

// Search uses the same strict format as ordinary history. Its caller owns
// query semantics; no malformed/oversized output is reinterpreted here.
func gitLogGrepCommits(ctx context.Context, repoDir, flag, query string, limit int) ([]*gitchatv1.CommitEntry, error) {
	if flag != "grep" && flag != "author" {
		return nil, fmt.Errorf("invalid log search flag")
	}
	args := append(nativeLogArgs(limit), "-i", "--fixed-strings", "--"+flag+"="+query)
	return nativeLogPage(ctx, repoDir, args, limit)
}

func invalidLog(reason string) error { return fmt.Errorf("%w: %s", errNativeLogData, reason) }

// Grammar: NUL prefix, seven NUL-terminated pretty fields, one NUL tformat
// terminator, optional LF + NUL-terminated numstat rows, then the next prefix.
// Parse the entire bounded output; never return a valid prefix on malformed tail.
func parseGitLog(r io.Reader, maxCommits int) ([]*gitchatv1.CommitEntry, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxGitLogBytes+1))
	if err != nil {
		return nil, invalidLog("metadata read failed")
	}
	if len(raw) > maxGitLogBytes {
		return nil, invalidLog("metadata byte limit exceeded")
	}
	if !utf8.Valid(raw) {
		return nil, invalidLog("metadata is not valid UTF-8")
	}
	var out []*gitchatv1.CommitEntry
	seen := make(map[string]bool)
	for len(raw) > 0 {
		if raw[0] != 0 || len(out) >= maxCommits {
			return nil, invalidLog("unexpected record prefix/count")
		}
		raw = raw[1:]
		var fields [7]string
		for i := range fields {
			end := bytes.IndexByte(raw, 0)
			if end < 0 {
				return nil, invalidLog("truncated pretty field")
			}
			fields[i] = string(raw[:end])
			raw = raw[end+1:]
		}
		if len(raw) == 0 || raw[0] != 0 {
			return nil, invalidLog("missing pretty terminator")
		}
		raw = raw[1:]
		if !validForEachRefObjectID(fields[0]) || seen[fields[0]] {
			return nil, invalidLog("invalid/duplicate object ID")
		}
		seen[fields[0]] = true
		ts, err := strconv.ParseInt(fields[3], 10, 64)
		if err != nil || strconv.FormatInt(ts, 10) != fields[3] {
			return nil, invalidLog("invalid author timestamp")
		}
		var parents []string
		if fields[4] != "" {
			parents = strings.Split(fields[4], " ")
			for _, parent := range parents {
				if !validForEachRefObjectID(parent) {
					return nil, invalidLog("invalid parent object ID")
				}
			}
		}
		entry := &gitchatv1.CommitEntry{Sha: fields[0], ShortSha: ShortSHA(fields[0]), AuthorName: fields[1], AuthorEmail: fields[2],
			AuthorTime: ts, ParentShas: parents, Message: fields[5], Body: fields[6]}
		if len(raw) > 0 && raw[0] == '\n' {
			raw = raw[1:]
			if len(raw) == 0 || raw[0] == 0 {
				return nil, invalidLog("missing numstat row")
			}
			for len(raw) > 0 && raw[0] != 0 {
				end := bytes.IndexByte(raw, 0)
				if end < 0 {
					return nil, invalidLog("truncated numstat row")
				}
				row := raw[:end]
				raw = raw[end+1:]
				parts := bytes.SplitN(row, []byte{'\t'}, 3)
				if len(parts) != 3 || len(parts[2]) == 0 {
					return nil, invalidLog("malformed numstat row")
				}
				var adds, dels int64
				if string(parts[0]) == "-" && string(parts[1]) == "-" {
					// Binary changes count as a file, not invented text line totals.
				} else {
					adds, err = parseLogCount(string(parts[0]))
					if err != nil {
						return nil, err
					}
					dels, err = parseLogCount(string(parts[1]))
					if err != nil {
						return nil, err
					}
				}
				if int64(entry.Additions)+adds > 2147483647 || int64(entry.Deletions)+dels > 2147483647 || entry.FilesChanged == 2147483647 {
					return nil, invalidLog("numstat total overflow")
				}
				entry.Additions += int32(adds)
				entry.Deletions += int32(dels)
				entry.FilesChanged++
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func parseLogCount(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 32)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != value {
		return 0, invalidLog("invalid numstat count")
	}
	return n, nil
}
