package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func TestReaderDiffEmptyFileMetadata(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	path := "empty.txt"
	if err := os.WriteFile(filepath.Join(entry.Path, path), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add(path); err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "Empty fixture", Email: "empty@example.invalid", When: time.Unix(1700000200, 0).UTC()}
	added, err := w.Commit("add empty file\n", &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Remove(path); err != nil {
		t.Fatal(err)
	}
	sig.When = sig.When.Add(time.Second)
	deleted, err := w.Commit("delete empty file\n", &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ id, status, mode string }{{added.String(), "added", "new file mode 100644"}, {deleted.String(), "deleted", "deleted file mode 100644"}} {
		for _, filter := range []string{path, ""} {
			patch, _, _, empty, files, err := entry.GetDiff(context.Background(), "", tc.id, filter, "", false, false, false)
			if err != nil || empty || !strings.Contains(patch, tc.mode) || strings.Contains(patch, "@@") || strings.Contains(patch, "/dev/null") {
				t.Fatalf("empty-file metadata lost: %q %v %v", patch, empty, err)
			}
			if filter == "" && (len(files) != 1 || files[0].Path != path || files[0].Status != tc.status || files[0].Additions != 0 || files[0].Deletions != 0) {
				t.Fatalf("empty-file listing lost: %v", files)
			}
			if filter != "" && len(files) != 0 {
				t.Fatalf("ordinary single-file response shape changed: %v", files)
			}
		}
	}
}

func TestReaderDiffTextAndModePreservesBoth(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	path := "exact file.txt"
	if err := os.WriteFile(filepath.Join(entry.Path, path), []byte("replacement\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(entry.Path, path), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add(path); err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "Mode fixture", Email: "mode@example.invalid", When: time.Unix(1700000300, 0).UTC()}
	id, err := w.Commit("text and mode\n", &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	for _, filter := range []string{path, ""} {
		patch, from, _, empty, files, err := entry.GetDiff(context.Background(), "", id.String(), filter, "", false, false, false)
		if err != nil || empty || from != ids[2] || !strings.Contains(patch, "old mode 100644\nnew mode 100755\n") || !strings.Contains(patch, "@@") || !strings.Contains(patch, "+replacement\n") {
			t.Fatalf("mixed mode/content evidence lost: %q %v %v", patch, empty, err)
		}
		if filter == "" && (len(files) != 1 || files[0].Additions != 1 || files[0].Deletions != 3) {
			t.Fatalf("mixed change stats lost: %v", files)
		}
		if filter != "" && len(files) != 0 {
			t.Fatalf("ordinary single-file response shape changed: %v", files)
		}
	}
}
