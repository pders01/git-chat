package storage

import (
	"context"
	"path/filepath"
	"testing"
)

// testDB creates a fresh SQLite database in a temp directory.
// Migrations run automatically via Open().
func testDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// ── Session CRUD ────────────────────────────────────────────

func TestCreateAndGetSession(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	s, err := db.CreateSession(ctx, "s1", "alice", "repo1", "Hello")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s.ID != "s1" || s.Principal != "alice" || s.RepoID != "repo1" {
		t.Fatalf("unexpected session: %+v", s)
	}

	got, err := db.GetSession(ctx, "alice", "s1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Title != "Hello" {
		t.Fatalf("title = %q, want Hello", got.Title)
	}
}

func TestGetSessionWrongPrincipal(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Hello")

	_, err := db.GetSession(ctx, "bob", "s1")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestGetSessionNotFound(t *testing.T) {
	db := testDB(t)
	_, err := db.GetSession(context.Background(), "alice", "nonexistent")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestListSessionsOrder(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.CreateSession(ctx, "s1", "alice", "repo1", "First")
	db.CreateSession(ctx, "s2", "alice", "repo1", "Second")
	db.CreateSession(ctx, "s3", "alice", "repo1", "Third")

	// Pin second session.
	db.PinSession(ctx, "alice", "s2", true)

	sessions, err := db.ListSessions(ctx, "alice", "repo1", 10, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 3 {
		t.Fatalf("got %d sessions, want 3", len(sessions))
	}
	// Pinned session should be first.
	if sessions[0].ID != "s2" {
		t.Fatalf("first session should be pinned s2, got %s", sessions[0].ID)
	}
	if !sessions[0].Pinned {
		t.Fatal("s2 should be pinned")
	}
}

func TestListSessionsPrincipalIsolation(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.CreateSession(ctx, "s1", "alice", "repo1", "Alice's")
	db.CreateSession(ctx, "s2", "bob", "repo1", "Bob's")

	sessions, err := db.ListSessions(ctx, "alice", "repo1", 10, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "s1" {
		t.Fatalf("expected only alice's session, got %+v", sessions)
	}
}

func TestDeleteSession(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Doomed")

	if err := db.DeleteSession(ctx, "alice", "s1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, err := db.GetSession(ctx, "alice", "s1")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestDeleteSessionWrongPrincipal(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Protected")

	err := db.DeleteSession(ctx, "bob", "s1")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound for wrong principal, got %v", err)
	}
}

func TestUpdateSessionTitle(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Old")
	db.UpdateSessionTitle(ctx, "s1", "New")

	got, _ := db.GetSession(ctx, "alice", "s1")
	if got.Title != "New" {
		t.Fatalf("title = %q, want New", got.Title)
	}
}

func TestPinUnpinSession(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Test")

	db.PinSession(ctx, "alice", "s1", true)
	got, _ := db.GetSession(ctx, "alice", "s1")
	if !got.Pinned {
		t.Fatal("should be pinned")
	}

	db.PinSession(ctx, "alice", "s1", false)
	got, _ = db.GetSession(ctx, "alice", "s1")
	if got.Pinned {
		t.Fatal("should be unpinned")
	}
}

// ── Message CRUD ────────────────────────────────────────────

func TestCreateAndListMessages(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Test")

	db.CreateMessage(ctx, MessageRow{
		ID: "m1", SessionID: "s1", Role: "user", Content: "hello",
	})
	db.CreateMessage(ctx, MessageRow{
		ID: "m2", SessionID: "s1", Role: "assistant", Content: "hi back",
		Model: "gpt-4",
	})

	msgs, err := db.ListMessages(ctx, "s1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].Content != "hello" || msgs[1].Content != "hi back" {
		t.Fatalf("unexpected message order: %+v", msgs)
	}
	if msgs[1].Model != "gpt-4" {
		t.Fatalf("model = %q, want gpt-4", msgs[1].Model)
	}
}

func TestUpdateMessageContent(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Test")
	db.CreateMessage(ctx, MessageRow{
		ID: "m1", SessionID: "s1", Role: "assistant", Content: "partial",
	})

	db.UpdateMessageContent(ctx, "m1", "full response", 100, 50)

	msgs, _ := db.ListMessages(ctx, "s1")
	if msgs[0].Content != "full response" {
		t.Fatalf("content = %q, want 'full response'", msgs[0].Content)
	}
	if msgs[0].TokenCountIn != 100 || msgs[0].TokenCountOut != 50 {
		t.Fatalf("tokens = (%d, %d), want (100, 50)", msgs[0].TokenCountIn, msgs[0].TokenCountOut)
	}
}

func TestSessionMessageCount(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.CreateSession(ctx, "s1", "alice", "repo1", "Test")
	db.CreateMessage(ctx, MessageRow{ID: "m1", SessionID: "s1", Role: "user", Content: "a"})
	db.CreateMessage(ctx, MessageRow{ID: "m2", SessionID: "s1", Role: "assistant", Content: "b"})

	got, _ := db.GetSession(ctx, "alice", "s1")
	if got.MessageCount != 2 {
		t.Fatalf("message count = %d, want 2", got.MessageCount)
	}
}

// ── KB Card CRUD ────────────────────────────────────────────

func TestUpsertAndGetCard(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	id, err := db.UpsertCard(ctx, CardRow{
		ID:                 "c1",
		RepoID:             "repo1",
		QuestionNormalized: "what is this project",
		AnswerMD:           "It's git-chat.",
		Model:              "gpt-4",
		CreatedCommit:      "abc123",
		LastVerifiedCommit: "abc123",
		CreatedBy:          "alice",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if id != "c1" {
		t.Fatalf("id = %q, want c1", id)
	}

	card, err := db.GetCard(ctx, "c1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if card.AnswerMD != "It's git-chat." {
		t.Fatalf("answer = %q", card.AnswerMD)
	}
}

func TestUpsertCardConflictUpdates(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "what is this",
		AnswerMD: "old answer", Model: "gpt-4",
		CreatedCommit: "abc", LastVerifiedCommit: "abc", CreatedBy: "alice",
	})
	// Upsert same question — should update answer.
	db.UpsertCard(ctx, CardRow{
		ID: "c2", RepoID: "repo1", QuestionNormalized: "what is this",
		AnswerMD: "new answer", Model: "gpt-4o",
		CreatedCommit: "def", LastVerifiedCommit: "def", CreatedBy: "alice",
	})

	// Should return original ID (c1), not c2.
	card, _ := db.GetCard(ctx, "c1")
	if card.AnswerMD != "new answer" {
		t.Fatalf("answer not updated: %q", card.AnswerMD)
	}
}

func TestDeleteCard(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "q",
		AnswerMD: "a", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	if err := db.DeleteCard(ctx, "c1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := db.DeleteCard(ctx, "c1"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound on double delete, got %v", err)
	}
}

func TestDeleteCardScoped(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "q",
		AnswerMD: "a", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	// Bob cannot delete Alice's card.
	if err := db.DeleteCardScoped(ctx, "c1", "bob"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound for wrong principal, got %v", err)
	}

	// Alice can delete her own card.
	if err := db.DeleteCardScoped(ctx, "c1", "alice"); err != nil {
		t.Fatalf("delete by owner: %v", err)
	}

	// Double delete returns ErrNotFound.
	if err := db.DeleteCardScoped(ctx, "c1", "alice"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound on double delete, got %v", err)
	}
}

func TestListCards(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "q1",
		AnswerMD: "a1", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})
	db.UpsertCard(ctx, CardRow{
		ID: "c2", RepoID: "repo1", QuestionNormalized: "q2",
		AnswerMD: "a2", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})
	// Different repo — should not appear.
	db.UpsertCard(ctx, CardRow{
		ID: "c3", RepoID: "repo2", QuestionNormalized: "q3",
		AnswerMD: "a3", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	cards, err := db.ListCards(ctx, "repo1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(cards) != 2 {
		t.Fatalf("got %d cards, want 2", len(cards))
	}
}

func TestInvalidateAndFindCard(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "what is this project",
		AnswerMD: "answer", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	// Should find valid card.
	card, err := db.FindValidCard(ctx, "repo1", "what is this project")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if card.ID != "c1" {
		t.Fatalf("found wrong card: %s", card.ID)
	}

	// Invalidate — should no longer be found.
	db.InvalidateCard(ctx, "c1")
	_, err = db.FindValidCard(ctx, "repo1", "what is this project")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after invalidation, got %v", err)
	}
}

func TestIncrementCardHit(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "q",
		AnswerMD: "a", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	db.IncrementCardHit(ctx, "c1")
	db.IncrementCardHit(ctx, "c1")

	card, _ := db.GetCard(ctx, "c1")
	if card.HitCount != 2 {
		t.Fatalf("hit count = %d, want 2", card.HitCount)
	}
}

// ── Provenance ──────────────────────────────────────────────

func TestReplaceAndListProvenance(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "q",
		AnswerMD: "a", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	prov := []ProvenanceRow{
		{CardID: "c1", Path: "main.go", BlobSHA: "aaa"},
		{CardID: "c1", Path: "lib/foo.go", BlobSHA: "bbb"},
	}
	if err := db.ReplaceProvenance(ctx, "c1", prov); err != nil {
		t.Fatalf("replace: %v", err)
	}

	got, err := db.ListProvenance(ctx, "c1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d rows, want 2", len(got))
	}
	// Sorted by path.
	if got[0].Path != "lib/foo.go" || got[1].Path != "main.go" {
		t.Fatalf("unexpected order: %+v", got)
	}

	// Replace again — should clear old rows.
	db.ReplaceProvenance(ctx, "c1", []ProvenanceRow{
		{CardID: "c1", Path: "new.go", BlobSHA: "ccc"},
	})
	got, _ = db.ListProvenance(ctx, "c1")
	if len(got) != 1 || got[0].Path != "new.go" {
		t.Fatalf("replace didn't clear old rows: %+v", got)
	}
}

// ── Config overrides ────────────────────────────────────────

func TestConfigOverrideCRUD(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	// Initially empty.
	val, ok, err := db.GetConfigOverride(ctx, "LLM_MODEL")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if ok {
		t.Fatal("should not exist yet")
	}

	// Set.
	db.SetConfigOverride(ctx, "LLM_MODEL", "gpt-4o")
	val, ok, _ = db.GetConfigOverride(ctx, "LLM_MODEL")
	if !ok || val != "gpt-4o" {
		t.Fatalf("got (%q, %v), want (gpt-4o, true)", val, ok)
	}

	// Upsert.
	db.SetConfigOverride(ctx, "LLM_MODEL", "claude-4")
	val, ok, _ = db.GetConfigOverride(ctx, "LLM_MODEL")
	if val != "claude-4" {
		t.Fatalf("upsert failed: %q", val)
	}

	// List.
	db.SetConfigOverride(ctx, "LLM_TEMP", "0.5")
	all, err := db.ListConfigOverrides(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("got %d overrides, want 2", len(all))
	}

	// Delete.
	db.DeleteConfigOverride(ctx, "LLM_MODEL")
	_, ok, _ = db.GetConfigOverride(ctx, "LLM_MODEL")
	if ok {
		t.Fatal("should be deleted")
	}
}

// ── Search ──────────────────────────────────────────────────

func TestSearchMessages(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.CreateSession(ctx, "s1", "alice", "repo1", "Auth Discussion")
	db.CreateMessage(ctx, MessageRow{ID: "m1", SessionID: "s1", Role: "user", Content: "how does authentication work"})
	db.CreateMessage(ctx, MessageRow{ID: "m2", SessionID: "s1", Role: "assistant", Content: "SSH key pairing flow"})

	db.CreateSession(ctx, "s2", "bob", "repo1", "Bob's Chat")
	db.CreateMessage(ctx, MessageRow{ID: "m3", SessionID: "s2", Role: "user", Content: "authentication setup"})

	// Alice should only see her own messages.
	results, err := db.SearchMessages(ctx, "authentication", "alice", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1 (alice only)", len(results))
	}
	if results[0].ID != "s1" {
		t.Fatalf("result ID should be session ID s1, got %s", results[0].ID)
	}
}

func TestSearchCards(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.UpsertCard(ctx, CardRow{
		ID: "c1", RepoID: "repo1", QuestionNormalized: "how does authentication work",
		AnswerMD: "SSH key pairing", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})
	db.UpsertCard(ctx, CardRow{
		ID: "c2", RepoID: "repo1", QuestionNormalized: "what is the database schema",
		AnswerMD: "SQLite with FTS5", CreatedCommit: "x", LastVerifiedCommit: "x", CreatedBy: "alice",
	})

	results, err := db.SearchCards(ctx, "authentication", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if results[0].ID != "c1" {
		t.Fatalf("expected c1, got %s", results[0].ID)
	}
}

func TestSearchEmptyQuery(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	results, err := db.SearchMessages(ctx, "", "alice", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if results != nil {
		t.Fatalf("empty query should return nil, got %+v", results)
	}
}

func TestSearchSpecialChars(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()

	db.CreateSession(ctx, "s1", "alice", "repo1", "Test")
	db.CreateMessage(ctx, MessageRow{ID: "m1", SessionID: "s1", Role: "user", Content: "check @main.go file"})

	// FTS5 special chars should be sanitized, not cause query errors.
	results, err := db.SearchMessages(ctx, "@main.go", "alice", 10)
	if err != nil {
		t.Fatalf("search with special chars should not error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
}

// ── FTS5 sanitize ───────────────────────────────────────────

func TestFTS5Sanitize(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"hello world", "hello world"},
		{"@main.go", "main go"},
		{`"quoted" OR NOT`, "quoted OR NOT"},
		{"  spaces   ", "spaces"},
		{"", ""},
		{"***", ""},
	}
	for _, tt := range tests {
		got := fts5Sanitize(tt.in)
		if got != tt.want {
			t.Errorf("fts5Sanitize(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ── NormalizeQuestion ───────────────────────────────────────

func TestNormalizeQuestion(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"What is THIS?", "what is this?"},
		{"  spaced   out  ", "spaced out"},
		{"UPPER", "upper"},
	}
	for _, tt := range tests {
		got := NormalizeQuestion(tt.in)
		if got != tt.want {
			t.Errorf("NormalizeQuestion(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ── Migrations ──────────────────────────────────────────────

func TestMigrationsIdempotent(t *testing.T) {
	db := testDB(t)
	// Running migrate again should be a no-op.
	if err := db.migrate(); err != nil {
		t.Fatalf("second migrate failed: %v", err)
	}
}
