package repo

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-git/go-git/v5/plumbing"
)

func TestReaderHistoryMissingTreeIsNotAZeroStatsPage(t *testing.T) {
	for _, filter := range []string{"", "exact file.txt"} {
		t.Run("path="+filter, func(t *testing.T) {
			entry, ids := readerHistoryFixture(t)
			commit, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
			if err != nil {
				t.Fatal(err)
			}
			tree := commit.TreeHash.String()
			if err := os.Remove(filepath.Join(entry.Path, ".git", "objects", tree[:2], tree[2:])); err != nil {
				t.Fatal(err)
			}
			hideReaderGit(t, entry)
			rows, more, err := entry.ListCommits(context.Background(), ids[2], 1, 0, filter)
			if err == nil || len(rows) != 0 || more {
				t.Fatalf("missing tree certified stats/page: rows=%v more=%v err=%v", rows, more, err)
			}
		})
	}
}

func TestReaderHistoryMissingBlobIsNotPathAbsence(t *testing.T) {
	for _, filter := range []string{"", "exact file.txt"} {
		t.Run("path="+filter, func(t *testing.T) {
			entry, ids := readerHistoryFixture(t)
			commit, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
			if err != nil {
				t.Fatal(err)
			}
			tree, err := commit.Tree()
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
			hideReaderGit(t, entry)
			rows, more, err := entry.ListCommits(context.Background(), ids[2], 1, 0, filter)
			if err == nil || len(rows) != 0 || more {
				t.Fatalf("missing blob certified a page/path absence: rows=%v more=%v err=%v", rows, more, err)
			}
		})
	}
}

func TestReaderHistoryRootStatsAreNotAnEstimate(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	native, more, err := gitLogCommits(context.Background(), entry.Path, ids[0], 1, 0, "")
	if err != nil || len(native) != 1 || more || native[0].FilesChanged != 1 || native[0].Additions != 1 || native[0].Deletions != 0 {
		t.Fatalf("native root stats oracle: rows=%v more=%v err=%v", native, more, err)
	}
	hideReaderGit(t, entry)
	rows, more, err := entry.ListCommits(context.Background(), ids[0], 1, 0, "")
	if err != nil || len(rows) != 1 || more || rows[0].FilesChanged != native[0].FilesChanged ||
		rows[0].Additions != native[0].Additions || rows[0].Deletions != native[0].Deletions {
		t.Fatalf("fallback root counts differ: rows=%v more=%v err=%v", rows, more, err)
	}
}
