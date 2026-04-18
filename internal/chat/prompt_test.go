package chat

import (
	"os"
	"testing"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestParseMarkerAttrs(t *testing.T) {
	tests := []struct {
		name             string
		attrs            string
		wantFrom, wantTo string
		wantPath         string
	}{
		{
			name:  "empty string",
			attrs: "",
		},
		{
			name:     "all three bare values",
			attrs:    "from=abc to=def path=file.go",
			wantFrom: "abc",
			wantTo:   "def",
			wantPath: "file.go",
		},
		{
			name:     "quoted value with spaces",
			attrs:    `from="multi word" to=HEAD`,
			wantFrom: "multi word",
			wantTo:   "HEAD",
		},
		{
			name:     "path only",
			attrs:    "path=file.go",
			wantPath: "file.go",
		},
		{
			name:     "unknown keys ignored",
			attrs:    "from=a unknown=ignored to=b",
			wantFrom: "a",
			wantTo:   "b",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			from, to, path := parseMarkerAttrs(tt.attrs)
			if from != tt.wantFrom {
				t.Errorf("from = %q, want %q", from, tt.wantFrom)
			}
			if to != tt.wantTo {
				t.Errorf("to = %q, want %q", to, tt.wantTo)
			}
			if path != tt.wantPath {
				t.Errorf("path = %q, want %q", path, tt.wantPath)
			}
		})
	}
}

func TestLevenshtein(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"abc", "abc", 0},
		{"", "hello", 5},
		{"hello", "", 5},
		{"kitten", "sitting", 3},
		{"cat", "bat", 1},
		{"a", "b", 1},
		{"ab", "abc", 1},
	}
	for _, tt := range tests {
		t.Run(tt.a+"_vs_"+tt.b, func(t *testing.T) {
			got := levenshtein(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("levenshtein(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestSuggestPaths(t *testing.T) {
	allPaths := []string{
		"internal/chat/service.go",
		"internal/chat/prompt.go",
		"internal/repo/reader.go",
		"cmd/git-chat/main.go",
		"README.md",
		"go.mod",
		"completely/different/thing.txt",
	}

	tests := []struct {
		name    string
		missing string
		all     []string
		maxLen  int // expected max length; -1 = check nil
		check   func(t *testing.T, result []string)
	}{
		{
			name:    "empty missing",
			missing: "",
			all:     allPaths,
			check: func(t *testing.T, result []string) {
				if result != nil {
					t.Errorf("expected nil, got %v", result)
				}
			},
		},
		{
			name:    "empty all",
			missing: "foo.go",
			all:     nil,
			check: func(t *testing.T, result []string) {
				if result != nil {
					t.Errorf("expected nil, got %v", result)
				}
			},
		},
		{
			name:    "exact match returns it",
			missing: "README.md",
			all:     allPaths,
			check: func(t *testing.T, result []string) {
				if len(result) == 0 || result[0] != "README.md" {
					t.Errorf("expected README.md first, got %v", result)
				}
			},
		},
		{
			name:    "close typo returned",
			missing: "internal/chat/servce.go", // missing 'i'
			all:     allPaths,
			check: func(t *testing.T, result []string) {
				if len(result) == 0 {
					t.Fatal("expected suggestions, got none")
				}
				if result[0] != "internal/chat/service.go" {
					t.Errorf("expected internal/chat/service.go first, got %q", result[0])
				}
			},
		},
		{
			name:    "far-off path not returned",
			missing: "zzzzzzzzzzz.xyz",
			all:     allPaths,
			check: func(t *testing.T, result []string) {
				if result != nil {
					t.Errorf("expected nil for far-off path, got %v", result)
				}
			},
		},
		{
			name:    "max 3 results",
			missing: "go.mod",
			all:     []string{"go.mod", "go.mob", "go.moe", "go.mof", "go.mog"},
			check: func(t *testing.T, result []string) {
				if len(result) > 3 {
					t.Errorf("expected at most 3 results, got %d", len(result))
				}
			},
		},
		{
			name:    "sorted by distance",
			missing: "go.mod",
			all:     []string{"go.mxx", "go.mox", "go.mod"},
			check: func(t *testing.T, result []string) {
				if len(result) == 0 {
					t.Fatal("expected results")
				}
				if result[0] != "go.mod" {
					t.Errorf("expected exact match first, got %q", result[0])
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := suggestPaths(tt.missing, tt.all)
			tt.check(t, result)
		})
	}
}

func TestFormatTreeLine(t *testing.T) {
	tests := []struct {
		name    string
		label   string
		entries []*gitchatv1.TreeEntry
		want    string
	}{
		{
			name:  "mix of dirs and files",
			label: "/",
			entries: []*gitchatv1.TreeEntry{
				{Name: "cmd", Type: gitchatv1.EntryType_ENTRY_TYPE_DIR},
				{Name: "internal", Type: gitchatv1.EntryType_ENTRY_TYPE_DIR},
				{Name: "go.mod", Type: gitchatv1.EntryType_ENTRY_TYPE_FILE},
				{Name: "README.md", Type: gitchatv1.EntryType_ENTRY_TYPE_FILE},
			},
			want: "/ (dirs: cmd/, internal/; files: go.mod, README.md)",
		},
		{
			name:  "only files",
			label: "docs/",
			entries: []*gitchatv1.TreeEntry{
				{Name: "ARCHITECTURE.md", Type: gitchatv1.EntryType_ENTRY_TYPE_FILE},
				{Name: "DESIGN.md", Type: gitchatv1.EntryType_ENTRY_TYPE_FILE},
			},
			want: "docs/ (files: ARCHITECTURE.md, DESIGN.md)",
		},
		{
			name:  "only dirs",
			label: "internal/",
			entries: []*gitchatv1.TreeEntry{
				{Name: "chat", Type: gitchatv1.EntryType_ENTRY_TYPE_DIR},
				{Name: "repo", Type: gitchatv1.EntryType_ENTRY_TYPE_DIR},
			},
			want: "internal/ (dirs: chat/, repo/)",
		},
		{
			name:    "empty entries",
			label:   "/",
			entries: nil,
			want:    "",
		},
		{
			name:  "entries with unspecified type ignored",
			label: "/",
			entries: []*gitchatv1.TreeEntry{
				{Name: "unknown", Type: gitchatv1.EntryType_ENTRY_TYPE_UNSPECIFIED},
			},
			want: "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatTreeLine(tt.label, tt.entries)
			if got != tt.want {
				t.Errorf("formatTreeLine(%q, ...) =\n  %q\nwant\n  %q", tt.label, got, tt.want)
			}
		})
	}
}

func TestEnvInt(t *testing.T) {
	const key = "GITCHAT_TEST_ENVINT"

	tests := []struct {
		name    string
		setVal  string // empty = unset
		def     int64
		want    int64
	}{
		{"unset returns default", "", 42, 42},
		{"valid int parsed", "100", 42, 100},
		{"invalid string returns default", "notanumber", 42, 42},
		{"zero returns default", "0", 42, 42},
		{"negative returns default", "-5", 42, 42},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setVal != "" {
				os.Setenv(key, tt.setVal)
				t.Cleanup(func() { os.Unsetenv(key) })
			} else {
				os.Unsetenv(key)
			}
			got := envInt(key, tt.def)
			if got != tt.want {
				t.Errorf("envInt(%q, %d) = %d, want %d", key, tt.def, got, tt.want)
			}
		})
	}
}

func TestBacktickEach(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{"single", []string{"foo"}, []string{"`foo`"}},
		{"multiple", []string{"a", "b", "c"}, []string{"`a`", "`b`", "`c`"}},
		{"empty slice", []string{}, []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := backtickEach(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("len = %d, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("index %d = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}
