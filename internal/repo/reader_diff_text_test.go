package repo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Only the disposable fixture's objects are read. Each application writes a new
// test-owned index, never its worktree or the caller's index/configuration.
func applyReaderPatch(t *testing.T, entry *Entry, from, patch string) (string, error) {
	t.Helper()
	index := filepath.Join(t.TempDir(), "index")
	run := func(input string, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd, stderr := (gitCmd{repoDir: entry.Path, args: args}).build(ctx)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.Output()
		if err != nil {
			return "", wrapStderrErr(args, err, stderr)
		}
		return strings.TrimSpace(string(out)), nil
	}
	if _, err := run("", "read-tree", from+"^{tree}"); err != nil {
		return "", err
	}
	if _, err := run(patch, "apply", "--cached", "--whitespace=nowarn", "-"); err != nil {
		return "", err
	}
	return run("", "write-tree")
}

func TestReaderDiffTextRoundTripAgainstNativeGit(t *testing.T) {
	for _, tc := range []struct {
		name, before, after    string
		fromMissing, toMissing bool
	}{
		{name: "both-no-final-LF", before: "old", after: "new"},
		{name: "old-no-final-LF", before: "old", after: "new\n"},
		{name: "new-no-final-LF", before: "old\n", after: "new"},
		{name: "add-final-LF", before: "same", after: "same\n"},
		{name: "remove-final-LF", before: "same\n", after: "same"},
		{name: "context-no-final-LF", before: "old\nlast", after: "new\nlast"},
		{name: "existing-empty-to-text", before: "", after: "text\n"},
		{name: "text-to-existing-empty", before: "text\n", after: ""},
		{name: "add-no-final-LF", fromMissing: true, after: "added"},
		{name: "delete-no-final-LF", before: "deleted", toMissing: true},
		{name: "add-empty", fromMissing: true},
		{name: "delete-empty", toMissing: true},
		{name: "CRLF-to-LF", before: "one\r\ntwo\r\n", after: "one\ntwo\n"},
		{name: "CR-only-is-data", before: "one\rtwo", after: "one\rthree"},
		{name: "blank-line-to-existing-empty", before: "\n", after: ""},
		{name: "existing-empty-to-blank-line", before: "", after: "\n"},
		{name: "multiple-hunks-and-EOF", before: "old\n" + strings.Repeat("middle\n", 10) + "old-tail", after: "new\n" + strings.Repeat("middle\n", 10) + "new-tail\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, ids := readerHistoryFixture(t)
			w, err := entry.repo.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			path := "proof.txt"
			commit := func(content string, missing bool, stamp int64) string {
				t.Helper()
				if missing {
					if _, err := w.Remove(path); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.WriteFile(filepath.Join(entry.Path, path), []byte(content), 0o644); err != nil {
						t.Fatal(err)
					}
					if _, err := w.Add(path); err != nil {
						t.Fatal(err)
					}
				}
				sig := &object.Signature{Name: "Text fixture", Email: "text@example.invalid", When: time.Unix(stamp, 0).UTC()}
				id, err := w.Commit("text fixture\n", &git.CommitOptions{Author: sig, Committer: sig})
				if err != nil {
					t.Fatal(err)
				}
				return id.String()
			}
			from := ids[2]
			if !tc.fromMissing {
				from = commit(tc.before, false, 1700001000)
			}
			to := commit(tc.after, tc.toMissing, 1700001001)
			target, err := entry.repo.CommitObject(plumbing.NewHash(to))
			if err != nil {
				t.Fatal(err)
			}
			native, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", "--no-renames", from, to, "--", path}}).run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			oracleTree, err := applyReaderPatch(t, entry, from, string(native))
			if err != nil || oracleTree != target.TreeHash.String() {
				t.Fatalf("native application oracle invalid: tree=%s err=%v", oracleTree, err)
			}
			numstat, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", from, to, "--", path}}).run(context.Background())
			var wantAdds, wantDels int32
			if err != nil {
				t.Fatal(err)
			}
			if n, err := fmt.Sscanf(string(numstat), "%d\t%d", &wantAdds, &wantDels); n != 2 || err != nil {
				t.Fatalf("invalid native stat oracle: %q %v", numstat, err)
			}
			for _, filter := range []string{path, ""} {
				patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, filter, "", false, false, false)
				if err != nil || empty {
					t.Fatalf("text diff refused/lost: empty=%v err=%v", empty, err)
				}
				if filter == "" && (len(files) != 1 || files[0].Additions != wantAdds || files[0].Deletions != wantDels) {
					t.Errorf("EOF markers changed line stats: files=%v want=%d/%d", files, wantAdds, wantDels)
				}
				got, err := applyReaderPatch(t, entry, from, patch)
				if err != nil || got != target.TreeHash.String() {
					t.Errorf("rendered patch changes bytes/presence: filter=%q tree=%s want=%s err=%v patch=%q", filter, got, target.TreeHash, err, patch)
				}
				if strings.Count(patch, "\\ No newline at end of file\n") != strings.Count(string(native), "\\ No newline at end of file\n") {
					t.Errorf("EOF evidence differs: %q", patch)
				}
				if strings.Contains(patch, "--- /dev/null") && !tc.fromMissing {
					t.Errorf("existing empty file called absent: %q", patch)
				}
				if strings.Contains(patch, "+++ /dev/null") && !tc.toMissing {
					t.Errorf("existing empty file called absent: %q", patch)
				}
			}
		})
	}
}

func TestReaderDiffZeroContextCoordinates(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"insert-start", "one\ntwo\n", "new\none\ntwo\n"},
		{"insert-middle", "one\ntwo\n", "one\nnew\ntwo\n"},
		{"insert-end", "one\ntwo\n", "one\ntwo\nnew\n"},
		{"delete-start", "one\ntwo\n", "two\n"},
		{"delete-middle", "one\ntwo\nthree\n", "one\nthree\n"},
		{"delete-end", "one\ntwo\n", "one\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Check exact ranges against an independent native zero-context oracle.
			entry, _ := readerHistoryFixture(t)
			before := filepath.Join(t.TempDir(), "before")
			after := filepath.Join(t.TempDir(), "after")
			if err := os.WriteFile(before, []byte(tc.before), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(after, []byte(tc.after), 0o600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd, _ := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-index", "--no-ext-diff", "--no-textconv", "--unified=0", "--", before, after}}).build(ctx)
			native, err := cmd.Output()
			if err == nil || cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 1 {
				t.Fatalf("native no-index oracle must report differences: %v", err)
			}
			patch, err := renderFilePatch(newDiffWork(context.Background()), "proof.txt", fileSide{content: tc.before}, fileSide{content: tc.after}, 0)
			if err != nil {
				t.Fatal(err)
			}
			ranges := func(s string) string {
				var out []string
				for _, line := range strings.Split(s, "\n") {
					if strings.HasPrefix(line, "@@ ") {
						out = append(out, line[:strings.LastIndex(line, "@@")+2])
					}
				}
				return strings.Join(out, "\n")
			}
			// Git omits ',1'; the existing renderer spells counts explicitly.
			got := strings.ReplaceAll(ranges(patch), ",1 ", " ")
			got = strings.ReplaceAll(got, ",1 @@", " @@")
			if got != ranges(string(native)) {
				t.Fatalf("zero-context range differs: got=%q want=%q patch=%q", got, ranges(string(native)), patch)
			}
		})
	}
}
