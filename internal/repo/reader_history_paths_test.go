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
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestReaderHistoryLiteralSparsePathsAndFilteredStats(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	// A literal bracketed name and a separate file matched by the equivalent
	// glob must stay distinct in both engines. Whitespace and LF are also data.
	target := "nested/ exact \tline\n[x].txt "
	sibling := "nested/ exact \tline\nx.txt "
	if err := os.MkdirAll(filepath.Join(entry.Path, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := range 4 {
		if i == 0 || i == 2 {
			if err := os.WriteFile(filepath.Join(entry.Path, target), []byte(strings.Repeat("target\n", i+1)), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(target); err != nil {
				t.Fatal(err)
			}
		}
		if i < 3 {
			if err := os.WriteFile(filepath.Join(entry.Path, sibling), []byte(strings.Repeat("sibling\n", (i+1)*5)), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := w.Add(sibling); err != nil {
				t.Fatal(err)
			}
		} else if _, err := w.Remove(target); err != nil {
			t.Fatal(err)
		}
		sig := &object.Signature{Name: "Path fixture", Email: "path@example.invalid", When: time.Unix(1700000010+int64(i), 0).UTC()}
		id, err := w.Commit("path change\n", &git.CommitOptions{Author: sig, Committer: sig})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id.String())
	}
	type query struct {
		path          string
		ref           string
		limit, offset int
		want          []string
	}
	queries := []query{
		{target, ids[3], 2, 0, []string{ids[3], ids[2]}},
		{target, ids[3], 2, 2, []string{ids[0]}},
		{target, ids[2], 2, 0, []string{ids[2], ids[0]}},
		{"nested", ids[3], 10, 0, []string{ids[3], ids[2], ids[1], ids[0]}},
		{"nested/absent", ids[3], 2, 0, nil},
	}
	type answer struct {
		rows []*gitchatv1.CommitEntry
		more bool
	}
	oracles := make([]answer, len(queries))
	for i, q := range queries {
		rows, more, err := gitLogCommits(context.Background(), entry.Path, q.ref, q.limit, q.offset, q.path)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != len(q.want) {
			t.Fatalf("native literal-path oracle returned %d rows, want %d", len(rows), len(q.want))
		}
		for j := range rows {
			if rows[j].Sha != q.want[j] {
				t.Fatalf("native literal-path row %d differs", j)
			}
		}
		oracles[i] = answer{rows, more}
	}
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "fallback" {
				hideReaderGit(t, entry)
			}
			for i, q := range queries {
				rows, more, err := entry.ListCommits(context.Background(), q.ref, q.limit, q.offset, q.path)
				want := oracles[i]
				if err != nil || len(rows) != len(want.rows) || more != want.more {
					t.Fatalf("query %d: rows=%v more=%v err=%v", i, rows, more, err)
				}
				for j, row := range rows {
					oracle := want.rows[j]
					if row.Sha != oracle.Sha || row.FilesChanged != oracle.FilesChanged || row.Additions != oracle.Additions || row.Deletions != oracle.Deletions {
						t.Errorf("query %d row %d differs from native membership/filtered counts: got=%v want=%v", i, j, row, oracle)
					}
				}
			}
		})
	}
}
