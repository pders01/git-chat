package repo

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Every object and Git configuration path is test-owned. No Registry/prewarming,
// server, model, provider or user repository is involved. Tests cannot run in
// parallel because forcing the existing go-git fallback changes PATH.
func readerHistoryFixture(t *testing.T) (*Entry, []string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_COUNT", "0")
	dir := t.TempDir()
	r, err := git.PlainInitWithOptions(dir, &git.PlainInitOptions{InitOptions: git.InitOptions{DefaultBranch: "refs/heads/main"}})
	if err != nil {
		t.Fatal(err)
	}
	w, err := r.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i, content := range []string{"one\n", "one\ntwo\n", "one\ntwo\nthree\n"} {
		if err := os.WriteFile(filepath.Join(dir, "exact file.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Add("exact file.txt"); err != nil {
			t.Fatal(err)
		}
		sig := &object.Signature{Name: "History fixture", Email: "history@example.invalid", When: time.Unix(1700000000+int64(i), 0).UTC()}
		id, err := w.Commit("fixture commit\n", &git.CommitOptions{Author: sig, Committer: sig})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id.String())
	}
	return &Entry{Path: dir, DefaultBranch: "main", repo: r}, ids
}

func hideReaderGit(t *testing.T, entry *Entry) {
	t.Helper()
	t.Setenv("PATH", "")
	if _, err := exec.LookPath("git"); err == nil {
		t.Fatal("native Git remains discoverable")
	}
	if _, _, err := gitLogCommits(context.Background(), entry.Path, "HEAD", 1, 0, ""); err == nil {
		t.Fatal("native helper unexpectedly succeeded; fallback was not established")
	}
}

func TestReaderHistorySelectsCanonicalRefsBeforePaging(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	if _, err := entry.repo.CreateTag("main", plumbing.NewHash(ids[0]), &git.CreateTagOptions{
		Tagger:  &object.Signature{Name: "Fixture", Email: "tag@example.invalid", When: time.Unix(1700000010, 0)},
		Message: "A tag that shares the branch's display name.",
	}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "fallback" {
				hideReaderGit(t, entry)
			}
			for _, query := range []struct{ ref, first string }{
				{"", ids[2]}, {"refs/heads/main", ids[2]}, {"refs/tags/main", ids[0]}, {ids[1], ids[1]},
			} {
				rows, more, err := entry.ListCommits(context.Background(), query.ref, 1, 0, "")
				if err != nil || len(rows) != 1 || rows[0].Sha != query.first || more != (query.first != ids[0]) {
					t.Fatalf("ref %q: rows=%v more=%v err=%v", query.ref, rows, more, err)
				}
			}
		})
	}
}

func TestReaderHistoryCanceledReadDoesNotFallThrough(t *testing.T) {
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			entry, _ := readerHistoryFixture(t)
			if mode == "fallback" {
				hideReaderGit(t, entry)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			rows, more, err := entry.ListCommits(ctx, "HEAD", 2, 0, "")
			if !errors.Is(err, context.Canceled) || len(rows) != 0 || more {
				t.Fatalf("canceled history returned rows=%d more=%v err=%v", len(rows), more, err)
			}
		})
	}
}

func TestReaderHistoryMissingAncestorIsNotExhaustion(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	// Remove one known loose object in this disposable repository, not an object
	// selected by a caller or a path in a registered/user repository.
	ancestor := ids[0]
	if err := os.Remove(filepath.Join(entry.Path, ".git", "objects", ancestor[:2], ancestor[2:])); err != nil {
		t.Fatal(err)
	}
	hideReaderGit(t, entry)
	rows, more, err := entry.ListCommits(context.Background(), ids[2], 10, 0, "")
	if err == nil || len(rows) != 0 || more {
		t.Fatalf("missing ancestor certified a page: rows=%d more=%v err=%v", len(rows), more, err)
	}
}

func TestReaderHistoryModeOnlyExactPathIsRetained(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	if _, err := exec.LookPath("git"); err != nil {
		t.Fatal("native Git required for the independent history oracle")
	}
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(entry.Path, "exact file.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add("exact file.txt"); err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "History fixture", Email: "history@example.invalid", When: time.Unix(1700000003, 0).UTC()}
	mode, err := w.Commit("mode only\n", &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	native, nativeMore, err := gitLogCommits(context.Background(), entry.Path, mode.String(), 2, 0, "exact file.txt")
	if err != nil || len(native) != 2 || native[0].Sha != mode.String() || !nativeMore {
		t.Fatalf("native exact-path oracle: rows=%v more=%v err=%v", native, nativeMore, err)
	}
	hideReaderGit(t, entry)
	rows, more, err := entry.ListCommits(context.Background(), mode.String(), 2, 0, "exact file.txt")
	if err != nil || len(rows) != 2 || rows[0].Sha != mode.String() || rows[1].Sha != ids[2] || !more {
		t.Fatalf("fallback lost mode-only path commit: rows=%v more=%v err=%v", rows, more, err)
	}
	if rows[0].FilesChanged != 1 || rows[0].Additions != 0 || rows[0].Deletions != 0 {
		t.Fatalf("mode-only summary lost changed-file evidence: %v", rows[0])
	}
	last, more, err := entry.ListCommits(context.Background(), mode.String(), 2, 2, "exact file.txt")
	if err != nil || len(last) != 2 || last[0].Sha != ids[1] || last[1].Sha != ids[0] || more {
		t.Fatalf("fallback filtered offset/end differs: rows=%v more=%v err=%v", last, more, err)
	}
	// The explicitly pinned revision still excludes the later mode change.
	pinned, _, err := entry.ListCommits(context.Background(), plumbing.NewHash(ids[2]).String(), 1, 0, "exact file.txt")
	if err != nil || len(pinned) != 1 || pinned[0].Sha != ids[2] {
		t.Fatalf("pinned read changed: %v %v", pinned, err)
	}
}
