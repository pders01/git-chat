package repo_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/repo"
)

// mustInitRepo creates a temp git repo with a root README and a subdir
// containing a .go file. Returns the absolute path.
func mustInitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	r, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatalf("plain init: %v", err)
	}
	w, err := r.Worktree()
	if err != nil {
		t.Fatalf("worktree: %v", err)
	}

	writeFile(t, filepath.Join(dir, "README.md"), "# test repo\n\nHello world.\n")
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main\n\nfunc main() {}\n")

	if _, err := w.Add("README.md"); err != nil {
		t.Fatalf("add README: %v", err)
	}
	if _, err := w.Add("src/main.go"); err != nil {
		t.Fatalf("add main.go: %v", err)
	}
	commitHash, err := w.Commit("initial", &git.CommitOptions{
		Author: &object.Signature{Name: "test", Email: "test@example.com", When: time.Now()},
	})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Logf("initial commit: %s", commitHash)
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newTestServer returns a connect client for RepoService with the given
// authenticated context. If authed is true, the request context carries a
// principal so the RequireAuth interceptor lets the request through.
func newTestServer(t *testing.T, registry *repo.Registry, authed bool) gitchatv1connect.RepoServiceClient {
	t.Helper()

	svc := &repo.Service{Registry: registry}
	mux := http.NewServeMux()
	path, handler := gitchatv1connect.NewRepoServiceHandler(
		svc,
		connect.WithInterceptors(auth.RequireAuth()),
	)
	mux.Handle(path, handler)

	// Inject a principal via a pre-handler wrapper so the RequireAuth
	// interceptor sees one. Off for the unauthorized test.
	var wrapped http.Handler = mux
	if authed {
		wrapped = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := auth.WithPrincipal(r.Context(), "test@local", gitchatv1.AuthMode_AUTH_MODE_LOCAL)
			mux.ServeHTTP(w, r.WithContext(ctx))
		})
	}

	srv := httptest.NewServer(wrapped)
	t.Cleanup(srv.Close)

	return gitchatv1connect.NewRepoServiceClient(http.DefaultClient, srv.URL)
}

func TestListReposAndListBranches(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	if _, err := registry.Add(path); err != nil {
		t.Fatalf("register: %v", err)
	}
	client := newTestServer(t, registry, true)
	ctx := context.Background()

	// ListRepos returns exactly the one we registered.
	repos, err := client.ListRepos(ctx, connect.NewRequest(&gitchatv1.ListReposRequest{}))
	if err != nil {
		t.Fatalf("list repos: %v", err)
	}
	if len(repos.Msg.Repos) != 1 {
		t.Fatalf("expected 1 repo, got %d", len(repos.Msg.Repos))
	}
	repoID := repos.Msg.Repos[0].Id

	// ListBranches returns the default branch (whatever git-init picked).
	branches, err := client.ListBranches(ctx, connect.NewRequest(&gitchatv1.ListBranchesRequest{RepoId: repoID}))
	if err != nil {
		t.Fatalf("list branches: %v", err)
	}
	if len(branches.Msg.Branches) < 1 {
		t.Fatalf("expected at least 1 branch, got %d", len(branches.Msg.Branches))
	}
	if branches.Msg.Branches[0].Subject != "initial" {
		t.Fatalf("expected subject=initial, got %q", branches.Msg.Branches[0].Subject)
	}
}

func TestListTreeAndGetFile(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	entry, err := registry.Add(path)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	client := newTestServer(t, registry, true)
	ctx := context.Background()

	// Root listing: README.md (file) and src (dir).
	root, err := client.ListTree(ctx, connect.NewRequest(&gitchatv1.ListTreeRequest{
		RepoId: entry.ID,
		Path:   "",
	}))
	if err != nil {
		t.Fatalf("list root: %v", err)
	}
	names := make(map[string]gitchatv1.EntryType)
	for _, e := range root.Msg.Entries {
		names[e.Name] = e.Type
	}
	if names["README.md"] != gitchatv1.EntryType_ENTRY_TYPE_FILE {
		t.Errorf("expected README.md to be a file, got %v", names["README.md"])
	}
	if names["src"] != gitchatv1.EntryType_ENTRY_TYPE_DIR {
		t.Errorf("expected src to be a dir, got %v", names["src"])
	}

	// Dirs should sort before files.
	if root.Msg.Entries[0].Type != gitchatv1.EntryType_ENTRY_TYPE_DIR {
		t.Errorf("expected dirs first, got %v", root.Msg.Entries[0])
	}

	// Nested listing.
	nested, err := client.ListTree(ctx, connect.NewRequest(&gitchatv1.ListTreeRequest{
		RepoId: entry.ID,
		Path:   "src",
	}))
	if err != nil {
		t.Fatalf("list src: %v", err)
	}
	if len(nested.Msg.Entries) != 1 || nested.Msg.Entries[0].Name != "main.go" {
		t.Fatalf("expected src/ to contain main.go, got %v", nested.Msg.Entries)
	}

	// GetFile at nested path.
	file, err := client.GetFile(ctx, connect.NewRequest(&gitchatv1.GetFileRequest{
		RepoId: entry.ID,
		Path:   "src/main.go",
	}))
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	if string(file.Msg.Content) != "package main\n\nfunc main() {}\n" {
		t.Fatalf("unexpected content: %q", file.Msg.Content)
	}
	if file.Msg.Language != "go" {
		t.Fatalf("expected language=go, got %q", file.Msg.Language)
	}
	if file.Msg.IsBinary {
		t.Error("expected text file, got is_binary=true")
	}
}

// TestGetDiff covers the M4.0 diff primitive: a second commit that
// edits src/main.go and README.md should produce a unified patch
// scoped to the requested path. Also verifies the "parent defaults
// correctly when from_ref is empty" contract.
func TestGetDiff(t *testing.T) {
	path := mustInitRepo(t)

	// Add a second commit that modifies src/main.go.
	r, err := git.PlainOpen(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	w, err := r.Worktree()
	if err != nil {
		t.Fatalf("worktree: %v", err)
	}
	writeFile(t, filepath.Join(path, "src", "main.go"),
		"package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n")
	if _, err := w.Add("src/main.go"); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := w.Commit("second", &git.CommitOptions{
		Author: &object.Signature{Name: "test", Email: "test@example.com", When: time.Now()},
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	registry := repo.NewRegistry()
	entry, err := registry.Add(path)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	client := newTestServer(t, registry, true)
	ctx := context.Background()

	// Default from_ref/to_ref: should diff HEAD against its parent.
	resp, err := client.GetDiff(ctx, connect.NewRequest(&gitchatv1.GetDiffRequest{
		RepoId: entry.ID,
		Path:   "src/main.go",
	}))
	if err != nil {
		t.Fatalf("get diff: %v", err)
	}
	if resp.Msg.Empty {
		t.Fatal("expected non-empty diff, got empty=true")
	}
	patch := resp.Msg.UnifiedDiff
	// Must be a proper unified diff header so Shiki's `diff` grammar
	// lights up.
	if !strings.HasPrefix(patch, "diff --git a/src/main.go b/src/main.go\n") {
		t.Fatalf("expected git-style header, got:\n%s", patch)
	}
	if !strings.Contains(patch, "--- a/src/main.go") ||
		!strings.Contains(patch, "+++ b/src/main.go") {
		t.Fatalf("expected path markers, got:\n%s", patch)
	}
	// The edit added a fmt.Println line.
	if !strings.Contains(patch, `+	fmt.Println("hi")`) {
		t.Fatalf("expected added Println line, got:\n%s", patch)
	}
	// README wasn't touched in this commit, so its diff should be empty.
	empty, err := client.GetDiff(ctx, connect.NewRequest(&gitchatv1.GetDiffRequest{
		RepoId: entry.ID,
		Path:   "README.md",
	}))
	if err != nil {
		t.Fatalf("get diff readme: %v", err)
	}
	if !empty.Msg.Empty {
		t.Fatalf("expected README.md diff to be empty, got:\n%s", empty.Msg.UnifiedDiff)
	}

	// Whole-commit diff (empty path) should concatenate patches for
	// every file changed in the commit. This commit only touched
	// src/main.go, so the output should contain exactly its patch.
	whole, err := client.GetDiff(ctx, connect.NewRequest(&gitchatv1.GetDiffRequest{
		RepoId: entry.ID,
		// Path omitted — "whole commit" mode.
	}))
	if err != nil {
		t.Fatalf("get whole diff: %v", err)
	}
	if whole.Msg.Empty {
		t.Fatal("expected non-empty whole-commit diff")
	}
	if !strings.Contains(whole.Msg.UnifiedDiff, "diff --git a/src/main.go b/src/main.go") {
		t.Fatalf("expected src/main.go header in whole-commit diff, got:\n%s",
			whole.Msg.UnifiedDiff)
	}
	// README wasn't touched by this commit so its header must NOT be present.
	if strings.Contains(whole.Msg.UnifiedDiff, "b/README.md") {
		t.Fatalf("unexpected README.md in whole-commit diff, got:\n%s",
			whole.Msg.UnifiedDiff)
	}
	// Whole-commit diff should include per-file metadata.
	if len(whole.Msg.Files) != 1 {
		t.Fatalf("expected 1 changed file, got %d", len(whole.Msg.Files))
	}
	f := whole.Msg.Files[0]
	if f.Path != "src/main.go" {
		t.Fatalf("expected changed file src/main.go, got %s", f.Path)
	}
	if f.Status != "modified" {
		t.Fatalf("expected status modified, got %s", f.Status)
	}
}

func TestRepoServiceRequiresAuth(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	if _, err := registry.Add(path); err != nil {
		t.Fatalf("register: %v", err)
	}
	client := newTestServer(t, registry, false) // no principal injected

	_, err := client.ListRepos(context.Background(), connect.NewRequest(&gitchatv1.ListReposRequest{}))
	if err == nil {
		t.Fatal("expected unauthenticated error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("expected CodeUnauthenticated, got %v", connect.CodeOf(err))
	}
}

func TestGetFileNotFound(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	entry, err := registry.Add(path)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	client := newTestServer(t, registry, true)

	_, err = client.GetFile(context.Background(), connect.NewRequest(&gitchatv1.GetFileRequest{
		RepoId: entry.ID,
		Path:   "nonexistent.txt",
	}))
	if err == nil {
		t.Fatal("expected not-found error, got nil")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("expected CodeNotFound, got %v", connect.CodeOf(err))
	}
}

// mustInitRepoMultiCommit creates a repo with 3 commits, where the
// second touches only src/main.go and the third touches only README.md.
func mustInitRepoMultiCommit(t *testing.T) (string, *repo.Entry) {
	t.Helper()
	dir := mustInitRepo(t) // 1 commit: README.md + src/main.go

	r, _ := git.PlainOpen(dir)
	w, _ := r.Worktree()

	// Second commit: edit src/main.go only.
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main\n\nfunc main() { println(1) }\n")
	w.Add("src/main.go")
	w.Commit("edit main.go", &git.CommitOptions{
		Author: &object.Signature{Name: "test", Email: "test@example.com", When: time.Now()},
	})

	// Third commit: edit README.md only.
	writeFile(t, filepath.Join(dir, "README.md"), "# updated\n")
	w.Add("README.md")
	w.Commit("edit README", &git.CommitOptions{
		Author: &object.Signature{Name: "test", Email: "test@example.com", When: time.Now()},
	})

	registry := repo.NewRegistry()
	entry, err := registry.Add(dir)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return dir, entry
}

func TestListCommits(t *testing.T) {
	_, entry := mustInitRepoMultiCommit(t)
	reg := repo.NewRegistry()
	reg.Add(entry.Path)
	client := newTestServer(t, reg, true)
	ctx := context.Background()

	resp, err := client.ListCommits(ctx, connect.NewRequest(&gitchatv1.ListCommitsRequest{
		RepoId: entry.ID,
		Limit:  10,
	}))
	if err != nil {
		t.Fatalf("list commits: %v", err)
	}
	if len(resp.Msg.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(resp.Msg.Commits))
	}
	// Newest first.
	if resp.Msg.Commits[0].Message != "edit README" {
		t.Fatalf("first commit should be newest, got %q", resp.Msg.Commits[0].Message)
	}
}

func TestListCommitsPathFilter(t *testing.T) {
	_, entry := mustInitRepoMultiCommit(t)
	reg := repo.NewRegistry()
	reg.Add(entry.Path)
	client := newTestServer(t, reg, true)
	ctx := context.Background()

	// Filter to src/main.go — should return 2 commits (initial + edit).
	resp, err := client.ListCommits(ctx, connect.NewRequest(&gitchatv1.ListCommitsRequest{
		RepoId: entry.ID,
		Limit:  10,
		Path:   "src/main.go",
	}))
	if err != nil {
		t.Fatalf("list commits with path filter: %v", err)
	}
	if len(resp.Msg.Commits) != 2 {
		t.Fatalf("expected 2 commits for src/main.go, got %d", len(resp.Msg.Commits))
	}
	for _, c := range resp.Msg.Commits {
		if c.Message == "edit README" {
			t.Fatalf("README-only commit should not appear in src/main.go filter")
		}
	}
}

func TestGetBlame(t *testing.T) {
	_, entry := mustInitRepoMultiCommit(t)
	reg := repo.NewRegistry()
	reg.Add(entry.Path)
	client := newTestServer(t, reg, true)
	ctx := context.Background()

	resp, err := client.GetBlame(ctx, connect.NewRequest(&gitchatv1.GetBlameRequest{
		RepoId: entry.ID,
		Path:   "README.md",
	}))
	if err != nil {
		t.Fatalf("get blame: %v", err)
	}
	if len(resp.Msg.Lines) == 0 {
		t.Fatal("expected blame lines, got 0")
	}
	// All lines should be from "edit README" commit (it replaced the whole file).
	for _, line := range resp.Msg.Lines {
		if line.CommitMessage != "edit README" {
			t.Fatalf("expected blame to show 'edit README', got %q", line.CommitMessage)
		}
	}
}
