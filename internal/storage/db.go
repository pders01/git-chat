// Package storage owns the SQLite database for git-chat. It holds chat
// sessions, messages, and the FTS5-backed knowledge-card tables.
//
// The driver is `modernc.org/sqlite` — pure Go, no CGO — so the final
// binary stays statically linkable and cross-compilation Just Works.
package storage

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// DB wraps *sql.DB and remembers the file path for diagnostic logging.
type DB struct {
	*sql.DB
	Path string
}

// Open opens (or creates) the SQLite database at path, enables WAL mode
// and foreign keys, then runs pending migrations. The parent directory is
// created with 0700 perms if it doesn't exist.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("ensure dir: %w", err)
	}
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	db := &DB{DB: sqlDB, Path: path}
	if err := db.migrate(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

// migrate applies every `NNN_*.sql` file in `migrations/` that has not yet
// been recorded in `schema_migrations`. Migration files run in filename
// order; each one executes in its own transaction alongside the matching
// `schema_migrations` row insert.
func (d *DB) migrate() error {
	if _, err := d.Exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`); err != nil {
		return err
	}

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, f := range files {
		version := strings.TrimSuffix(f, ".sql")
		var dummy int
		err := d.QueryRow(`SELECT 1 FROM schema_migrations WHERE version = ?`, version).Scan(&dummy)
		if err == nil {
			continue // already applied
		}
		body, err := fs.ReadFile(migrationsFS, "migrations/"+f)
		if err != nil {
			return err
		}
		tx, err := d.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s: %w", version, err)
		}
		if _, err := tx.Exec(
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, strftime('%s','now'))`,
			version,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// DefaultPath returns the git-chat state.db location. Respects
// $XDG_STATE_HOME, falls back to ~/.local/state/git-chat/state.db.
// Like the auth configDir, we do NOT use os.UserCacheDir() — developer
// tooling lives under ~/.local/state on macOS, not ~/Library.
func DefaultPath() (string, error) {
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" {
		return filepath.Join(xdg, "git-chat", "state.db"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state", "git-chat", "state.db"), nil
}
