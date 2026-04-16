package repo

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// gitCmd is the shared boilerplate every `git <subcommand>` shell-out
// in this package needs: exec.CommandContext with the repo's work
// directory, a bounded stderr sink so a runaway child can't push the
// server OOM via error output, and uniform error extraction that
// preserves ctx.Err() when the caller cancelled.
//
// Each subprocess file (blame, status, log, branches, churn) was
// reproducing this pattern by hand; the first refactor past the fifth
// copy lets us keep parsers narrow and the error surface consistent.
type gitCmd struct {
	repoDir string
	// Extra `-c key=value` overrides applied before the subcommand.
	// Most call sites want core.quotePath=off at minimum.
	config []string
	// Subcommand + args (e.g. "blame", "--porcelain", sha, "--", path).
	args []string
}

// stderrCap bounds the stderr buffer per command. 8 KiB is plenty for
// git's error prose; anything past that gets silently dropped instead
// of allocated, bounding memory on adversarial children.
const stderrCap = 8 * 1024

// build returns an *exec.Cmd with the stderr sink + -C repoDir +
// extra -c overrides applied. Callers call Output() or StdoutPipe()
// themselves depending on whether they want the whole buffer or a
// streaming read.
func (g gitCmd) build(ctx context.Context) (*exec.Cmd, *cappedBuffer) {
	cliArgs := make([]string, 0, 2+2*len(g.config)+len(g.args))
	cliArgs = append(cliArgs, "-C", g.repoDir)
	for _, kv := range g.config {
		cliArgs = append(cliArgs, "-c", kv)
	}
	cliArgs = append(cliArgs, g.args...)
	cmd := exec.CommandContext(ctx, "git", cliArgs...)
	stderr := &cappedBuffer{cap: stderrCap}
	cmd.Stderr = stderr
	return cmd, stderr
}

// run runs the command and returns its buffered stdout. Matches
// exec.Cmd.Output semantics but with the standard ctx-first error
// unwrap: if the caller cancelled, prefer ctx.Err() over git's stderr.
func (g gitCmd) run(ctx context.Context) ([]byte, error) {
	cmd, stderr := g.build(ctx)
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, wrapStderrErr(g.args, err, stderr)
	}
	return out, nil
}

// pipe starts the command and returns a streaming reader over stdout
// plus a wait-and-close callback the caller must invoke after reading.
// Use this for long-output subcommands (git log, git blame) where
// buffering the whole stream in memory would be wasteful.
func (g gitCmd) pipe(ctx context.Context) (io.Reader, func() error, error) {
	cmd, stderr := g.build(ctx)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("git %s pipe: %w", firstArg(g.args), err)
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("git %s start: %w", firstArg(g.args), err)
	}
	done := func() error {
		waitErr := cmd.Wait()
		if waitErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return wrapStderrErr(g.args, waitErr, stderr)
	}
	return stdout, done, nil
}

// wrapStderrErr produces the same formatted error every call site was
// writing inline: "git <sub>: <stderr-if-nonempty-else-runerr>".
func wrapStderrErr(args []string, runErr error, stderr *cappedBuffer) error {
	msg := strings.TrimSpace(stderr.String())
	if msg == "" {
		msg = runErr.Error()
	}
	return fmt.Errorf("git %s: %s", firstArg(args), msg)
}

func firstArg(args []string) string {
	if len(args) == 0 {
		return "?"
	}
	return args[0]
}

// cappedBuffer is an io.Writer that silently drops bytes past cap.
// Used as git's stderr sink so a runaway child streaming gigabytes of
// error output can't force unbounded buffering on the parent.
type cappedBuffer struct {
	buf bytes.Buffer
	cap int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	remaining := b.cap - b.buf.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		b.buf.Write(p[:remaining])
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *cappedBuffer) String() string { return b.buf.String() }
