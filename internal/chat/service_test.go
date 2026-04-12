package chat_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/gen/go/gitchat/v1/gitchatv1connect"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
)

// testRig bundles everything a chat test needs: a temp git repo with a
// README (so baseline context injection has something to find), a SQLite
// DB, the repo registry, the Fake LLM, and an authenticated Connect
// client. The rig is per-test so tests stay isolated.
type testRig struct {
	t        *testing.T
	Client   gitchatv1connect.ChatServiceClient
	LLM      *llm.Fake
	DB       *storage.DB
	Registry *repo.Registry
	RepoID   string
}

func newRig(t *testing.T) *testRig {
	t.Helper()

	// ── Temp repo with a tiny README so overviewDoc() has something to grab.
	repoDir := t.TempDir()
	r, err := git.PlainInit(repoDir, false)
	if err != nil {
		t.Fatalf("git init: %v", err)
	}
	w, err := r.Worktree()
	if err != nil {
		t.Fatalf("worktree: %v", err)
	}
	// Lay out a realistic shape: a couple of root files, plus a nested
	// subdirectory so baselineTree's 2-level walk has something to
	// descend into. Without the subdirectory, the depth-2 codepath is
	// uncovered by tests.
	mustWrite(t, filepath.Join(repoDir, "README.md"), "# test repo\nused by chat tests.\n")
	mustWrite(t, filepath.Join(repoDir, "main.go"), "package main\n\nfunc main() {}\n")
	mustWrite(t, filepath.Join(repoDir, "internal", "auth", "service.go"), "package auth\n")
	mustWrite(t, filepath.Join(repoDir, "internal", "repo", "reader.go"), "package repo\n")
	if _, err := w.Add("README.md"); err != nil {
		t.Fatalf("add README: %v", err)
	}
	if _, err := w.Add("main.go"); err != nil {
		t.Fatalf("add main.go: %v", err)
	}
	if _, err := w.Add("internal/auth/service.go"); err != nil {
		t.Fatalf("add internal/auth/service.go: %v", err)
	}
	if _, err := w.Add("internal/repo/reader.go"); err != nil {
		t.Fatalf("add internal/repo/reader.go: %v", err)
	}
	if _, err := w.Commit("initial", &git.CommitOptions{
		Author: &object.Signature{Name: "t", Email: "t@t", When: time.Now()},
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}

	registry := repo.NewRegistry()
	entry, err := registry.Add(repoDir)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// ── Temp SQLite DB.
	dbPath := filepath.Join(t.TempDir(), "state.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// ── Fake LLM returning a canned reply.
	fake := llm.NewFake("Hello from the fake LLM.")

	svc := &chat.Service{
		DB:                db,
		LLM:               fake,
		Repos:             registry,
		Model:             "fake",
		DisableSmartTitle: true,
	}

	// ── Connect handler + auth injection.
	mux := http.NewServeMux()
	path, handler := gitchatv1connect.NewChatServiceHandler(svc)
	mux.Handle(path, handler)
	withAuth := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := auth.WithPrincipal(r.Context(), "test@local", gitchatv1.AuthMode_AUTH_MODE_LOCAL)
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
	srv := httptest.NewServer(withAuth)
	t.Cleanup(srv.Close)

	client := gitchatv1connect.NewChatServiceClient(http.DefaultClient, srv.URL)
	return &testRig{
		t:        t,
		Client:   client,
		LLM:      fake,
		DB:       db,
		Registry: registry,
		RepoID:   entry.ID,
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// drain consumes the server-stream and returns the concatenated token
// text plus the terminal Done payload.
func drain(t *testing.T, stream *connect.ServerStreamForClient[gitchatv1.MessageChunk]) (string, *gitchatv1.Done) {
	t.Helper()
	var tokens strings.Builder
	var done *gitchatv1.Done
	for stream.Receive() {
		msg := stream.Msg()
		switch k := msg.Kind.(type) {
		case *gitchatv1.MessageChunk_Token:
			tokens.WriteString(k.Token)
		case *gitchatv1.MessageChunk_Done:
			done = k.Done
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("stream err: %v", err)
	}
	return tokens.String(), done
}

// ─── Tests ──────────────────────────────────────────────────────────────

func TestSendMessageCreatesSessionAndStreams(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "hello there",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	tokens, done := drain(t, stream)

	if !strings.Contains(tokens, "fake") {
		t.Fatalf("expected tokens to include 'fake', got %q", tokens)
	}
	if done == nil {
		t.Fatal("expected done chunk")
	}
	if done.SessionId == "" {
		t.Fatal("done missing session_id")
	}
	if done.Model != "fake" {
		t.Fatalf("done.Model = %q, want fake", done.Model)
	}
	if done.Error != "" {
		t.Fatalf("unexpected error in done: %q", done.Error)
	}

	// ── Verify both turns were persisted.
	get, err := rig.Client.GetSession(ctx, connect.NewRequest(&gitchatv1.GetSessionRequest{
		SessionId: done.SessionId,
	}))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(get.Msg.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(get.Msg.Messages))
	}
	if get.Msg.Messages[0].Content != "hello there" {
		t.Fatalf("user turn content: %q", get.Msg.Messages[0].Content)
	}
	if !strings.Contains(get.Msg.Messages[1].Content, "fake") {
		t.Fatalf("assistant turn content: %q", get.Msg.Messages[1].Content)
	}
}

func TestBaselineContextIncludesTreeAndOverview(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "what's here?",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	_, _ = drain(t, stream)

	// ── Inspect what we actually sent to the fake LLM.
	var sys string
	for _, m := range rig.LLM.LastRequest.Messages {
		if m.Role == llm.RoleSystem {
			sys = m.Content
			break
		}
	}
	if sys == "" {
		t.Fatal("expected a system message")
	}
	// Top-level listing should name README.md, main.go, and the
	// internal/ directory.
	if !strings.Contains(sys, "README.md") || !strings.Contains(sys, "main.go") {
		t.Fatalf("expected top-level listing in system prompt, got:\n%s", sys)
	}
	if !strings.Contains(sys, "internal/") {
		t.Fatalf("expected internal/ directory in top-level listing, got:\n%s", sys)
	}
	// Level 2 walk should also list internal's direct children (the
	// auth/ and repo/ subdirectories). Without this, the "grounding"
	// pitch of baselineTree doesn't hold up — the model would still
	// have to guess at paths below the top level.
	if !strings.Contains(sys, "internal/ (dirs: auth/, repo/") {
		t.Fatalf("expected level-2 listing for internal/, got:\n%s", sys)
	}
	// Overview section should appear because README.md exists.
	if !strings.Contains(sys, "Project overview") {
		t.Fatalf("expected overview block in system prompt, got:\n%s", sys)
	}
	if !strings.Contains(sys, "test repo") {
		t.Fatalf("expected README body in overview, got:\n%s", sys)
	}
}

func TestAtFileInjectionShowsContent(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "explain @main.go",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	_, _ = drain(t, stream)

	var sys string
	for _, m := range rig.LLM.LastRequest.Messages {
		if m.Role == llm.RoleSystem {
			sys = m.Content
			break
		}
	}
	if !strings.Contains(sys, "Files you were shown") {
		t.Fatalf("expected @file block in system prompt, got:\n%s", sys)
	}
	if !strings.Contains(sys, "package main") {
		t.Fatalf("expected main.go body in injected block, got:\n%s", sys)
	}
}

// TestAtFileInjectionFuzzyHint verifies that a near-miss @-mention
// picks up a "did you mean …" suggestion from the actual repo file
// list. The fixture has `internal/auth/service.go`; we mention
// `internal/auth/sevice.go` (missing an r) and expect the real path
// to come back as a suggestion.
func TestAtFileInjectionFuzzyHint(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "explain @internal/auth/sevice.go",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	_, _ = drain(t, stream)

	var sys string
	for _, m := range rig.LLM.LastRequest.Messages {
		if m.Role == llm.RoleSystem {
			sys = m.Content
			break
		}
	}
	if !strings.Contains(sys, "NOT FOUND") {
		t.Fatalf("expected NOT FOUND for typo'd path, got:\n%s", sys)
	}
	if !strings.Contains(sys, "Did you mean") {
		t.Fatalf("expected Did you mean hint, got:\n%s", sys)
	}
	if !strings.Contains(sys, "`internal/auth/service.go`") {
		t.Fatalf("expected real path in suggestion, got:\n%s", sys)
	}
}

// TestAtFileInjectionNegativeResult verifies that an @-mention for a
// nonexistent path produces an explicit NOT FOUND entry instead of
// being silently dropped. Without this signal, the LLM can't tell the
// difference between "user didn't mention anything" and "user mentioned
// a path that missed," which causes the apology-loop bug where it
// keeps asking the user to re-send the same @-reference.
func TestAtFileInjectionNegativeResult(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "explain @internal/fake/nonexistent.go",
	}))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	_, _ = drain(t, stream)

	var sys string
	for _, m := range rig.LLM.LastRequest.Messages {
		if m.Role == llm.RoleSystem {
			sys = m.Content
			break
		}
	}
	if !strings.Contains(sys, "Files you were shown") {
		t.Fatalf("expected @file block even for missing path, got:\n%s", sys)
	}
	if !strings.Contains(sys, "internal/fake/nonexistent.go") {
		t.Fatalf("expected missing path to appear in @file block, got:\n%s", sys)
	}
	if !strings.Contains(sys, "NOT FOUND") {
		t.Fatalf("expected NOT FOUND marker for missing path, got:\n%s", sys)
	}
}

func TestListSessionsAndDelete(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	// ── Create two sessions.
	for _, text := range []string{"first question", "second question"} {
		stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
			RepoId: rig.RepoID,
			Text:   text,
		}))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = drain(t, stream)
		// Give updated_at a chance to differ between sessions so ordering
		// is deterministic.
		time.Sleep(1100 * time.Millisecond)
	}

	list, err := rig.Client.ListSessions(ctx, connect.NewRequest(&gitchatv1.ListSessionsRequest{
		RepoId: rig.RepoID,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Msg.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(list.Msg.Sessions))
	}
	// Newest first — the title might have been updated by the async
	// smart-title goroutine, so we check ordering by updated_at
	// rather than by exact title text.
	if list.Msg.Sessions[0].UpdatedAt < list.Msg.Sessions[1].UpdatedAt {
		t.Fatalf("expected newest session first; got updated_at %d before %d",
			list.Msg.Sessions[0].UpdatedAt, list.Msg.Sessions[1].UpdatedAt)
	}

	// ── Delete one.
	deletedID := list.Msg.Sessions[0].Id
	_, err = rig.Client.DeleteSession(ctx, connect.NewRequest(&gitchatv1.DeleteSessionRequest{
		SessionId: deletedID,
	}))
	if err != nil {
		t.Fatalf("delete: %v", err)
	}

	list2, err := rig.Client.ListSessions(ctx, connect.NewRequest(&gitchatv1.ListSessionsRequest{
		RepoId: rig.RepoID,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(list2.Msg.Sessions) != 1 {
		t.Fatalf("expected 1 session after delete, got %d", len(list2.Msg.Sessions))
	}
}

// TestHistoryDiffMarkerExpansion verifies that when a prior assistant
// turn contains a `[[diff …]]` marker, the next turn's LLM request
// has the marker replaced with a fenced diff code block carrying
// real patch content. Without this, follow-up questions like
// "explain those changes" hit a dead end because the LLM's context
// only holds the raw marker text.
func TestHistoryDiffMarkerExpansion(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	// Turn 1: ask a question; the fake LLM emits "[[diff]]" as its
	// response. We override the Reply field so the assistant turn
	// persisted in history contains the marker.
	rig.LLM.Reply = "Here [[diff]] it is."
	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "show me the last change",
	}))
	if err != nil {
		t.Fatalf("send 1: %v", err)
	}
	_, done := drain(t, stream)
	if done == nil || done.SessionId == "" {
		t.Fatal("expected turn 1 to produce a session id")
	}
	sessionID := done.SessionId

	// Turn 2: continue the SAME session by passing its id. The
	// prompt the server sends to the fake LLM should contain the
	// prior assistant turn with the marker *expanded* into real
	// patch text, not the raw marker.
	rig.LLM.Reply = "ok"
	stream2, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		SessionId: sessionID,
		RepoId:    rig.RepoID,
		Text:      "explain those changes",
	}))
	if err != nil {
		t.Fatalf("send 2: %v", err)
	}
	_, _ = drain(t, stream2)

	// Inspect the second request's assistant turn in the message
	// array. The fake adapter exposes LastRequest so we can verify
	// what the LLM actually saw.
	var assistantInHistory string
	for _, m := range rig.LLM.LastRequest.Messages {
		if m.Role == llm.RoleAssistant {
			assistantInHistory = m.Content
			break
		}
	}
	if assistantInHistory == "" {
		t.Fatal("expected an assistant turn in the second request's history")
	}
	if strings.Contains(assistantInHistory, "[[diff]]") {
		t.Fatalf("expected marker to be expanded, still contains [[diff]]:\n%s",
			assistantInHistory)
	}
	if !strings.Contains(assistantInHistory, "```diff") {
		t.Fatalf("expected fenced diff block in expansion, got:\n%s",
			assistantInHistory)
	}
	// The fixture has an initial commit, so HEAD has no parent. The
	// whole-commit diff against HEAD^ would actually fail — but our
	// fixture has TWO commits? No, just one. This test uses the
	// "base" fixture where there's only one commit, so the whole-
	// commit diff against parent is the initial add of the files.
	// Either way: content should mention one of the fixture files.
	if !strings.Contains(assistantInHistory, "main.go") &&
		!strings.Contains(assistantInHistory, "README.md") {
		t.Fatalf("expected fixture file path in expanded diff, got:\n%s",
			assistantInHistory)
	}
}

// TestKBFastPath verifies the M5 knowledge-card pipeline with the
// N-threshold promotion (N=2): first ask goes to the LLM but does
// NOT create a card (below threshold). Second ask also goes to the
// LLM but triggers promotion (threshold met). Third ask is served
// from the cache (card_hit chunk, no LLM call).
func TestKBFastPath(t *testing.T) {
	rig := newRig(t)
	ctx := context.Background()

	question := "explain @main.go"

	// Ask 1: LLM answers. Below promotion threshold — no card yet.
	stream, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   question,
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = drain(t, stream)
	time.Sleep(200 * time.Millisecond)

	// Ask 2: same question, new session. Now the FTS5 count = 2
	// (two user messages with this question), so maybePromoteCard
	// creates the card.
	stream2, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   question,
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = drain(t, stream2)
	time.Sleep(200 * time.Millisecond)

	// Ask 3: same question again. Should now get a card_hit chunk
	// instead of a token stream.
	rig.LLM.Reply = "THIS SHOULD NOT APPEAR"
	stream3, err := rig.Client.SendMessage(ctx, connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   question,
	}))
	if err != nil {
		t.Fatal(err)
	}

	var gotCardHit bool
	var hitAnswer string
	for stream3.Receive() {
		msg := stream3.Msg()
		switch k := msg.Kind.(type) {
		case *gitchatv1.MessageChunk_CardHit:
			gotCardHit = true
			hitAnswer = k.CardHit.AnswerMd
		case *gitchatv1.MessageChunk_Token:
			t.Fatalf("expected card_hit, got token: %q", k.Token)
		}
	}
	if err := stream3.Err(); err != nil {
		t.Fatalf("stream3 err: %v", err)
	}
	if !gotCardHit {
		t.Fatal("expected card_hit chunk on third identical question")
	}
	if !strings.Contains(hitAnswer, "fake") {
		t.Fatalf("expected cached answer, got: %q", hitAnswer)
	}
}

func TestLLMStartErrorSurfacesInDone(t *testing.T) {
	rig := newRig(t)
	rig.LLM.StartError = &fakeError{"model not loaded"}

	stream, err := rig.Client.SendMessage(context.Background(), connect.NewRequest(&gitchatv1.SendMessageRequest{
		RepoId: rig.RepoID,
		Text:   "anything",
	}))
	if err != nil {
		t.Fatalf("unexpected top-level error: %v", err)
	}
	tokens, done := drain(t, stream)
	if tokens != "" {
		t.Fatalf("expected no tokens, got %q", tokens)
	}
	if done == nil {
		t.Fatal("expected done chunk")
	}
	if !strings.Contains(done.Error, "model not loaded") {
		t.Fatalf("expected LLM error in done, got %q", done.Error)
	}
}

type fakeError struct{ msg string }

func (e *fakeError) Error() string { return e.msg }
