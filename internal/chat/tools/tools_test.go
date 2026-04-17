package tools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"

	"github.com/pders01/git-chat/internal/repo"
)

// fixture creates a throwaway git repo and returns a repo.Entry
// pointing at it. The repo has a README, a couple of source files,
// and two commits so diff tests have something to chew on.
func fixture(t *testing.T) *repo.Entry {
	t.Helper()
	dir := t.TempDir()
	r, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := r.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	writeFile := func(rel, body string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sig := &object.Signature{Name: "t", Email: "t@e", When: time.Now()}
	writeFile("README.md", "# hello\n")
	writeFile("src/main.go", "package main\n\nfunc main() {}\n")
	if _, err := wt.Add("README.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Add("src/main.go"); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Commit("initial", &git.CommitOptions{Author: sig}); err != nil {
		t.Fatal(err)
	}
	writeFile("src/main.go", "package main\n\nfunc main() { println(42) }\n")
	if _, err := wt.Add("src/main.go"); err != nil {
		t.Fatal(err)
	}
	sig2 := &object.Signature{Name: "t", Email: "t@e", When: time.Now().Add(time.Second)}
	if _, err := wt.Commit("println", &git.CommitOptions{Author: sig2}); err != nil {
		t.Fatal(err)
	}
	reg := repo.NewRegistry()
	e, err := reg.Add(dir)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestReadFile(t *testing.T) {
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "read_file",
		json.RawMessage(`{"path":"README.md"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "hello") {
		t.Fatalf("expected hello in output, got %q", out)
	}
}

func TestReadFileMissing(t *testing.T) {
	e := fixture(t)
	r := Default()
	_, err := r.Execute(context.Background(), e, "read_file",
		json.RawMessage(`{"path":"nope.txt"}`))
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestListTreeRoot(t *testing.T) {
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "list_tree", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "README.md") || !strings.Contains(out, "src/") {
		t.Fatalf("expected README and src/ in output, got %q", out)
	}
}

func TestSearchPaths(t *testing.T) {
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "search_paths",
		json.RawMessage(`{"query":"main"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "src/main.go") {
		t.Fatalf("expected src/main.go in output, got %q", out)
	}
}

func TestSearchPathsEmpty(t *testing.T) {
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "search_paths",
		json.RawMessage(`{"query":"totally-not-present"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "(no files matching") {
		t.Fatalf("expected empty-result marker, got %q", out)
	}
}

func TestGetDiff(t *testing.T) {
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "get_diff", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "println(42)") {
		t.Fatalf("expected diff body to contain println(42), got %q", out)
	}
}

func TestSearchCodeBasic(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	e := fixture(t)
	r := Default()
	// query uses only word chars; regex interp is inert here.
	out, err := r.Execute(context.Background(), e, "search_code",
		json.RawMessage(`{"query":"println"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "src/main.go") {
		t.Fatalf("expected src/main.go in output, got %q", out)
	}
}

func TestSearchCodeRegex(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "search_code",
		json.RawMessage(`{"query":"func\\s+main"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "src/main.go") {
		t.Fatalf("expected src/main.go match, got %q", out)
	}
}

func TestSearchCodeLiteralFlag(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	e := fixture(t)
	r := Default()
	// regex metachars are inert when literal=true
	out, err := r.Execute(context.Background(), e, "search_code",
		json.RawMessage(`{"query":"println(42)","literal":true}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "src/main.go") {
		t.Fatalf("expected literal match, got %q", out)
	}
}

func TestSearchCodeNoMatch(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "search_code",
		json.RawMessage(`{"query":"nonexistent-xyz"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "no matches") {
		t.Fatalf("expected empty-result marker, got %q", out)
	}
}

func TestOutlineGoFile(t *testing.T) {
	if _, err := exec.LookPath("ctags"); err != nil {
		t.Skip("ctags not installed")
	}
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "outline",
		json.RawMessage(`{"path":"src/main.go"}`))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, "main") || !strings.Contains(out, "src/main.go") {
		t.Fatalf("expected main func + file header, got %q", out)
	}
}

func TestOutlineMissing(t *testing.T) {
	if _, err := exec.LookPath("ctags"); err != nil {
		t.Skip("ctags not installed")
	}
	e := fixture(t)
	r := Default()
	out, err := r.Execute(context.Background(), e, "outline",
		json.RawMessage(`{"path":"nope.go"}`))
	if err != nil {
		return // ctags itself errors; acceptable
	}
	if !strings.Contains(out, "no symbols") {
		t.Fatalf("expected empty marker, got %q", out)
	}
}

func TestUnknownTool(t *testing.T) {
	e := fixture(t)
	r := Default()
	_, err := r.Execute(context.Background(), e, "nope", nil)
	if err == nil {
		t.Fatal("expected ErrUnknownTool")
	}
}
