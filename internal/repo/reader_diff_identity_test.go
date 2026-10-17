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
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func identityCommit(t *testing.T, entry *Entry, message string, stamp int64) string {
	t.Helper()
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "Identity fixture", Email: "identity@example.invalid", When: time.Unix(stamp, 0).UTC()}
	id, err := w.Commit(message, &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	return id.String()
}

func TestReaderDiffRenameIdentityAndRoundTrip(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"same-text", "same\n", "same\n"}, {"empty", "", ""},
		{"edge-space", "same\n", "same\n"}, {"mode-and-rename", "same\n", "same\n"},
		{"modified", strings.Repeat("stable\n", 10) + "old\n", strings.Repeat("stable\n", 10) + "new\n"},
		{"same-binary", "binary\x00data", "binary\x00data"},
		{"same-oversized", strings.Repeat("line\n", 110000), strings.Repeat("line\n", 110000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, _ := readerHistoryFixture(t)
			w, err := entry.repo.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			oldPath, newPath := "old\nquoted\".txt", "new\nquoted\".txt"
			if tc.name == "edge-space" {
				oldPath, newPath = " old name ", " new name "
			}
			if err := os.WriteFile(filepath.Join(entry.Path, oldPath), []byte(tc.before), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(oldPath); err != nil {
				t.Fatal(err)
			}
			from := identityCommit(t, entry, "before rename\n", 1700003000)
			if _, err := w.Remove(oldPath); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(entry.Path, newPath), []byte(tc.after), 0o644); err != nil {
				t.Fatal(err)
			}
			if tc.name == "mode-and-rename" {
				if err := os.Chmod(filepath.Join(entry.Path, newPath), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := w.Add(newPath); err != nil {
				t.Fatal(err)
			}
			to := identityCommit(t, entry, "after rename\n", 1700003001)
			target, err := entry.repo.CommitObject(plumbing.NewHash(to))
			if err != nil {
				t.Fatal(err)
			}
			native, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", "-M", from, to}}).run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(native), "rename from ") {
				t.Fatalf("owned native fixture did not detect rename: %q", native)
			}
			got, err := applyReaderPatch(t, entry, from, string(native))
			if err != nil || got != target.TreeHash.String() {
				t.Fatalf("invalid native rename oracle: %s %v", got, err)
			}
			for _, filter := range []string{newPath, ""} {
				hint := ""
				if filter != "" {
					hint = oldPath
				}
				patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, filter, hint, true, false, false)
				if err != nil || empty || patch == "" {
					t.Errorf("rename became no changes: scope=%q empty=%v err=%v", filter, empty, err)
					continue
				}
				if !strings.Contains(patch, "rename from ") || !strings.Contains(patch, "rename to ") {
					t.Errorf("missing literal rename identity: %q", patch)
				}
				got, err := applyReaderPatch(t, entry, from, patch)
				if err != nil || got != target.TreeHash.String() {
					t.Errorf("rename patch changed identity/bytes: tree=%s want=%s err=%v", got, target.TreeHash, err)
				}
				if len(files) != 1 || files[0].Status != "renamed" || files[0].Path != newPath || files[0].FromPath != oldPath {
					t.Errorf("rename metadata lost: %v", files)
				}
			}
		})
	}
}

func TestReaderDiffFileTypeRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name, before, after   string
		beforeLink, afterLink bool
	}{
		{"same-blob-to-link", "owned-target", "owned-target", false, true},
		{"same-blob-to-file", "owned-target", "owned-target", true, false},
		{"different-blob-to-link", "old\ntext\n", "owned-target", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, _ := readerHistoryFixture(t)
			w, err := entry.repo.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			path := "kind.txt"
			write := func(content string, link bool) {
				t.Helper()
				if link {
					if err := os.Symlink(content, filepath.Join(entry.Path, path)); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.WriteFile(filepath.Join(entry.Path, path), []byte(content), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := w.Add(path); err != nil {
					t.Fatal(err)
				}
			}
			write(tc.before, tc.beforeLink)
			from := identityCommit(t, entry, "before type\n", 1700003100)
			if _, err := w.Remove(path); err != nil {
				t.Fatal(err)
			}
			write(tc.after, tc.afterLink)
			to := identityCommit(t, entry, "after type\n", 1700003101)
			target, err := entry.repo.CommitObject(plumbing.NewHash(to))
			if err != nil {
				t.Fatal(err)
			}
			native, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", from, to}}).run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			got, err := applyReaderPatch(t, entry, from, string(native))
			if err != nil || got != target.TreeHash.String() {
				t.Fatalf("invalid native type oracle: %s %v", got, err)
			}
			numstat, err := (gitCmd{repoDir: entry.Path, args: []string{"diff", "--no-ext-diff", "--no-textconv", "--numstat", from, to, "--", path}}).run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			var wantAdds, wantDels int32
			for _, line := range strings.Split(strings.TrimSuffix(string(numstat), "\n"), "\n") {
				var a, d int32
				if n, err := fmt.Sscanf(line, "%d\t%d", &a, &d); n != 2 || err != nil {
					t.Fatalf("invalid native type stats: %q %v", line, err)
				}
				wantAdds += a
				wantDels += d
			}
			for _, filter := range []string{path, ""} {
				patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, filter, "", false, false, false)
				if err != nil || empty {
					t.Errorf("type change lost: %v %v", empty, err)
					continue
				}
				got, err := applyReaderPatch(t, entry, from, patch)
				if err != nil || got != target.TreeHash.String() {
					t.Errorf("type patch differs: tree=%s want=%s err=%v patch=%q", got, target.TreeHash, err, patch)
				}
				if len(files) != 1 || files[0].Status != "modified" || files[0].Additions != wantAdds || files[0].Deletions != wantDels {
					t.Errorf("type stats/identity differ: files=%v want=%d/%d", files, wantAdds, wantDels)
				}
				if strings.Count(patch, "diff --git ") != 2 {
					t.Errorf("type transition must preserve delete/create identity: %q", patch)
				}
			}
		})
	}
}

func TestReaderDiffUnsupportedRootGitlinkRefuses(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	base, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := base.Tree()
	if err != nil {
		t.Fatal(err)
	}
	tree.Entries = append(tree.Entries, object.TreeEntry{Name: "unsupported-link", Mode: filemode.Submodule, Hash: plumbing.NewHash(strings.Repeat("1", 40))})
	encoded := entry.repo.Storer.NewEncodedObject()
	if err := tree.Encode(encoded); err != nil {
		t.Fatal(err)
	}
	treeHash, err := entry.repo.Storer.SetEncodedObject(encoded)
	if err != nil {
		t.Fatal(err)
	}
	root := &object.Commit{Author: base.Author, Committer: base.Committer, TreeHash: treeHash, Message: "root with gitlink\n"}
	encoded = entry.repo.Storer.NewEncodedObject()
	if err := root.Encode(encoded); err != nil {
		t.Fatal(err)
	}
	id, err := entry.repo.Storer.SetEncodedObject(encoded)
	if err != nil {
		t.Fatal(err)
	}
	patch, _, _, empty, files, err := entry.GetDiff(context.Background(), "", id.String(), "", "", false, false, false)
	if err == nil || !strings.Contains(err.Error(), "unsupported diff entry mode") || patch != "" || empty || len(files) != 0 {
		t.Fatalf("root gitlink silently omitted: patchBytes=%d empty=%v files=%d err=%v", len(patch), empty, len(files), err)
	}
}
