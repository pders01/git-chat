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
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Small fixtures exercise limits safely: the pre-fix largest matrix is only
// about 8 MiB, not a deliberate memory-exhaustion or hostile-host stress test.
func readerDiffWorkFixture(t *testing.T, files, lines int) (*Entry, string, string, []string) {
	t.Helper()
	entry, original := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	commit := func(text string, stamp int64) string {
		t.Helper()
		for i := 0; i < files; i++ {
			path := fmt.Sprintf("work-%02d.txt", i)
			if err := os.WriteFile(filepath.Join(entry.Path, path), []byte(strings.Repeat(text+"\n", lines)), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(path); err != nil {
				t.Fatal(err)
			}
		}
		sig := &object.Signature{Name: "Work fixture", Email: "work@example.invalid", When: time.Unix(stamp, 0).UTC()}
		id, err := w.Commit("work fixture\n", &git.CommitOptions{Author: sig, Committer: sig})
		if err != nil {
			t.Fatal(err)
		}
		return id.String()
	}
	from := commit("old", 1700002000)
	to := commit("new", 1700002001)
	return entry, from, to, original
}

func TestReaderDiffWorkPerFileRefusesBeforePublishing(t *testing.T) {
	entry, from, to, original := readerDiffWorkFixture(t, 1, 1024)
	for _, filter := range []string{"work-00.txt", ""} {
		patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, filter, "", false, false, false)
		if err == nil || !strings.Contains(err.Error(), "diff work limit") || patch != "" || empty || len(files) != 0 {
			t.Fatalf("oversize matrix certified patch/emptiness: patchBytes=%d empty=%v files=%d err=%v", len(patch), empty, len(files), err)
		}
	}
	patch, _, _, empty, _, err := entry.GetDiff(context.Background(), original[1], original[2], "exact file.txt", "", false, false, false)
	if err != nil || empty || !strings.Contains(patch, "+three") {
		t.Fatalf("refusal poisoned later small pinned read: %q %v %v", patch, empty, err)
	}
}

func TestReaderDiffWorkAggregateRefusesWithoutPartialResult(t *testing.T) {
	entry, from, to, _ := readerDiffWorkFixture(t, 18, 512)
	// Every file fits by itself. Whole-read statistics + rendering must share
	// one allowance, not silently reset it for each stage/file.
	patch, _, _, empty, _, err := entry.GetDiff(context.Background(), from, to, "work-00.txt", "", false, false, false)
	if err != nil || empty || patch == "" {
		t.Fatalf("individual file should fit: %v %v", empty, err)
	}
	patch, _, _, empty, files, err := entry.GetDiff(context.Background(), from, to, "", "", false, false, false)
	if err == nil || !strings.Contains(err.Error(), "diff work limit") || patch != "" || empty || len(files) != 0 {
		t.Fatalf("aggregate work returned partial success: patchBytes=%d empty=%v files=%d err=%v", len(patch), empty, len(files), err)
	}
}
