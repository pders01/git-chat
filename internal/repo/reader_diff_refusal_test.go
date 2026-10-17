package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func TestReaderDiffRenameHintCannotInventIdentity(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"old.txt", "new.txt"} {
		if err := os.WriteFile(filepath.Join(entry.Path, path), []byte(path+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Add(path); err != nil {
			t.Fatal(err)
		}
	}
	from := identityCommit(t, entry, "before invalid hint\n", 1700003200)
	if err := os.WriteFile(filepath.Join(entry.Path, "new.txt"), []byte("replacement\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add("new.txt"); err != nil {
		t.Fatal(err)
	}
	to := identityCommit(t, entry, "after invalid hint\n", 1700003201)
	for _, hint := range []string{"old.txt", "missing.txt"} {
		patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, "new.txt", hint, false, false, false)
		if err == nil || !strings.Contains(err.Error(), "rename hint") || patch != "" || empty || len(files) != 0 {
			t.Fatalf("arbitrary cross-path comparison called rename: %q %v %v", patch, empty, err)
		}
	}
	patch, _, _, empty, _, err := entry.GetDiff(context.Background(), from, to, "new.txt", "", false, false, false)
	if err != nil || empty || !strings.Contains(patch, "+replacement") {
		t.Fatalf("invalid hint poisoned ordinary exact read: %q %v %v", patch, empty, err)
	}
}

func TestReaderDiffTextEncodingRefusesWithoutReplacement(t *testing.T) {
	for _, tc := range []struct {
		name, path, content string
		allowed             bool
	}{
		{"invalid-text", "proof.txt", "bad \xff text\n", false},
		{"invalid-path", "bad-\xff.txt", "valid\n", false},
		{"literal-replacement-character", "proof.txt", "valid \ufffd text\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, ids := readerHistoryFixture(t)
			w, err := entry.repo.Worktree()
			if err != nil {
				t.Fatal(err)
			}
			var to string
			if tc.name == "invalid-path" {
				// This Git object name is not representable by the host filesystem.
				// Build owned objects directly, without a filesystem retry/workaround.
				encoded := entry.repo.Storer.NewEncodedObject()
				encoded.SetType(plumbing.BlobObject)
				writer, err := encoded.Writer()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := writer.Write([]byte(tc.content)); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				blobHash, err := entry.repo.Storer.SetEncodedObject(encoded)
				if err != nil {
					t.Fatal(err)
				}
				tree := &object.Tree{Entries: []object.TreeEntry{{Name: tc.path, Mode: filemode.Regular, Hash: blobHash}}}
				encoded = entry.repo.Storer.NewEncodedObject()
				if err := tree.Encode(encoded); err != nil {
					t.Fatal(err)
				}
				treeHash, err := entry.repo.Storer.SetEncodedObject(encoded)
				if err != nil {
					t.Fatal(err)
				}
				base, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
				if err != nil {
					t.Fatal(err)
				}
				commit := &object.Commit{Author: base.Author, Committer: base.Committer, TreeHash: treeHash, ParentHashes: []plumbing.Hash{base.Hash}, Message: "opaque path\n"}
				encoded = entry.repo.Storer.NewEncodedObject()
				if err := commit.Encode(encoded); err != nil {
					t.Fatal(err)
				}
				id, err := entry.repo.Storer.SetEncodedObject(encoded)
				if err != nil {
					t.Fatal(err)
				}
				to = id.String()
			} else {
				if err := os.WriteFile(filepath.Join(entry.Path, tc.path), []byte(tc.content), 0o644); err != nil {
					t.Fatal(err)
				}
				if _, err := w.Add(tc.path); err != nil {
					t.Fatal(err)
				}
				to = identityCommit(t, entry, "text encoding\n", 1700003300)
			}
			for _, filter := range []string{tc.path, ""} {
				patch, _, _, empty, files, err := entry.GetDiff(context.Background(), ids[2], to, filter, "", false, false, false)
				if tc.allowed {
					if err != nil || empty || !strings.Contains(patch, tc.content) {
						t.Fatalf("valid U+FFFD refused/replaced: %q %v %v", patch, empty, err)
					}
				} else {
					if err == nil || !strings.Contains(err.Error(), "UTF-8") || patch != "" || empty || len(files) != 0 {
						t.Fatalf("unencodable diff published/replaced: bytes=%d empty=%v err=%v", len(patch), empty, err)
					}
				}
			}
		})
	}
}
