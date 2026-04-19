// Package repo owns read-only git access: a Registry of repositories that
// the server has been configured to expose, plus a go-git-backed Reader
// that answers ListBranches / ListTree / GetFile queries. Writes live
// outside this package.
//
// The "add repo" flow is a CLI-time operation, not an RPC.
// Multi-user add-repo is not yet implemented.
package repo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"

	"github.com/pders01/git-chat/internal/config"
)

// Entry is a registered repository.
//
// ── Locking ─────────────────────────────────────────────────────────
//
// mu serializes access to the *git.Repository handle. go-git is NOT
// thread-safe: even concurrent reads can panic via MemoryIndex.FindHash
// (concurrent map read/write in the packfile index). See
// https://github.com/go-git/go-git/issues/773 and #1121. Do not relax
// this to an RWMutex — every known "read-only" go-git method still
// mutates internal caches.
//
// cacheMu is a separate RWMutex dedicated to blameCache and churnCache.
// Cache hits take RLock and parallelize; cache stores take Lock. This
// decouples cache lookups from mu so two users hitting cached results
// don't serialize behind a third user's in-flight go-git walk.
//
// Lock order: mu before cacheMu when both are needed. Long-running
// subprocess work (git blame, git log) MUST be done with neither held
// — those paths resolve the SHA under mu, release, exec, then
// re-acquire for any post-processing that touches go-git.
//
// ── Caches ──────────────────────────────────────────────────────────
//
// blameCache holds per-(commitSHA, path) blame results. Blame is
// deterministic for a given commit, so entries never need invalidation;
// we just cap the total entry count to bound memory.
//
// churnCache holds per-(tipSHA, since, until, maxCommits) churn map
// results. The full walk on a 60k-commit repo takes minutes, and the
// tip SHA changes only when the repo's HEAD moves — so caching gives
// us an instant second click for the same ref + window combination.
// Eviction strategy matches blameCache: bounded by count, random-half
// drop when full.
type Entry struct {
	ID            string
	Label         string
	Path          string // absolute
	DefaultBranch string
	// Config is the live config Registry. Entry methods read tunables
	// (diff byte caps, commit limits, churn window) through it so UI
	// settings changes take effect without a restart. Nil-safe: the
	// helper methods below fall back to env + compiled defaults when
	// Config is unset (e.g., tests that construct Entry directly).
	Config        *config.Registry
	mu            sync.Mutex
	repo          *git.Repository
	cacheMu       sync.RWMutex
	blameCache    map[string]any // key: commitSHA + "\x00" + path → []*gitchatv1.BlameLine (declared as any to keep this file free of gen/ imports)
	churnCache    map[string]any // key: tipSHA|since|until|maxCommits → *ChurnMapResult (any keeps this file free of gen/ imports)
}

// Registry holds every repository the server exposes. Thread-safe for
// concurrent reads after startup.
//
// Config, when set, is propagated to every Entry created via Add so
// reader.go can resolve tunables through the DB → env → default chain
// instead of reading env at package init.
type Registry struct {
	mu     sync.RWMutex
	byID   map[string]*Entry
	order  []string
	Config *config.Registry
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byID: make(map[string]*Entry)}
}

// SetConfig attaches a config Registry to this repo Registry and
// propagates it to every already-registered Entry. Call once at
// startup after opening the DB and registering defaults, before the
// server starts answering requests — not safe to call concurrently
// with Add. Subsequent Add calls inherit the config automatically.
func (r *Registry) SetConfig(cfg *config.Registry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Config = cfg
	for _, e := range r.byID {
		e.Config = cfg
	}
}

// Add opens the repository at path and registers it. Fails if the path is
// not a git repository, if a repo with the derived ID already exists, or
// if HEAD is detached (we need a branch name to call the "default").
func (r *Registry) Add(path string) (*Entry, error) {
	return r.addInternal(path, false)
}

// addInternal is the internal implementation that can optionally skip
// duplicate ID errors (used by ScanDirectory).
func (r *Registry) addInternal(path string, skipDuplicates bool) (*Entry, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", path, err)
	}
	gitRepo, err := git.PlainOpen(abs)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", abs, err)
	}
	head, err := gitRepo.Head()
	if err != nil {
		return nil, fmt.Errorf("resolve HEAD in %q: %w", abs, err)
	}
	if !head.Name().IsBranch() {
		return nil, fmt.Errorf("repo %q has detached HEAD; check out a branch first", abs)
	}
	defaultBranch := head.Name().Short()

	id := slugify(filepath.Base(abs))
	if id == "" {
		return nil, fmt.Errorf("could not derive id from %q", abs)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byID[id]; exists {
		if skipDuplicates {
			return nil, nil // silently skip duplicate
		}
		return nil, fmt.Errorf("repo id %q already registered (from another --repo path with the same basename)", id)
	}

	entry := &Entry{
		ID:            id,
		Label:         filepath.Base(abs),
		Path:          abs,
		DefaultBranch: defaultBranch,
		Config:        r.Config,
		repo:          gitRepo,
	}
	r.byID[id] = entry
	r.order = append(r.order, id)
	if prewarmChurn {
		// Kick off the full-history churn walk in the background so the
		// user's first "all" click returns instantly. Opt-in via
		// GITCHAT_PREWARM_CHURN because the walk pegs a CPU for minutes
		// on large repos and would surprise laptop / battery users.
		go entry.prewarmChurnAll(context.Background())
	}
	return entry, nil
}

// cfgInt resolves a Registry-backed int tunable, falling back to env
// then `def` when no Config is attached (e.g. tests construct Entry
// directly). Per-call so live UI updates take effect; the Registry's
// DB lookup has a 5s timeout internally, so latency is bounded.
func (e *Entry) cfgInt(ctx context.Context, key string, def int) int {
	if e.Config != nil {
		return e.Config.GetIntCtx(ctx, key, def)
	}
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// cfgInt64 is the int64 counterpart of cfgInt.
func (e *Entry) cfgInt64(ctx context.Context, key string, def int64) int64 {
	if e.Config != nil {
		return e.Config.GetInt64Ctx(ctx, key, def)
	}
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// prewarmChurn is resolved once at package init from the environment
// so we don't re-parse the flag on every repo registration.
//
// Intentionally a package-level os.Getenv, NOT a config.Registry
// tunable. The config registry only comes up after repos are already
// being registered, and flipping prewarm at runtime is meaningless:
// either the scan ran once at startup or it didn't. Future agents
// refactoring the #4-sweep "move all GITCHAT_* into the registry"
// pattern should leave this one alone for that reason.
var prewarmChurn = os.Getenv("GITCHAT_PREWARM_CHURN") == "1"

// prewarmChurnAll runs GetFileChurnMap with an uncapped window on the
// repo's HEAD, populating the churnCache for the "all history" click.
// Errors are swallowed — the user still gets a working scan on demand
// if the prewarm fails for any reason.
func (e *Entry) prewarmChurnAll(ctx context.Context) {
	_, _ = e.GetFileChurnMap(ctx, "HEAD", 0, 0, churnHardCap)
}

// ScanResult holds the outcome of scanning a directory for repos.
type ScanResult struct {
	Added       []*Entry // Successfully registered repos
	Skipped     []string // Repos skipped due to duplicate IDs (path only)
	Errors      []error  // Non-fatal errors (failed git open, etc.)
}

// ScanDirectory scans immediate subdirectories for git repositories
// and registers them. Returns results with successful adds, skipped
// duplicates, and any errors encountered.
func (r *Registry) ScanDirectory(dir string, maxRepos int) (*ScanResult, error) {
	if maxRepos < 0 {
		return nil, fmt.Errorf("maxRepos cannot be negative: %d", maxRepos)
	}

	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", dir, err)
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, fmt.Errorf("read directory %q: %w", abs, err)
	}

	result := &ScanResult{
		Added:   make([]*Entry, 0),
		Skipped: make([]string, 0),
		Errors:  make([]error, 0),
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Try to open as git repo (eliminates TOCTOU race between Stat and PlainOpen)
		subPath := filepath.Join(abs, entry.Name())
		e, err := r.addInternal(subPath, true)
		if err != nil {
			// Only record errors for paths that look like they might be repos
			// (contain .git directory or file). Silently skip non-git directories.
			if isProbablyGitRepo(subPath) {
				result.Errors = append(result.Errors, fmt.Errorf("%s: %w", subPath, err))
			}
			continue
		}
		if e == nil {
			// Duplicate ID - repo with same basename already registered
			result.Skipped = append(result.Skipped, subPath)
			continue
		}
		result.Added = append(result.Added, e)

		// Check max repos limit
		if maxRepos > 0 && len(result.Added) >= maxRepos {
			break
		}
	}

	// Sort both the return value and the internal order for deterministic
	// ordering everywhere (List() uses r.order, callers may use result.Added).
	sort.Slice(result.Added, func(i, j int) bool {
		return result.Added[i].ID < result.Added[j].ID
	})
	r.mu.Lock()
	sort.Strings(r.order)
	r.mu.Unlock()

	return result, nil
}

// Get returns the entry for id, or nil.
func (r *Registry) Get(id string) *Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.byID[id]
}

// List returns all registered entries in insertion order.
func (r *Registry) List() []*Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Entry, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	return out
}

// Count returns the number of registered repositories.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.order)
}

// HeadCommit returns the short SHA at the default branch's tip. Zero value
// if anything goes wrong (callers don't want this to fail their whole call).
func (e *Entry) HeadCommit() string {
	// go-git is not thread-safe; every other e.repo.* caller in this
	// package serializes through e.mu. HeadCommit skipping the lock was
	// a data-race site on concurrent ListRepos + activity summarization.
	e.mu.Lock()
	defer e.mu.Unlock()
	ref, err := e.repo.Reference(plumbing.NewBranchReferenceName(e.DefaultBranch), true)
	if err != nil {
		return ""
	}
	return ShortSHA(ref.Hash().String())
}

// isProbablyGitRepo checks if path might be a git repo (has .git file or dir).
// Used to decide whether to log errors during directory scanning.
func isProbablyGitRepo(path string) bool {
	gitPath := filepath.Join(path, ".git")
	_, err := os.Stat(gitPath)
	return err == nil
}

var slugReplacer = regexp.MustCompile(`[^a-z0-9-]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugReplacer.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	return s
}

// ErrNotFound is returned when a ref, path, or repo does not exist.
var ErrNotFound = errors.New("not found")
