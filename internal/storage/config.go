package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// ConfigStore is the interface the config registry depends on.
// Satisfied by *DB; tests can substitute a stub.
type ConfigStore interface {
	GetConfigOverride(ctx context.Context, key string) (string, bool, error)
	SetConfigOverride(ctx context.Context, key, value string) error
	SetConfigOverrides(ctx context.Context, kvs map[string]string) error
	DeleteConfigOverride(ctx context.Context, key string) error
	ListConfigOverrides(ctx context.Context) (map[string]string, error)
}

// GetConfigOverride returns the SQLite-persisted override for key.
// The bool is false when no override exists.
func (d *DB) GetConfigOverride(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := d.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// SetConfigOverride upserts a config override into SQLite.
func (d *DB) SetConfigOverride(ctx context.Context, key, value string) error {
	_, err := d.ExecContext(ctx, `
		INSERT INTO config (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	return err
}

// DeleteConfigOverride removes a config override, reverting to env/default.
func (d *DB) DeleteConfigOverride(ctx context.Context, key string) error {
	_, err := d.ExecContext(ctx, `DELETE FROM config WHERE key = ?`, key)
	return err
}

// SetConfigOverrides upserts multiple config overrides atomically in a
// single transaction. All writes succeed or none do.
func (d *DB) SetConfigOverrides(ctx context.Context, kvs map[string]string) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO config (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()
	for k, v := range kvs {
		if _, err := stmt.ExecContext(ctx, k, v); err != nil {
			return fmt.Errorf("set %s: %w", k, err)
		}
	}
	return tx.Commit()
}

// ListConfigOverrides returns all persisted overrides as a map.
func (d *DB) ListConfigOverrides(ctx context.Context) (map[string]string, error) {
	rows, err := d.QueryContext(ctx, `SELECT key, value FROM config WHERE key NOT IN (?, ?)`, catalogCacheKey, catalogCacheTSKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

const (
	catalogCacheKey   = "__catalog_cache__"
	catalogCacheTSKey = "__catalog_cache_ts__"
)

// GetCatalogCache loads the cached provider catalog from SQLite.
func (d *DB) GetCatalogCache(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	var raw string
	err := d.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, catalogCacheKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || raw == "" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []*gitchatv1.CatalogProvider
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetCatalogCacheTime returns when the catalog cache was last written,
// or a zero time if unknown (legacy pre-TTL cache or no cache at all).
func (d *DB) GetCatalogCacheTime(ctx context.Context) (time.Time, error) {
	var raw string
	err := d.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, catalogCacheTSKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || raw == "" {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return time.Time{}, nil
	}
	return time.Unix(n, 0), nil
}

// SetCatalogCache persists the provider catalog to SQLite and records
// the write time. Both rows are written in a single transaction so a
// partial failure can't leave a blob without its timestamp.
func (d *DB) SetCatalogCache(ctx context.Context, providers []*gitchatv1.CatalogProvider) error {
	data, err := json.Marshal(providers)
	if err != nil {
		return err
	}
	return d.SetConfigOverrides(ctx, map[string]string{
		catalogCacheKey:   string(data),
		catalogCacheTSKey: strconv.FormatInt(time.Now().Unix(), 10),
	})
}
