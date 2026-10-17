package repo

import (
	"context"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestReaderHistoryFallbackPrettyMessageParity(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	messages := []string{
		"subject\n\n  body  \n\n", "\n\n  subject  \nnext subject line  \n\n\n  body\n\n",
		"subject\r\n\r\n body\r\n", "subject\n \t \n  body\n", "one\ntwo\n",
		"subject\n\n\n\n", "  \n\n", "subject without newline", "subject\n\n \t\nbody",
		"literal \x01\x02\x1e\x1f\n\n body \x01\x02\x1e\x1f  \n",
		"subject\v\f\n\n \t\n body\n", "\tfirst \t\n\tsecond \t\n\nbody",
		"\u00a0\nsubject \u00a0\n\n body \u00a0\n", "subject\n\nbody without final newline",
	}
	var oracles []*gitchatv1.CommitEntry
	for i, message := range messages {
		sig := &object.Signature{Name: "Message fixture", Email: "message@example.invalid", When: time.Unix(1700000100+int64(i), 0).UTC()}
		id, err := w.Commit(message, &git.CommitOptions{Author: sig, Committer: sig, AllowEmptyCommits: true})
		if err != nil {
			t.Fatal(err)
		}
		rows, _, err := gitLogCommits(context.Background(), entry.Path, id.String(), 1, 0, "")
		if err != nil || len(rows) != 1 {
			t.Fatalf("native pretty oracle %d: %v %v", i, rows, err)
		}
		oracles = append(oracles, rows[0])
	}
	hideReaderGit(t, entry)
	for i, want := range oracles {
		rows, _, err := entry.ListCommits(context.Background(), want.Sha, 1, 0, "")
		if err != nil || len(rows) != 1 {
			t.Fatalf("fallback message %d: %v %v", i, rows, err)
		}
		if rows[0].Message != want.Message || rows[0].Body != want.Body {
			t.Errorf("message %d differs: subject=%q want=%q body=%q want=%q", i, rows[0].Message, want.Message, rows[0].Body, want.Body)
		}
	}
}

func TestReaderHistoryFallbackMergeRefusesRatherThanChangingSemantics(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	main, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
	if err != nil {
		t.Fatal(err)
	}
	save := func(message string, parents []plumbing.Hash, when int64) plumbing.Hash {
		t.Helper()
		sig := object.Signature{Name: "Merge fixture", Email: "merge@example.invalid", When: time.Unix(when, 0).UTC()}
		c := &object.Commit{Author: sig, Committer: sig, Message: message, TreeHash: main.TreeHash, ParentHashes: parents}
		encoded := entry.repo.Storer.NewEncodedObject()
		if err := c.Encode(encoded); err != nil {
			t.Fatal(err)
		}
		id, err := entry.repo.Storer.SetEncodedObject(encoded)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	side := save("same change on side\n", []plumbing.Hash{plumbing.NewHash(ids[1])}, 1700000100)
	merge := save("merge identical trees\n", []plumbing.Hash{main.Hash, side}, 1700000101)
	later := save("linear child after merge\n", []plumbing.Hash{merge}, 1700000102)
	tip := save("linear tip after merge\n", []plumbing.Hash{later}, 1700000103)
	// Native default path simplification drops the TREESAME merge/side history.
	native, _, err := gitLogCommits(context.Background(), entry.Path, merge.String(), 20, 0, "exact file.txt")
	if err != nil || len(native) != 3 || native[0].Sha != ids[2] {
		t.Fatalf("native simplified-path oracle: %v %v", native, err)
	}
	all, _, err := gitLogCommits(context.Background(), entry.Path, merge.String(), 20, 0, "")
	if err != nil || len(all) != 5 || all[0].Sha != merge.String() || len(all[0].ParentShas) != 2 {
		t.Fatalf("native merge oracle: %v %v", all, err)
	}
	hideReaderGit(t, entry)
	for _, ref := range []plumbing.Hash{merge, tip} {
		for _, filter := range []string{"", "exact file.txt"} {
			rows, more, err := entry.ListCommits(context.Background(), ref.String(), 1, 0, filter)
			if err == nil || !strings.Contains(err.Error(), "non-linear") || len(rows) != 0 || more {
				t.Fatalf("fallback invented nonlinear parity: rows=%v more=%v err=%v", rows, more, err)
			}
		}
	}
	// A linear pinned ancestor remains usable; this is not a global cache poison.
	rows, _, err := entry.ListCommits(context.Background(), ids[2], 1, 0, "exact file.txt")
	if err != nil || len(rows) != 1 || rows[0].Sha != ids[2] {
		t.Fatalf("linear pinned read failed: %v %v", rows, err)
	}
}
