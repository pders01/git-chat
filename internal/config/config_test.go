package config_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/storage"
)

func openTestDB(t *testing.T) *storage.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := storage.Open(path)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestRegistryGetDefault(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("FOO", "42", "test key", "test")

	if got := r.Get("FOO"); got != "42" {
		t.Fatalf("expected default 42, got %q", got)
	}
	if got := r.GetInt("FOO"); got != 42 {
		t.Fatalf("expected 42, got %d", got)
	}
}

func TestRegistryGetEnvOverride(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("TEST_CFG_KEY", "10", "test", "test")

	t.Setenv("TEST_CFG_KEY", "99")

	if got := r.GetInt("TEST_CFG_KEY"); got != 99 {
		t.Fatalf("expected env override 99, got %d", got)
	}
}

func TestRegistryGetDBOverride(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("TEST_CFG_DB", "10", "test", "test")

	// Env var set but DB should win.
	t.Setenv("TEST_CFG_DB", "50")

	ctx := context.Background()
	if err := r.Set(ctx, "TEST_CFG_DB", "200"); err != nil {
		t.Fatalf("set: %v", err)
	}

	if got := r.GetInt("TEST_CFG_DB"); got != 200 {
		t.Fatalf("expected DB override 200, got %d", got)
	}
}

func TestRegistryAll(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("A_KEY", "1", "desc a", "grp")
	r.Register("B_KEY", "2", "desc b", "grp")

	ctx := context.Background()
	_ = r.Set(ctx, "A_KEY", "override")

	entries := r.All(ctx)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Value != "override" {
		t.Fatalf("expected A_KEY=override, got %q", entries[0].Value)
	}
	if entries[0].DefaultValue != "1" {
		t.Fatalf("expected A_KEY default=1, got %q", entries[0].DefaultValue)
	}
	if entries[1].Value != "2" {
		t.Fatalf("expected B_KEY=2, got %q", entries[1].Value)
	}
}

func TestRegistryDuplicateRegister(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("DUP", "first", "first reg", "g")
	r.Register("DUP", "second", "second reg", "g")

	// First registration wins.
	if got := r.Get("DUP"); got != "first" {
		t.Fatalf("expected first, got %q", got)
	}

	ctx := context.Background()
	entries := r.All(ctx)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
}

func TestRegistryDelete(t *testing.T) {
	db := openTestDB(t)
	r := config.New(db)
	r.Register("DEL_KEY", "default", "test", "test")

	ctx := context.Background()
	_ = r.Set(ctx, "DEL_KEY", "override")
	if got := r.Get("DEL_KEY"); got != "override" {
		t.Fatalf("expected override, got %q", got)
	}

	_ = r.Delete(ctx, "DEL_KEY")

	// Ensure env is clean.
	os.Unsetenv("DEL_KEY")

	if got := r.Get("DEL_KEY"); got != "default" {
		t.Fatalf("expected default after delete, got %q", got)
	}
}

func TestStorageConfigCRUD(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	// Initially empty.
	m, err := db.ListConfigOverrides(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 0 {
		t.Fatalf("expected empty, got %d", len(m))
	}

	// Set a value.
	if err := db.SetConfigOverride(ctx, "k1", "v1"); err != nil {
		t.Fatal(err)
	}

	v, ok, err := db.GetConfigOverride(ctx, "k1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || v != "v1" {
		t.Fatalf("expected v1, got %q ok=%v", v, ok)
	}

	// Missing key.
	_, ok, err = db.GetConfigOverride(ctx, "missing")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected missing key to return false")
	}

	// Upsert.
	if err := db.SetConfigOverride(ctx, "k1", "v2"); err != nil {
		t.Fatal(err)
	}
	v, _, _ = db.GetConfigOverride(ctx, "k1")
	if v != "v2" {
		t.Fatalf("expected v2 after upsert, got %q", v)
	}

	// Delete.
	if err := db.DeleteConfigOverride(ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	_, ok, _ = db.GetConfigOverride(ctx, "k1")
	if ok {
		t.Fatal("expected deleted")
	}
}
