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

// Distinctive byte markers for git log --format parsing. We bracket each
// commit's formatted metadata block with \x01 ... \x02; anything else on
// the stream is numstat output. Body text between the markers can contain
// arbitrary characters including newlines — the markers themselves are
// control bytes a commit message will not realistically contain.
const (
	logCommitStart = 0x01 // SOH — opens a metadata block
	logCommitEnd   = 0x02 // STX — closes a metadata block
	logFieldSep    = 0x1f // US  — between metadata fields
)

// logFormat wraps the fields in SOH/STX markers. %B is the full raw
// message (subject + blank + body); caller splits off the subject.
var logFormat = string([]byte{logCommitStart}) +
	"%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B" +
	string([]byte{logCommitEnd})

// gitLogCommits runs `git log --numstat` with a structured format and
// parses the result into CommitEntry records. Drops go-git's O(commits)
// Tree.Diff + Patch.Stats loop in favour of one git subprocess that
// emits all metadata + per-file stats in native speed (~50-200ms on
// Koha for the default 50-commit page, vs ~1.4s via go-git).
//
// path is optional and becomes `git log ... -- <path>` for a path-
// filtered view. ref is any revspec git understands; empty means HEAD.
// Caller is responsible for applying short-SHA truncation, etc.
func gitLogCommits(ctx context.Context, repoDir, ref string, limit, offset int, path string) ([]*gitchatv1.CommitEntry, bool, error) {
	args := []string{
		"log",
		"-n", strconv.Itoa(limit + 1), // +1 to detect has_more
		"--skip=" + strconv.Itoa(offset),
		"--format=" + logFormat,
		"--numstat",
	}
	if ref != "" {
		args = append(args, ref)
	}
	if path != "" {
		args = append(args, "--", path)
	}

	stdout, done, err := gitCmd{
		repoDir: repoDir,
		config:  []string{"core.quotePath=off", "diff.renames=false"}, // keep numstat one-path-per-line
		args:    args,
	}.pipe(ctx)
	if err != nil {
		return nil, false, err
	}

	commits, parseErr := parseGitLog(stdout, limit+1)
	if waitErr := done(); waitErr != nil {
		return nil, false, waitErr
	}
	if parseErr != nil {
		return nil, false, fmt.Errorf("git log parse: %w", parseErr)
	}

	hasMore := false
	if len(commits) > limit {
		commits = commits[:limit]
		hasMore = true
	}
	return commits, hasMore, nil
}

// gitLogGrepCommits runs `git log` with a single filter flag (--grep
// or --author) and returns matching commits. Uses the same SOH/STX
// format + numstat parser as gitLogCommits so hits are structurally
// identical to a normal log page. Query is treated literally via
// --fixed-strings; -i makes the match case-insensitive. Caller passes
// the flag name ("grep" or "author") — keeping the two search
// dimensions in one function lets SearchCommits run them in parallel
// without duplicating the subprocess plumbing.
func gitLogGrepCommits(ctx context.Context, repoDir, flag, query string, limit int) ([]*gitchatv1.CommitEntry, error) {
	args := []string{
		"log",
		"-n", strconv.Itoa(limit),
		"--format=" + logFormat,
		"--numstat",
		"-i",
		"--fixed-strings",
		"--" + flag + "=" + query,
	}

	stdout, done, err := gitCmd{
		repoDir: repoDir,
		config:  []string{"core.quotePath=off", "diff.renames=false"},
		args:    args,
	}.pipe(ctx)
	if err != nil {
		return nil, err
	}

	commits, parseErr := parseGitLog(stdout, limit)
	if waitErr := done(); waitErr != nil {
		return nil, waitErr
	}
	if parseErr != nil {
		return nil, fmt.Errorf("git log parse: %w", parseErr)
	}
	return commits, nil
}

// parseGitLog scans the stream, looking for SOH...STX metadata blocks
// and interleaved numstat lines. Returns up to maxCommits entries.
func parseGitLog(r io.Reader, maxCommits int) ([]*gitchatv1.CommitEntry, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}

	var out []*gitchatv1.CommitEntry
	i := 0
	for i < len(raw) && len(out) < maxCommits {
		// Seek to next commit start marker.
		start := bytes.IndexByte(raw[i:], logCommitStart)
		if start < 0 {
			break
		}
		start += i
		end := bytes.IndexByte(raw[start+1:], logCommitEnd)
		if end < 0 {
			return nil, fmt.Errorf("unterminated metadata block near byte %d", start)
		}
		end += start + 1

		meta := raw[start+1 : end]
		entry, err := parseCommitMeta(meta)
		if err != nil {
			return nil, err
		}

		// Numstat lines follow, up to the next commit start (or EOF).
		tail := raw[end+1:]
		nextStart := bytes.IndexByte(tail, logCommitStart)
		var numstatBlock []byte
		if nextStart < 0 {
			numstatBlock = tail
			i = len(raw)
		} else {
			numstatBlock = tail[:nextStart]
			i = end + 1 + nextStart
		}
		adds, dels, files := parseNumstat(numstatBlock)
		entry.Additions = adds
		entry.Deletions = dels
		entry.FilesChanged = files
		out = append(out, entry)
	}
	return out, nil
}

func parseCommitMeta(meta []byte) (*gitchatv1.CommitEntry, error) {
	// Split by \x1f into exactly 6 fields: sha, name, email, time, parents, body.
	// Body (%B) may itself contain \x1f only if the committer somehow
	// embedded one — vanishingly rare; we SplitN with 6 so body retains
	// any trailing field separators verbatim.
	parts := bytes.SplitN(meta, []byte{logFieldSep}, 6)
	if len(parts) < 6 {
		return nil, fmt.Errorf("malformed metadata: got %d fields, want 6", len(parts))
	}
	sha := string(parts[0])
	authorName := string(parts[1])
	authorEmail := string(parts[2])
	timeStr := string(parts[3])
	parentsStr := string(parts[4])
	body := string(parts[5])

	ts, _ := strconv.ParseInt(strings.TrimSpace(timeStr), 10, 64)
	var parents []string
	if parentsStr != "" {
		parents = strings.Fields(parentsStr)
	}

	// Trim leading/trailing whitespace from the body that git inserts.
	body = strings.Trim(body, "\n")

	return &gitchatv1.CommitEntry{
		Sha:         sha,
		ShortSha:    ShortSHA(sha),
		Message:     firstLine(body),
		Body:        commitBody(body),
		AuthorName:  authorName,
		AuthorEmail: authorEmail,
		AuthorTime:  ts,
		ParentShas:  parents,
	}, nil
}

// parseNumstat scans `<adds>\t<dels>\t<path>` lines and aggregates
// totals. Binary files report "-\t-\t<path>"; those count toward files
// changed but contribute zero to +/-.
func parseNumstat(block []byte) (adds, dels, files int32) {
	// Walk the in-memory block directly — bufio.Scanner + 64 KiB buffer
	// per numstat block was a wasted allocation on every ListCommits
	// page (one Scanner per commit, 50+ per page).
	for len(block) > 0 {
		nl := bytes.IndexByte(block, '\n')
		var line string
		if nl < 0 {
			line = string(block)
			block = nil
		} else {
			line = string(block[:nl])
			block = block[nl+1:]
		}
		if line == "" {
			continue
		}
		// Expect at least two tabs.
		i1 := strings.IndexByte(line, '\t')
		if i1 < 0 {
			continue
		}
		i2 := strings.IndexByte(line[i1+1:], '\t')
		if i2 < 0 {
			continue
		}
		aStr := line[:i1]
		dStr := line[i1+1 : i1+1+i2]
		// Increment file count regardless of binary marker.
		files++
		if aStr == "-" || dStr == "-" {
			continue
		}
		if n, err := strconv.Atoi(aStr); err == nil {
			adds += int32(n)
		}
		if n, err := strconv.Atoi(dStr); err == nil {
			dels += int32(n)
		}
	}
	return adds, dels, files
}

