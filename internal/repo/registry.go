// Package repo owns read-only git access: a Registry of repositories that
// the server has been configured to expose, plus a go-git-backed Reader
// that answers ListBranches / ListTree / GetFile queries. Writes live
// outside this package.
//
// The "add repo" flow is a CLI-time operation, not an RPC.
// Multi-user add-repo is not yet implemented.
package repo

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
)

// Entry is a registered repository.
type Entry struct {
	ID            string
	Label         string
	Path          string // absolute
	DefaultBranch string
	repo          *git.Repository
}

// Registry holds every repository the server exposes. Thread-safe for
// concurrent reads after startup.
type Registry struct {
	mu    sync.RWMutex
	byID  map[string]*Entry
	order []string
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byID: make(map[string]*Entry)}
}

// Add opens the repository at path and registers it. Fails if the path is
// not a git repository, if a repo with the derived ID already exists, or
// if HEAD is detached (we need a branch name to call the "default").
func (r *Registry) Add(path string) (*Entry, error) {
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
		return nil, fmt.Errorf("repo id %q already registered (from another --repo path with the same basename)", id)
	}

	entry := &Entry{
		ID:            id,
		Label:         filepath.Base(abs),
		Path:          abs,
		DefaultBranch: defaultBranch,
		repo:          gitRepo,
	}
	r.byID[id] = entry
	r.order = append(r.order, id)
	return entry, nil
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
	ref, err := e.repo.Reference(plumbing.NewBranchReferenceName(e.DefaultBranch), true)
	if err != nil {
		return ""
	}
	h := ref.Hash().String()
	if len(h) >= 7 {
		return h[:7]
	}
	return h
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
