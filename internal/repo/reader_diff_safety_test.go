package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func TestReaderDiffModeOnlyIsNotEmpty(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"text", "text\n"}, {"empty", ""}, {"binary", "binary\x00content"},
		{"oversized", strings.Repeat("line\n", 110000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content := tc.content
			entry, _ := readerHistoryFixture(t)
			w, err := entry.repo.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			path := "line\nname\t\".sh"
			if err := os.WriteFile(filepath.Join(entry.Path, path), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(path); err != nil {
				t.Fatal(err)
			}
			sig := &object.Signature{Name: "Mode fixture", Email: "mode@example.invalid", When: time.Unix(1700000100, 0).UTC()}
			before, err := w.Commit("before mode\n", &git.CommitOptions{Author: sig, Committer: sig})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(filepath.Join(entry.Path, path), 0o755); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(path); err != nil {
				t.Fatal(err)
			}
			sig.When = sig.When.Add(time.Second)
			after, err := w.Commit("mode only\n", &git.CommitOptions{Author: sig, Committer: sig})
			if err != nil {
				t.Fatal(err)
			}
			oracle, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", before.String(), after.String(), "--", path}}).run(context.Background())
			if err != nil || !strings.Contains(string(oracle), "old mode 100644\nnew mode 100755\n") {
				t.Fatalf("invalid owned mode oracle: %q %v", oracle, err)
			}
			for _, filter := range []string{path, ""} {
				patch, from, to, empty, files, err := entry.GetDiff(context.Background(), "", after.String(), filter, "", false, false, false)
				if err != nil || empty || from != before.String() || to != after.String() {
					t.Fatalf("mode change lost: empty=%v from=%s to=%s err=%v", empty, from, to, err)
				}
				if !strings.Contains(patch, "old mode 100644\nnew mode 100755\n") || strings.Contains(patch, "@@") || strings.Count(patch, "diff --git ") != 1 {
					t.Fatalf("mode-only evidence/quoting differs: %q", patch)
				}
				if strings.Contains(patch, "line\nname") {
					t.Fatalf("literal path injected a patch line: %q", patch)
				}
				if len(files) != 1 || files[0].Path != path || files[0].Status != "modified" || files[0].Additions != 0 || files[0].Deletions != 0 {
					t.Fatalf("changed-file evidence lost: %v", files)
				}
			}
			reverse, _, _, reverseEmpty, _, err := entry.GetDiff(context.Background(), after.String(), before.String(), path, "", false, false, false)
			if err != nil || reverseEmpty || !strings.Contains(reverse, "old mode 100755\nnew mode 100644\n") || strings.Contains(reverse, "@@") {
				t.Fatalf("reverse mode change lost: %q %v %v", reverse, reverseEmpty, err)
			}
			patch, _, _, empty, _, err := entry.GetDiff(context.Background(), after.String(), after.String(), path, "", false, false, false)
			if err != nil || !empty || patch != "" {
				t.Fatalf("same-mode same-object no longer empty: %q %v %v", patch, empty, err)
			}
		})
	}
}

func TestReaderDiffMissingBlobDoesNotInventAddition(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	parent, err := entry.repo.CommitObject(plumbing.NewHash(ids[1]))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := parent.Tree()
	if err != nil {
		t.Fatal(err)
	}
	file, err := tree.FindEntry("exact file.txt")
	if err != nil {
		t.Fatal(err)
	}
	hash := file.Hash.String()
	if err := os.Remove(filepath.Join(entry.Path, ".git", "objects", hash[:2], hash[2:])); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"exact file.txt", ""} {
		patch, _, _, empty, files, err := entry.GetDiff(context.Background(), ids[1], ids[2], path, "", false, false, false)
		if err == nil || patch != "" || empty || len(files) != 0 {
			t.Fatalf("broken blob became patch/emptiness: patch=%q empty=%v files=%v err=%v", patch, empty, files, err)
		}
	}
}
