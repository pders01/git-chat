package repo_test

import (
	"context"
	"sync"
	"testing"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/repo"
)

// TestConcurrentBlameCacheHits fires N goroutines at GetBlame for the
// same (ref, path). After priming, every goroutine hits the cacheMu
// RLock path. Run with `go test -race` to catch regressions in the
// phased-locking refactor (registry.go Entry doc).
func TestConcurrentBlameCacheHits(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	entry, err := registry.Add(path)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	ctx := context.Background()
	want, err := entry.GetBlame(ctx, "HEAD", "README.md")
	if err != nil {
		t.Fatalf("prime blame: %v", err)
	}

	const N = 32
	var wg sync.WaitGroup
	results := make([][]*gitchatv1.BlameLine, N)
	errs := make([]error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got, err := entry.GetBlame(ctx, "HEAD", "README.md")
			errs[i] = err
			results[i] = got
		}(i)
	}
	wg.Wait()

	for i := 0; i < N; i++ {
		if errs[i] != nil {
			t.Errorf("goroutine %d: %v", i, errs[i])
			continue
		}
		if len(results[i]) != len(want) {
			t.Errorf("goroutine %d: got %d lines, want %d", i, len(results[i]), len(want))
			continue
		}
		for j := range want {
			if results[i][j].CommitSha != want[j].CommitSha ||
				results[i][j].Text != want[j].Text {
				t.Errorf("goroutine %d line %d diverges from primed result", i, j)
				break
			}
		}
	}
}

// TestConcurrentChurnCacheHits is the churn counterpart.
func TestConcurrentChurnCacheHits(t *testing.T) {
	path := mustInitRepo(t)
	registry := repo.NewRegistry()
	entry, err := registry.Add(path)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	ctx := context.Background()
	want, err := entry.GetFileChurnMap(ctx, "HEAD", 0, 0, 0)
	if err != nil {
		t.Fatalf("prime churn: %v", err)
	}

	const N = 32
	var wg sync.WaitGroup
	errs := make([]error, N)
	scanned := make([]int32, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got, err := entry.GetFileChurnMap(ctx, "HEAD", 0, 0, 0)
			errs[i] = err
			if err == nil {
				scanned[i] = got.CommitsScanned
			}
		}(i)
	}
	wg.Wait()

	for i := 0; i < N; i++ {
		if errs[i] != nil {
			t.Errorf("goroutine %d: %v", i, errs[i])
			continue
		}
		if scanned[i] != want.CommitsScanned {
			t.Errorf("goroutine %d: commitsScanned=%d, want %d",
				i, scanned[i], want.CommitsScanned)
		}
	}
}
