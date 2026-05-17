package config_test

import (
	"context"
	"testing"

	"github.com/pders01/git-chat/internal/config"
	"github.com/pders01/git-chat/internal/storage"
)

func TestRegisterDefaultsGroups(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := storage.Open(path)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()

	r := config.New(db)
	config.RegisterDefaults(r)

	ctx := context.Background()
	entries := r.All(ctx)

	groups := make(map[string]int)
	for _, e := range entries {
		groups[e.Group]++
	}

	t.Logf("Total: %d, groups: %v", len(entries), groups)

	if groups["chat"] == 0 {
		t.Errorf("expected chat group entries, got %d", groups["chat"])
	}
	if groups["session"] == 0 {
		t.Errorf("expected session group entries, got %d", groups["session"])
	}
	if groups["repo"] == 0 {
		t.Errorf("expected repo group entries, got %d", groups["repo"])
	}
}
