package repo

import (
	"context"
	"strings"
	"testing"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

func TestReaderHistoryFallbackEncodingRefusal(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	base, err := entry.repo.CommitObject(plumbing.NewHash(ids[2]))
	if err != nil {
		t.Fatal(err)
	}
	save := func(encoding, message string) string {
		t.Helper()
		c := &object.Commit{Author: base.Author, Committer: base.Committer, TreeHash: base.TreeHash, ParentHashes: []plumbing.Hash{base.Hash}, Encoding: object.MessageEncoding(encoding), Message: message}
		encoded := entry.repo.Storer.NewEncodedObject()
		if err := c.Encode(encoded); err != nil {
			t.Fatal(err)
		}
		id, err := entry.repo.Storer.SetEncodedObject(encoded)
		if err != nil {
			t.Fatal(err)
		}
		return id.String()
	}
	latin := save("ISO-8859-1", "caf\u00e9\n\n body \n")
	native, _, err := gitLogCommits(context.Background(), entry.Path, latin, 1, 0, "")
	if err != nil || len(native) != 1 || native[0].Message == "caf\u00e9" {
		t.Fatalf("native transcoding oracle did not distinguish declared encoding: %v %v", native, err)
	}
	utf := save("UTF-8", "caf\u00e9\n\n body \n")
	utfAlias := save("utf8", "caf\u00e9\n\n body \n")
	aliasRows, _, err := gitLogCommits(context.Background(), entry.Path, utfAlias, 1, 0, "")
	if err != nil || len(aliasRows) != 1 || aliasRows[0].Message != "caf\u00e9" {
		t.Fatalf("native UTF-8 alias oracle failed: %v %v", aliasRows, err)
	}
	invalid := save("UTF-8", "bad \xff text\n")
	nul := save("UTF-8", "subject\n\n body\x00forged\n")
	hideReaderGit(t, entry)
	for _, ref := range []string{latin, invalid, nul} {
		rows, more, err := entry.ListCommits(context.Background(), ref, 1, 0, "")
		if err == nil || !strings.Contains(err.Error(), "fallback commit text") || len(rows) != 0 || more {
			t.Errorf("unsupported/invalid fallback metadata published: rows=%v more=%v err=%v", rows, more, err)
		}
	}
	for _, ref := range []string{utf, utfAlias} {
		rows, _, err := entry.ListCommits(context.Background(), ref, 1, 0, "")
		if err != nil || len(rows) != 1 || rows[0].Message != "caf\u00e9" || rows[0].Body != " body \n" {
			t.Fatalf("valid UTF-8 fallback no longer readable: %v %v", rows, err)
		}
	}
}
