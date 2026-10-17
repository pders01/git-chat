package repo

import (
	"context"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	git "github.com/go-git/go-git/v5"
)

func TestReaderHistoryShallowRefusesIncompleteReads(t *testing.T) {
	source, ids := readerHistoryFixture(t)
	path := filepath.Join(t.TempDir(), "shallow")
	sourceURL := (&url.URL{Scheme: "file", Path: source.Path}).String()
	if _, err := (gitCmd{repoDir: source.Path, args: []string{"clone", "--quiet", "--depth=1", sourceURL, path}}).run(context.Background()); err != nil {
		t.Fatal(err)
	}
	r, err := git.PlainOpen(path)
	if err != nil {
		t.Fatal(err)
	}
	boundary, err := r.Storer.Shallow()
	if err != nil || len(boundary) != 1 {
		t.Fatalf("owned clone not shallow: %v %v", boundary, err)
	}
	entry := &Entry{Path: path, DefaultBranch: "main", repo: r}
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "fallback" {
				hideReaderGit(t, entry)
			}
			rows, more, err := entry.ListCommits(context.Background(), ids[2], 2, 0, "")
			if err == nil || !strings.Contains(err.Error(), "shallow") || len(rows) != 0 || more {
				t.Fatalf("shallow page certified roots/end: rows=%v more=%v err=%v", rows, more, err)
			}
			for _, filter := range []string{"", "exact file.txt"} {
				patch, _, _, empty, files, err := entry.GetDiff(context.Background(), ids[2], ids[2], filter, "", false, false, false)
				if err == nil || !strings.Contains(err.Error(), "shallow") || patch != "" || empty || len(files) != 0 {
					t.Fatalf("shallow diff certified: %q %v %v %v", patch, empty, files, err)
				}
			}
		})
	}
}
