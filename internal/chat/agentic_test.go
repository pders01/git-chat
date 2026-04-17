package chat_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/auth"
	"github.com/pders01/git-chat/internal/chat"
	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/chat/tools"
	"github.com/pders01/git-chat/internal/repo"
	"github.com/pders01/git-chat/internal/storage"
)

// TestAgenticLoopExecutesToolAndContinues verifies that a scripted
// Fake adapter driving a tool_use → tool_result → final-text sequence
// is wired correctly through StreamMessage: the tool registry runs
// against the real repo fixture, the ToolCall/ToolResult chunks are
// forwarded, and the second LLM round sees the tool's output in
// its prompt.
func TestAgenticLoopExecutesToolAndContinues(t *testing.T) {
	ctx := auth.WithPrincipal(context.Background(), "test@local",
		gitchatv1.AuthMode_AUTH_MODE_LOCAL)

	// ── Temp fixture: a repo with a README whose contents the fake
	// model is going to request via a read_file tool call.
	dir := t.TempDir()
	r, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := r.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"),
		[]byte("agentic loop fixture body.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Add("README.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Commit("initial", &git.CommitOptions{
		Author: &object.Signature{Name: "t", Email: "t@t", When: time.Now()},
	}); err != nil {
		t.Fatal(err)
	}

	registry := repo.NewRegistry()
	entry, err := registry.Add(dir)
	if err != nil {
		t.Fatal(err)
	}

	dbPath := filepath.Join(t.TempDir(), "state.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// ── Script the fake: first round emits a read_file tool_use,
	// second round emits a short final answer that references the
	// file content.
	fake := &llm.Fake{
		Scripted: []llm.FakeScript{
			{
				Text: "Let me check.",
				ToolUses: []llm.ToolCall{{
					ID:   "toolu_1",
					Name: "read_file",
					Args: json.RawMessage(`{"path":"README.md"}`),
				}},
				StopReason: "tool_use",
			},
			{
				Text:       "Done — fixture body read.",
				StopReason: "end_turn",
			},
		},
	}

	svc := &chat.Service{
		DB:                db,
		LLM:               fake,
		Repos:             registry,
		Model:             "fake",
		Tools:             tools.Default(),
		DisableSmartTitle: true,
	}

	var tokens strings.Builder
	var toolCalls []*gitchatv1.ToolCall
	var toolResults []*gitchatv1.ToolResult
	var done *gitchatv1.Done
	err = svc.StreamMessage(ctx, &gitchatv1.SendMessageRequest{
		RepoId: entry.ID,
		Text:   "what does the README say?",
	}, func(c *gitchatv1.MessageChunk) error {
		switch k := c.Kind.(type) {
		case *gitchatv1.MessageChunk_Token:
			tokens.WriteString(k.Token)
		case *gitchatv1.MessageChunk_ToolCall:
			toolCalls = append(toolCalls, k.ToolCall)
		case *gitchatv1.MessageChunk_ToolResult:
			toolResults = append(toolResults, k.ToolResult)
		case *gitchatv1.MessageChunk_Done:
			done = k.Done
		}
		return nil
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if done == nil {
		t.Fatal("expected done chunk")
	}
	if done.Error != "" {
		t.Fatalf("unexpected done error: %q", done.Error)
	}
	if len(toolCalls) != 1 || toolCalls[0].Name != "read_file" {
		t.Fatalf("expected one read_file tool call, got %+v", toolCalls)
	}
	if len(toolResults) != 1 {
		t.Fatalf("expected one tool result, got %d", len(toolResults))
	}
	if !strings.Contains(toolResults[0].Content, "agentic loop fixture body") {
		t.Fatalf("tool result should carry file body, got %q", toolResults[0].Content)
	}
	if !strings.Contains(tokens.String(), "Done") {
		t.Fatalf("final-round text missing from stream: %q", tokens.String())
	}

	// The fake captured every Request; the second round must have
	// seen the tool_use + tool_result in history.
	if len(fake.Requests) != 2 {
		t.Fatalf("expected 2 LLM rounds, got %d", len(fake.Requests))
	}
	second := fake.Requests[1]
	sawToolCall := false
	sawToolResult := false
	for _, m := range second.Messages {
		if m.Role == llm.RoleAssistant && len(m.ToolCalls) > 0 {
			sawToolCall = true
		}
		if m.Role == llm.RoleTool && strings.Contains(m.Content, "agentic loop fixture body") {
			sawToolResult = true
		}
	}
	if !sawToolCall || !sawToolResult {
		t.Fatalf("round 2 prompt missing tool_use/tool_result (sawCall=%v sawResult=%v)",
			sawToolCall, sawToolResult)
	}
}
