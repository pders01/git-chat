package repo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestGitBoundedOutputRefusesWithoutPrefix(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("native Git required")
	}
	command := gitCmd{repoDir: t.TempDir(), args: []string{"version"}}
	ctx := context.Background()
	out, err := command.runBounded(ctx, 1024)
	if err != nil || !strings.HasPrefix(string(out), "git version ") {
		t.Fatalf("ordinary output = %q, %v", out, err)
	}
	if prefix, err := command.runBounded(ctx, 1); prefix != nil || !errors.Is(err, errRepoReadLimit) {
		t.Fatalf("bounded output = %q, %v", prefix, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if prefix, err := command.runBounded(canceled, 1); prefix != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled output = %q, %v", prefix, err)
	}
}

func TestListBranchesRefusesOverLimitInventory(t *testing.T) {
	entry, ids := readerHistoryFixture(t)
	for i := range maxListedRefs {
		name := plumbing.NewTagReferenceName(fmt.Sprintf("fixture-%04d", i))
		if err := entry.repo.Storer.SetReference(plumbing.NewHashReference(name, plumbing.NewHash(ids[0]))); err != nil {
			t.Fatal(err)
		}
	}
	entry.ID = "fixture"
	service := &Service{Registry: &Registry{byID: map[string]*Entry{entry.ID: entry}}}
	request := connect.NewRequest(&gitchatv1.ListBranchesRequest{RepoId: entry.ID})
	for _, mode := range []string{"native", "fallback"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "fallback" {
				hideReaderGit(t, entry)
			}
			if resp, err := service.ListBranches(context.Background(), request); resp != nil || connect.CodeOf(err) != connect.CodeResourceExhausted {
				t.Fatalf("combined inventory returned partial success: %v", err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if resp, err := service.ListBranches(ctx, request); resp != nil || connect.CodeOf(err) != connect.CodeCanceled {
				t.Fatalf("canceled inventory returned partial success: %v", err)
			}
		})
	}
	if err := entry.repo.Storer.SetReference(plumbing.NewHashReference("refs/tags/overflow", plumbing.NewHash(ids[0]))); err != nil {
		t.Fatal(err)
	}
	if tags, err := entry.ListTags(context.Background()); tags != nil || !errors.Is(err, errRepoReadLimit) {
		t.Fatalf("tag inventory returned %d tags, err=%v", len(tags), err)
	}
}

func TestFullRangeOutputRefusalIsTerminal(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("native Git required")
	}
	entry, ids := readerHistoryFixture(t)
	w, err := entry.repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	// One ordinary text change is enough to cross the response budget without
	// manufacturing a large tree or an expensive text comparison.
	name := "generated-report.txt"
	if err := os.WriteFile(filepath.Join(entry.Path, name), []byte(strings.Repeat("A line of fixture text.\n", maxFullRangeOutputBytes/20)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add(name); err != nil {
		t.Fatal(err)
	}
	to, err := w.Commit("Large report", &git.CommitOptions{Author: &object.Signature{
		Name: "Fixture", Email: "diff@example.invalid", When: time.Unix(1700000010, 0),
	}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	patch, _, _, empty, files, err := entry.GetDiff(ctx, ids[2], to.String(), "", "", false, true, false)
	if !errors.Is(err, errRepoReadLimit) || patch != "" || empty || files != nil {
		t.Fatalf("over-limit patch escaped the refusal: bytes=%d files=%d empty=%v err=%v", len(patch), len(files), empty, err)
	}
	patch, _, _, empty, files, err = entry.GetDiff(ctx, ids[2], to.String(), "", "", false, true, true)
	if err != nil || empty || patch != "" || len(files) != 1 || files[0].Path != name || files[0].Additions == 0 {
		t.Fatalf("explicit files-only request: bytes=%d files=%v empty=%v err=%v", len(patch), files, empty, err)
	}
}
