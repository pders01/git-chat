// Package config provides a centralized, queryable configuration registry.
//
// Resolution order: SQLite override → os.Getenv → compiled default.
// All entries are registered at init time with metadata (key, default,
// description, group) so the UI can display and edit them.
package config

import (
	"context"
	"os"
	"strconv"
	"sync"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/storage"
)

// Registry holds all registered config entries and resolves values
// through the three-tier cascade: DB override → env var → default.
type Registry struct {
	mu      sync.RWMutex
	entries []Entry
	byKey   map[string]*Entry
	db      storage.ConfigStore
}

// Entry describes a single configuration knob.
type Entry struct {
	Key         string
	Default     string
	Description string
	Group       string // "llm", "chat", "repo", "session"
}

// New creates a Registry backed by the given ConfigStore.
func New(db storage.ConfigStore) *Registry {
	return &Registry{
		byKey: make(map[string]*Entry),
		db:    db,
	}
}

// Register adds a config entry to the registry. Duplicate keys are
// silently ignored (first registration wins).
func (r *Registry) Register(key, defaultVal, desc, group string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byKey[key]; ok {
		return
	}
	e := Entry{
		Key:         key,
		Default:     defaultVal,
		Description: desc,
		Group:       group,
	}
	r.entries = append(r.entries, e)
	r.byKey[key] = &r.entries[len(r.entries)-1]
}

// Get resolves a config value: DB override → env var → default.
// Returns the compiled default if the key is unknown.
func (r *Registry) Get(key string) string {
	// Check DB override first.
	if r.db != nil {
		if v, ok, err := r.db.GetConfigOverride(context.Background(), key); err == nil && ok {
			return v
		}
	}

	// Then env var.
	if v := os.Getenv(key); v != "" {
		return v
	}

	// Fall back to registered default.
	r.mu.RLock()
	defer r.mu.RUnlock()
	if e, ok := r.byKey[key]; ok {
		return e.Default
	}
	return ""
}

// GetInt resolves a config value as int, returning 0 on parse failure.
func (r *Registry) GetInt(key string) int {
	v := r.Get(key)
	n, _ := strconv.Atoi(v)
	return n
}

// GetInt64 resolves a config value as int64, returning 0 on parse failure.
func (r *Registry) GetInt64(key string) int64 {
	v := r.Get(key)
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

// Set writes (or overwrites) a config override in SQLite.
func (r *Registry) Set(ctx context.Context, key, value string) error {
	return r.db.SetConfigOverride(ctx, key, value)
}

// Delete removes a config override, reverting to env/default.
func (r *Registry) Delete(ctx context.Context, key string) error {
	return r.db.DeleteConfigOverride(ctx, key)
}

// All returns every registered entry with its currently resolved value.
// The returned slice is ordered by registration order.
func (r *Registry) All(ctx context.Context) []*gitchatv1.ConfigEntry {
	// Bulk-load overrides to avoid N+1 queries.
	overrides := make(map[string]string)
	if r.db != nil {
		if m, err := r.db.ListConfigOverrides(ctx); err == nil {
			overrides = m
		}
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]*gitchatv1.ConfigEntry, 0, len(r.entries))
	for _, e := range r.entries {
		value := e.Default
		if v := os.Getenv(e.Key); v != "" {
			value = v
		}
		if v, ok := overrides[e.Key]; ok {
			value = v
		}
		out = append(out, &gitchatv1.ConfigEntry{
			Key:          e.Key,
			Value:        value,
			DefaultValue: e.Default,
			Description:  e.Description,
			Group:        e.Group,
		})
	}
	return out
}
