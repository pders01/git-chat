package repo

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/storage/memory"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

func TestReaderDiffWorkDimensionsAndOverflow(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	for _, tc := range []struct {
		m, n int
		ok   bool
	}{
		{1023, 1023, true}, {1024, 1023, false}, {maxDiffMatrixCells - 1, 0, true},
		{maxDiffMatrixCells, 0, false}, {maxInt, maxInt, false}, {-1, 1, false}, {1, -1, false},
	} {
		work := newDiffWork(context.Background())
		before := work.cells
		cells, err := work.reserveCells(tc.m, tc.n)
		if tc.ok {
			if err != nil || cells != (tc.m+1)*(tc.n+1) || work.cells != before-cells {
				t.Fatalf("exact boundary rejected/mischarged: %v %d %v", tc, cells, err)
			}
		} else {
			if !errors.Is(err, errDiffWorkLimit) || cells != 0 || work.cells != before {
				t.Fatalf("unsafe dimensions accepted/charged: %v %d %v", tc, cells, err)
			}
			if _, err := work.reserveCells(1, 1); !errors.Is(err, errDiffWorkLimit) {
				t.Fatal("failed budget was reset within read")
			}
		}
	}
	work := newDiffWork(context.Background())
	for i := 0; i < 8; i++ {
		if _, err := work.reserveCells(1023, 1023); err != nil {
			t.Fatal(err)
		}
	}
	if work.cells != 0 {
		t.Fatal("wrong aggregate boundary")
	}
	if _, err := work.reserveCells(0, 0); !errors.Is(err, errDiffWorkLimit) {
		t.Fatal("aggregate allowance reset")
	}
}

func TestReaderDiffWorkStatsAndRendererShareAllowance(t *testing.T) {
	work := newDiffWork(context.Background())
	adds, dels, err := countDiffLines(work, "old\n", "new\n")
	if err != nil || adds != 1 || dels != 1 || work.cells != maxDiffReadCells-4 {
		t.Fatalf("stat charge incorrect: %v", err)
	}
	patch, err := renderFilePatch(work, "proof.txt", fileSide{content: "old\n", sha: "old"}, fileSide{content: "new\n", sha: "new"}, 3)
	if err != nil || patch == "" || work.cells != maxDiffReadCells-8 {
		t.Fatalf("renderer reset stat allowance: %v", err)
	}
	// Exact per-matrix boundary allocates only the permitted ~8 MiB.
	lines := strings.Repeat("line\n", 1023)
	_, err = renderFilePatch(newDiffWork(context.Background()), "proof.txt", fileSide{content: lines, sha: "old"}, fileSide{content: strings.ReplaceAll(lines, "line", "next"), sha: "new"}, 3)
	if err != nil {
		t.Fatalf("exact permitted boundary rejected: %v", err)
	}
}

// A deterministic valid Context closes Done when Err first becomes canceled.
// No timing sleeps, test hook in production, goroutine race or large allocation.
type diffPollContext struct {
	context.Context
	mu        sync.Mutex
	remaining int
	done      chan struct{}
	canceled  bool
}

func (c *diffPollContext) Done() <-chan struct{} { return c.done }
func (c *diffPollContext) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.canceled {
		c.remaining--
		if c.remaining <= 0 {
			c.canceled = true
			close(c.done)
		}
	}
	if c.canceled {
		return context.Canceled
	}
	return nil
}
func newDiffPollContext(polls int) *diffPollContext {
	return &diffPollContext{Context: context.Background(), remaining: polls, done: make(chan struct{})}
}

func TestReaderDiffWorkCancellationDuringMatrixAndBacktrack(t *testing.T) {
	for _, tc := range []struct {
		name        string
		polls, m, n int
	}{
		{"pre-allocation", 1, 32, 32}, {"during-matrix", 5, 32, 32},
		{"at-backtrack", 34, 32, 32}, {"during-backtrack", 3, 0, 2048},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := newDiffPollContext(tc.polls)
			work := newDiffWork(ctx)
			a := make([]string, tc.m)
			b := make([]string, tc.n)
			for i := range a {
				a[i] = "old\n"
			}
			for i := range b {
				b[i] = "new\n"
			}
			ops, err := lcsDiffOps(work, a, b)
			if !errors.Is(err, context.Canceled) || len(ops) != 0 {
				t.Fatalf("canceled computation returned operations: %d %v", len(ops), err)
			}
			if tc.polls == 1 && work.cells != maxDiffReadCells {
				t.Fatal("pre-canceled read charged/allocated matrix")
			}
			if tc.polls > 1 && work.cells == maxDiffReadCells {
				t.Fatal("test never reached allocated computation")
			}
			select {
			case <-ctx.Done():
			default:
				t.Fatal("invalid cancellation context")
			}
		})
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if patch, err := renderFilePatch(newDiffWork(ctx), "proof.txt", fileSide{}, fileSide{}, 3); patch != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline lost: %q %v", patch, err)
	}
}

func TestReaderDiffWorkStreamingStatLimitsAndCancellation(t *testing.T) {
	// A nil storer would panic if this oversized blob were opened before refusal.
	if _, err := blobLineCount(newDiffWork(context.Background()), &object.Blob{Size: maxDiffStatBytes + 1}); !errors.Is(err, errDiffWorkLimit) {
		t.Fatalf("oversized stat not refused before open: %v", err)
	}
	store := memory.NewStorage()
	encoded := store.NewEncodedObject()
	encoded.SetType(plumbing.BlobObject)
	writer, err := encoded.Writer()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(strings.Repeat("line\n", 20000))); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	id, err := store.SetEncodedObject(encoded)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := object.GetBlob(store, id)
	if err != nil {
		t.Fatal(err)
	}
	work := newDiffWork(context.Background())
	work.statBytes = blob.Size*2 - 1
	if n, err := blobLineCount(work, blob); err != nil || n != 20000 {
		t.Fatalf("first stream failed: %d %v", n, err)
	}
	if n, err := blobLineCount(work, blob); n != 0 || !errors.Is(err, errDiffWorkLimit) {
		t.Fatalf("stat bytes reset between blobs: %d %v", n, err)
	}
	work = newDiffWork(newDiffPollContext(5))
	if n, err := blobLineCount(work, blob); n != 0 || !errors.Is(err, context.Canceled) || work.statBytes == maxDiffStatBytes {
		t.Fatalf("stream cancellation missing/not reached: %d %v", n, err)
	}
}

func TestReaderDiffWorkOtherCallersAndRPCRefusal(t *testing.T) {
	entry, from, to, original := readerDiffWorkFixture(t, 1, 1024)
	files, adds, dels, err := entry.CompareBranches(context.Background(), from, to, false)
	if !errors.Is(err, errDiffWorkLimit) || len(files) != 0 || adds != 0 || dels != 0 {
		t.Fatalf("comparison fabricated counts: %v %d/%d %v", files, adds, dels, err)
	}
	if err := os.WriteFile(filepath.Join(entry.Path, "work-00.txt"), []byte(strings.Repeat("working\n", 1024)), 0o644); err != nil {
		t.Fatal(err)
	}
	if patch, empty, err := entry.GetWorkingTreeDiff("work-00.txt"); !errors.Is(err, errDiffWorkLimit) || patch != "" || empty {
		t.Fatalf("working-tree caller escaped limits: %d %v %v", len(patch), empty, err)
	}
	// Direct service classification only: native browser proofs own real auth.
	service := &Service{Registry: &Registry{byID: map[string]*Entry{"owned": entry}}}
	response, err := service.GetDiff(context.Background(), connect.NewRequest(&gitchatv1.GetDiffRequest{RepoId: "owned", FromRef: from, ToRef: to, Path: "work-00.txt"}))
	if response != nil || connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("RPC published success/wrong refusal: %v %v", response, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if response, err := service.GetWorkingTreeDiff(ctx, connect.NewRequest(&gitchatv1.GetWorkingTreeDiffRequest{RepoId: "owned", Path: "work-00.txt"})); response != nil || connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("working-tree RPC discarded cancellation: %v %v", response, err)
	}
	// Small branch comparison (including additions) remains supported.
	if files, _, _, err := entry.CompareBranches(context.Background(), original[2], from, false); err != nil || len(files) != 1 {
		t.Fatalf("small added-file comparison regressed: %v %v", files, err)
	}
}
