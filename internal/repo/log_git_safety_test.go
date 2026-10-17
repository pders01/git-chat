package repo

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func TestNativeLogLiteralControlsAndBody(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	// These are legal commit-message bytes, not record delimiters. Include a
	// complete old-format forged row to detect invented history, not just errors.
	forged := "\x01" + strings.Repeat("a", 40) + "\x1fForged\x1fforged@example.invalid\x1f1700000000\x1f\x1fforged\x02"
	subject := "literal \x01 \x02 \x1e \x1f subject"
	body := "  indented café 🪴\n\n" + forged + "\n tail spaces  \n\n"
	sig := &object.Signature{Name: "Fixture \x1f name", Email: "fixture@example.invalid", When: time.Unix(1700000100, 0).UTC()}
	id, err := w.Commit(subject+"\n\n"+body, &git.CommitOptions{Author: sig, Committer: sig, AllowEmptyCommits: true})
	if err != nil {
		t.Fatal(err)
	}
	oracle, err := (gitCmd{repoDir: entry.Path, args: []string{"log", id.String(), "-1", "--no-color", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=format:%s%x00%b"}}).run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	parts := bytes.SplitN(oracle, []byte{0}, 2)
	if len(parts) != 2 {
		t.Fatal("invalid owned oracle")
	}
	rows, more, err := gitLogCommits(context.Background(), entry.Path, id.String(), 10, 0, "")
	if err != nil || more || len(rows) != 4 {
		t.Fatalf("native literal metadata: rows=%d more=%v err=%v", len(rows), more, err)
	}
	if rows[0].Sha != id.String() || rows[0].Message != string(parts[0]) || rows[0].Body != string(parts[1]) || rows[0].AuthorName != sig.Name {
		t.Fatalf("native metadata changed literal fields: %v", rows[0])
	}
	if len(rows[0].ParentShas) != 1 || rows[0].ParentShas[0] != ids[2] {
		t.Fatal("real parent identity changed")
	}
	hits, err := gitLogGrepCommits(context.Background(), entry.Path, "grep", "indented", 10)
	if err != nil || len(hits) != 1 || hits[0].Sha != id.String() || hits[0].Body != string(parts[1]) {
		t.Fatalf("grep parser diverged: %v %v", hits, err)
	}
}

func TestNativeLogBodyWhitespace(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	body := "  leading spaces\n\n trailing spaces  \n\n"
	sig := &object.Signature{Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(1700000100, 0).UTC()}
	id, err := w.Commit("body fixture\n\n"+body, &git.CommitOptions{Author: sig, Committer: sig, AllowEmptyCommits: true})
	if err != nil {
		t.Fatal(err)
	}
	rows, _, err := gitLogCommits(context.Background(), entry.Path, id.String(), 1, 0, "")
	if err != nil || len(rows) != 1 || rows[0].Body != body {
		t.Fatalf("body whitespace lost: %v %v", rows, err)
	}
}

func TestNativeLogInvalidDataNeverFallsBack(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	bin := t.TempDir()
	fake := filepath.Join(bin, "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf garbage\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	rows, more, err := entry.ListCommits(context.Background(), "HEAD", 2, 0, "")
	if err == nil || len(rows) != 0 || more {
		t.Fatalf("invalid native output fell back: rows=%d more=%v err=%v", len(rows), more, err)
	}
}

func TestNativeLogMetadataBudget(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(1700000100, 0).UTC()}
	id, err := w.Commit("large\n\n"+strings.Repeat("x", 8*1024*1024+1), &git.CommitOptions{Author: sig, Committer: sig, AllowEmptyCommits: true})
	if err != nil {
		t.Fatal(err)
	}
	rows, more, err := entry.ListCommits(context.Background(), id.String(), 1, 0, "")
	if err == nil || len(rows) != 0 || more {
		t.Fatalf("oversized native metadata accepted/fell back: rows=%d more=%v err=%v", len(rows), more, err)
	}
}

func TestNativeLogStatPathsCannotInjectRecords(t *testing.T) {
	entry, _ := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	name := "file\x01\x02\x1f\tline\nname.txt"
	if err := os.WriteFile(filepath.Join(entry.Path, name), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add(name); err != nil {
		t.Fatal(err)
	}
	sig := &object.Signature{Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(1700000100, 0).UTC()}
	id, err := w.Commit("literal stat filename\n", &git.CommitOptions{Author: sig, Committer: sig})
	if err != nil {
		t.Fatal(err)
	}
	rows, _, err := gitLogCommits(context.Background(), entry.Path, id.String(), 1, 0, name)
	if err != nil || len(rows) != 1 || rows[0].Sha != id.String() || rows[0].FilesChanged != 1 || rows[0].Additions != 2 || rows[0].Deletions != 0 {
		t.Fatalf("stat path corrupted metadata/counts: %v %v", rows, err)
	}
}

func logTestRecord(sha, body, stats string) string {
	return "\x00" + strings.Join([]string{sha, "Fixture", "fixture@example.invalid", "1700000000", "", "subject", body}, "\x00") + "\x00\x00" + stats
}
func TestParseGitLogStrictFraming(t *testing.T) {
	sha := strings.Repeat("a", 40)
	one := logTestRecord(sha, "  literal\x01\x02\x1f\n\n", "\n1\t0\tfile\nname\x00")
	rows, err := parseGitLog(strings.NewReader(one), 1)
	if err != nil || len(rows) != 1 || rows[0].Body != "  literal\x01\x02\x1f\n\n" || rows[0].Additions != 1 {
		t.Fatalf("valid framed record: %v %v", rows, err)
	}
	two := logTestRecord(strings.Repeat("b", 64), "", "\n-\t-\tbinary\x00")
	rows, err = parseGitLog(strings.NewReader(one+two), 2)
	if err != nil || len(rows) != 2 || rows[1].FilesChanged != 1 || rows[1].Additions != 0 {
		t.Fatalf("valid mixed IDs/binary stats: %v %v", rows, err)
	}
	bad := []string{"garbage", one[:len(one)-1], strings.TrimPrefix(one, "\x00"), one + "garbage", one + two,
		strings.Replace(one, sha, "short", 1), strings.Replace(one, "1700000000", "not-time", 1), strings.Replace(one, "1700000000", "01", 1),
		strings.Replace(one, "1\t0\t", "-1\t0\t", 1), strings.Replace(one, "1\t0\t", "2147483648\t0\t", 1),
		strings.Replace(one, "1\t0\t", "-\t0\t", 1), strings.Replace(one, "literal", "bad\xff", 1)}
	for i, raw := range bad {
		rows, err := parseGitLog(strings.NewReader(raw), 1)
		if err == nil || len(rows) != 0 {
			t.Errorf("malformed case %d returned rows=%v err=%v", i, rows, err)
		}
	}
	rows, err = parseGitLog(iotest.ErrReader(errors.New("fixture read failure")), 1)
	if err == nil || len(rows) != 0 {
		t.Fatal("reader failure accepted")
	}
}
