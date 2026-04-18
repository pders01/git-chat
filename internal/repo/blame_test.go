package repo

import (
	"strings"
	"testing"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestParseBlamePorcelain(t *testing.T) {
	const (
		sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	)

	tests := []struct {
		name    string
		input   string
		want    []*gitchatv1.BlameLine
		wantErr bool
	}{
		{
			name: "single commit single line",
			input: sha1 + " 1 1 1\n" +
				"author Alice\n" +
				"author-mail <alice@example.com>\n" +
				"author-time 1700000000\n" +
				"committer Alice\n" +
				"committer-mail <alice@example.com>\n" +
				"committer-time 1700000000\n" +
				"summary Initial commit\n" +
				"filename hello.go\n" +
				"\tpackage main\n",
			want: []*gitchatv1.BlameLine{
				{
					Text:        "package main",
					AuthorName:  "Alice",
					AuthorEmail: "alice@example.com",
					Date:        1700000000,
					CommitSha:   sha1,
				},
			},
		},
		{
			name: "multi-line same commit reuses metadata",
			input: sha1 + " 1 1 2\n" +
				"author Bob\n" +
				"author-mail <bob@test.org>\n" +
				"author-time 1700000001\n" +
				"committer Bob\n" +
				"committer-mail <bob@test.org>\n" +
				"committer-time 1700000001\n" +
				"summary Add lines\n" +
				"filename foo.go\n" +
				"\tfirst line\n" +
				sha1 + " 2 2\n" +
				"\tsecond line\n",
			want: []*gitchatv1.BlameLine{
				{
					Text:        "first line",
					AuthorName:  "Bob",
					AuthorEmail: "bob@test.org",
					Date:        1700000001,
					CommitSha:   sha1,
				},
				{
					Text:        "second line",
					AuthorName:  "Bob",
					AuthorEmail: "bob@test.org",
					Date:        1700000001,
					CommitSha:   sha1,
				},
			},
		},
		{
			name: "multiple commits",
			input: sha1 + " 1 1 1\n" +
				"author Alice\n" +
				"author-mail <alice@a.com>\n" +
				"author-time 1000000000\n" +
				"committer Alice\n" +
				"committer-mail <alice@a.com>\n" +
				"committer-time 1000000000\n" +
				"summary First\n" +
				"filename f.go\n" +
				"\tline one\n" +
				sha2 + " 2 2 1\n" +
				"author Bob\n" +
				"author-mail <bob@b.com>\n" +
				"author-time 2000000000\n" +
				"committer Bob\n" +
				"committer-mail <bob@b.com>\n" +
				"committer-time 2000000000\n" +
				"summary Second\n" +
				"filename f.go\n" +
				"\tline two\n",
			want: []*gitchatv1.BlameLine{
				{
					Text:        "line one",
					AuthorName:  "Alice",
					AuthorEmail: "alice@a.com",
					Date:        1000000000,
					CommitSha:   sha1,
				},
				{
					Text:        "line two",
					AuthorName:  "Bob",
					AuthorEmail: "bob@b.com",
					Date:        2000000000,
					CommitSha:   sha2,
				},
			},
		},
		{
			name:    "empty input",
			input:   "",
			want:    nil,
			wantErr: false,
		},
		{
			name:    "malformed header short SHA",
			input:   "abc 1 1 1\nauthor X\n\tcontent\n",
			wantErr: true,
		},
		{
			name: "tab-prefixed content strips only leading tab",
			input: sha1 + " 1 1 1\n" +
				"author Eve\n" +
				"author-mail <eve@e.com>\n" +
				"author-time 1700000000\n" +
				"committer Eve\n" +
				"committer-mail <eve@e.com>\n" +
				"committer-time 1700000000\n" +
				"summary Tabs\n" +
				"filename t.go\n" +
				"\t\tindented with extra tab\n",
			want: []*gitchatv1.BlameLine{
				{
					Text:        "\tindented with extra tab",
					AuthorName:  "Eve",
					AuthorEmail: "eve@e.com",
					Date:        1700000000,
					CommitSha:   sha1,
				},
			},
		},
		{
			name: "author-mail angle brackets stripped",
			input: sha1 + " 1 1 1\n" +
				"author Test\n" +
				"author-mail <user@host.io>\n" +
				"author-time 1700000000\n" +
				"committer Test\n" +
				"committer-mail <user@host.io>\n" +
				"committer-time 1700000000\n" +
				"summary Brackets\n" +
				"filename b.go\n" +
				"\tcontent\n",
			want: []*gitchatv1.BlameLine{
				{
					Text:        "content",
					AuthorName:  "Test",
					AuthorEmail: "user@host.io",
					Date:        1700000000,
					CommitSha:   sha1,
				},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseBlamePorcelain(strings.NewReader(tc.input))
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d lines, want %d", len(got), len(tc.want))
			}
			for i, w := range tc.want {
				g := got[i]
				if g.Text != w.Text {
					t.Errorf("line %d: Text = %q, want %q", i, g.Text, w.Text)
				}
				if g.AuthorName != w.AuthorName {
					t.Errorf("line %d: AuthorName = %q, want %q", i, g.AuthorName, w.AuthorName)
				}
				if g.AuthorEmail != w.AuthorEmail {
					t.Errorf("line %d: AuthorEmail = %q, want %q", i, g.AuthorEmail, w.AuthorEmail)
				}
				if g.Date != w.Date {
					t.Errorf("line %d: Date = %d, want %d", i, g.Date, w.Date)
				}
				if g.CommitSha != w.CommitSha {
					t.Errorf("line %d: CommitSha = %q, want %q", i, g.CommitSha, w.CommitSha)
				}
			}
		})
	}
}
