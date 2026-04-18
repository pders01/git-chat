// Package config provides a centralized, queryable configuration registry.
//
// Resolution order: SQLite override → os.Getenv → compiled default.
// All entries are registered at init time with metadata (key, default,
// description, group) so the UI can display and edit them.
package config

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

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
	encKey  []byte // AES-256 key for secret entries; nil = no encryption
}

// Entry describes a single configuration knob.
type Entry struct {
	Key         string
	Default     string
	Description string
	Group       string // "llm", "chat", "repo", "session"
	Secret      bool   // true for API keys / tokens — encrypted at rest, masked in API
	Restricted  bool   // true = only "local" principal may set via API
}

// New creates a Registry backed by the given ConfigStore.
func New(db storage.ConfigStore) *Registry {
	return &Registry{
		byKey: make(map[string]*Entry),
		db:    db,
	}
}

// InitEncryption loads (or creates) the AES-256 key for encrypting
// secret config values. dbPath is the SQLite database path — the key
// file is stored alongside it. Must be called before any Get/Set of
// secret entries; safe to skip if no secrets are registered.
func (r *Registry) InitEncryption(dbPath string) error {
	key, err := loadOrCreateKey(dbPath)
	if err != nil {
		return err
	}
	r.encKey = key
	return nil
}

// Register adds a config entry to the registry. Duplicate keys are
// silently ignored (first registration wins).
func (r *Registry) Register(key, defaultVal, desc, group string) {
	r.registerFull(key, defaultVal, desc, group, false, false)
}

// RegisterSecret is like Register but marks the entry as a secret.
// Secret values are encrypted at rest, masked when returned via All(),
// and restricted to the "local" principal for API updates.
func (r *Registry) RegisterSecret(key, defaultVal, desc, group string) {
	r.registerFull(key, defaultVal, desc, group, true, true)
}

// RegisterRestricted is like Register but restricts API updates to the
// "local" principal. Use for keys that affect security-sensitive
// behaviour (e.g. LLM base URL, webhook URL).
func (r *Registry) RegisterRestricted(key, defaultVal, desc, group string) {
	r.registerFull(key, defaultVal, desc, group, false, true)
}

func (r *Registry) registerFull(key, defaultVal, desc, group string, secret, restricted bool) {
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
		Secret:      secret,
		Restricted:  restricted,
	}
	r.entries = append(r.entries, e)
	r.byKey[key] = &r.entries[len(r.entries)-1]
}

// IsRestricted reports whether a key is marked as restricted (admin-only).
func (r *Registry) IsRestricted(key string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if e, ok := r.byKey[key]; ok {
		return e.Restricted
	}
	return false
}

// EncryptSecret encrypts a plaintext value for storage. Returns the
// original value unchanged if encryption is not initialised.
func (r *Registry) EncryptSecret(plaintext string) (string, error) {
	if r.encKey == nil || plaintext == "" {
		return plaintext, nil
	}
	return encrypt(r.encKey, plaintext)
}

// DecryptSecret decrypts a stored value. Returns the original value
// unchanged if it wasn't encrypted or encryption is not initialised.
func (r *Registry) DecryptSecret(stored string) (string, error) {
	if r.encKey == nil || !isEncrypted(stored) {
		return stored, nil
	}
	return decrypt(r.encKey, strings.TrimPrefix(stored, encPrefix))
}

// Get resolves a config value: DB override → env var → default.
// Returns the compiled default if the key is unknown.
func (r *Registry) Get(key string) string {
	return r.GetCtx(context.Background(), key)
}

// GetCtx is like Get but propagates the caller's context, allowing
// cancellation to abort a slow DB lookup instead of blocking up to 5s.
// Secret values stored with encryption are transparently decrypted.
func (r *Registry) GetCtx(ctx context.Context, key string) string {
	// Check DB override first (with timeout to prevent hanging on slow DB).
	if r.db != nil {
		dbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if v, ok, err := r.db.GetConfigOverride(dbCtx, key); err == nil && ok {
			// Transparently decrypt if the value was encrypted.
			if isEncrypted(v) && r.encKey != nil {
				if plain, err := decrypt(r.encKey, strings.TrimPrefix(v, encPrefix)); err == nil {
					return plain
				}
				slog.Warn("failed to decrypt config value", "key", key)
				return "" // unreadable → treat as unset
			}
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

// GetIntCtx resolves a config value as int, returning fallback when the
// key is unset or its value is unparseable. Use this when you previously
// held a compiled-in default — fallback preserves that contract across
// live reads from the Registry (DB override → env → registered default
// → fallback if all else fails).
func (r *Registry) GetIntCtx(ctx context.Context, key string, fallback int) int {
	v := r.GetCtx(ctx, key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

// GetInt64Ctx is the int64 counterpart of GetIntCtx.
func (r *Registry) GetInt64Ctx(ctx context.Context, key string, fallback int64) int64 {
	v := r.GetCtx(ctx, key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

// GetDurCtx resolves a config value as a time.Duration (Go duration
// string — "30s", "168h"), returning fallback when unset or unparseable.
func (r *Registry) GetDurCtx(ctx context.Context, key string, fallback time.Duration) time.Duration {
	v := r.GetCtx(ctx, key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}

// Set writes (or overwrites) a config override in SQLite.
// Secret entries are encrypted before writing.
func (r *Registry) Set(ctx context.Context, key, value string) error {
	r.mu.RLock()
	entry, isKnown := r.byKey[key]
	r.mu.RUnlock()

	storeVal := value
	if isKnown && entry.Secret && r.encKey != nil && value != "" {
		enc, err := encrypt(r.encKey, value)
		if err != nil {
			return fmt.Errorf("encrypt config value: %w", err)
		}
		storeVal = enc
	}
	return r.db.SetConfigOverride(ctx, key, storeVal)
}

// SetBatch atomically writes multiple config overrides in a single
// transaction. Secret entries are encrypted before writing.
func (r *Registry) SetBatch(ctx context.Context, kvs map[string]string) error {
	r.mu.RLock()
	defer r.mu.RUnlock()

	store := make(map[string]string, len(kvs))
	for k, v := range kvs {
		sv := v
		if e, ok := r.byKey[k]; ok && e.Secret && r.encKey != nil && v != "" {
			enc, err := encrypt(r.encKey, v)
			if err != nil {
				return fmt.Errorf("encrypt %s: %w", k, err)
			}
			sv = enc
		}
		store[k] = sv
	}
	return r.db.SetConfigOverrides(ctx, store)
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
			// Decrypt secret overrides so we can mask them below.
			if e.Secret && isEncrypted(v) && r.encKey != nil {
				if plain, err := decrypt(r.encKey, strings.TrimPrefix(v, encPrefix)); err == nil {
					value = plain
				} else {
					value = "" // undecryptable → treat as unset
				}
			} else {
				value = v
			}
		}
		// Mask secret values — the API should never return plaintext secrets.
		displayValue := value
		if e.Secret {
			displayValue = maskSecret(value)
		}
		out = append(out, &gitchatv1.ConfigEntry{
			Key:          e.Key,
			Value:        displayValue,
			DefaultValue: e.Default,
			Description:  e.Description,
			Group:        e.Group,
			Secret:       e.Secret,
		})
	}
	return out
}
