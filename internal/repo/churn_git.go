package repo

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// gitLsTreeSizes runs `git ls-tree -r -l <ref>` and returns a map of
// path → blob byte size for every file reachable from the given ref.
// Native git is substantially faster than go-git's tree.Files() loop,
// which opens each blob header individually — catastrophic on 5000+
// files in Koha.
func gitLsTreeSizes(ctx context.Context, repoDir, ref string) (map[string]int64, error) {
	if ref == "" {
		ref = "HEAD"
	}
	cmd := exec.CommandContext(ctx,
		"git", "-C", repoDir,
		"-c", "core.quotePath=off",
		"ls-tree", "-r", "-l", ref,
	)
	stderr := &cappedBuffer{cap: blameStderrCap}
	cmd.Stderr = stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("git ls-tree: %s", msg)
	}
	// Each line: "<mode> <type> <sha> <size>\t<path>"
	sizes := make(map[string]int64)
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		tab := strings.IndexByte(line, '\t')
		if tab < 0 {
			continue
		}
		header := line[:tab]
		path := line[tab+1:]
		// header fields are space-separated; size is the 4th.
		fields := strings.Fields(header)
		if len(fields) < 4 {
			continue
		}
		if fields[1] != "blob" {
			continue // skip trees/commits/submodules
		}
		if n, err := strconv.ParseInt(fields[3], 10, 64); err == nil {
			sizes[path] = n
		}
	}
	return sizes, nil
}

// churnRawEntry is the per-commit payload the churn aggregator consumes:
// author time plus the numstat lines git emitted for that commit.
type churnRawEntry struct {
	authorTime int64
	// stats rows: each [adds, dels, path]. Binary files have -1/-1.
	rows []churnStatRow
}

type churnStatRow struct {
	path string
	adds int64
	dels int64
}

// gitLogChurn streams a compact per-commit summary over a time window,
// letting git handle the history walk + numstat generation natively.
// Replaces ~5000 go-git Tree.Diff + Patch calls (1.3s on Koha) with
// one subprocess (~100ms typical).
//
// If since/until are zero they're omitted from the command; caller is
// responsible for any default windowing. maxCommits bounds the walk
// (git's `-n`); zero means unbounded.
func gitLogChurn(ctx context.Context, repoDir, ref string, since, until int64, maxCommits int) ([]churnRawEntry, error) {
	// Each commit: \x01<author-time>\x02<blank-line><numstat>\n\n<next>
	args := []string{
		"-C", repoDir,
		"-c", "core.quotePath=off",
		"-c", "diff.renames=false",
		"log",
		"--format=" + string([]byte{logCommitStart}) + "%at" + string([]byte{logCommitEnd}),
		"--numstat",
	}
	if maxCommits > 0 {
		args = append(args, "-n", strconv.Itoa(maxCommits))
	}
	if since > 0 {
		args = append(args, "--since="+strconv.FormatInt(since, 10))
	}
	if until > 0 {
		args = append(args, "--until="+strconv.FormatInt(until, 10))
	}
	if ref != "" {
		args = append(args, ref)
	}

	cmd := exec.CommandContext(ctx, "git", args...)
	stderr := &cappedBuffer{cap: blameStderrCap}
	cmd.Stderr = stderr
	stdout, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		return nil, fmt.Errorf("git log churn pipe: %w", pipeErr)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("git log churn start: %w", err)
	}
	entries, parseErr := parseChurnStream(stdout)
	waitErr := cmd.Wait()
	if waitErr != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return nil, fmt.Errorf("git log churn: %s", msg)
	}
	if parseErr != nil {
		return nil, fmt.Errorf("git log churn parse: %w", parseErr)
	}
	return entries, nil
}

func parseChurnStream(r io.Reader) ([]churnRawEntry, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	var out []churnRawEntry
	i := 0
	for i < len(raw) {
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

		ts, _ := strconv.ParseInt(strings.TrimSpace(string(raw[start+1:end])), 10, 64)

		tail := raw[end+1:]
		nextStart := bytes.IndexByte(tail, logCommitStart)
		var block []byte
		if nextStart < 0 {
			block = tail
			i = len(raw)
		} else {
			block = tail[:nextStart]
			i = end + 1 + nextStart
		}
		entry := churnRawEntry{authorTime: ts}
		sc := bufio.NewScanner(bytes.NewReader(block))
		sc.Buffer(make([]byte, 64*1024), 2*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				continue
			}
			i1 := strings.IndexByte(line, '\t')
			if i1 < 0 {
				continue
			}
			i2 := strings.IndexByte(line[i1+1:], '\t')
			if i2 < 0 {
				continue
			}
			row := churnStatRow{
				path: line[i1+i2+2:],
			}
			aStr := line[:i1]
			dStr := line[i1+1 : i1+1+i2]
			if aStr == "-" {
				row.adds = -1
			} else if n, err := strconv.ParseInt(aStr, 10, 64); err == nil {
				row.adds = n
			}
			if dStr == "-" {
				row.dels = -1
			} else if n, err := strconv.ParseInt(dStr, 10, 64); err == nil {
				row.dels = n
			}
			entry.rows = append(entry.rows, row)
		}
		out = append(out, entry)
	}
	return out, nil
}
