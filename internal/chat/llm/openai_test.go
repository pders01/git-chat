package llm

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	openai "github.com/sashabaranov/go-openai"
)

// ---------------------------------------------------------------------------
// nameLooksVisionCapable
// ---------------------------------------------------------------------------

func TestNameLooksVisionCapable(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"gpt-4o", true},
		{"gpt-4-vision-preview", true},
		{"llava-7b", true},
		{"gemma3-4b", true},
		{"gemma-3-27b", true},
		{"gpt-3.5-turbo", false},
		{"llama-3.1-8b", false},
		{"mistral-7b", false},
		{"qwen2.5-vl-72b", true},
		{"pixtral-12b", true},
		// case insensitive
		{"GPT-4o", true},
		{"GPT-4-VISION-PREVIEW", true},
		{"LLAVA-13B", true},
		{"Pixtral-Large", true},
	}
	for _, tc := range cases {
		if got := nameLooksVisionCapable(tc.model); got != tc.want {
			t.Errorf("nameLooksVisionCapable(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// matchesEnvAllowlist
// ---------------------------------------------------------------------------

func TestMatchesEnvAllowlist(t *testing.T) {
	t.Run("unset env returns false", func(t *testing.T) {
		t.Setenv("GITCHAT_VISION_MODELS", "")
		if matchesEnvAllowlist("anything") {
			t.Error("expected false when env is empty")
		}
	})

	t.Run("substring match", func(t *testing.T) {
		t.Setenv("GITCHAT_VISION_MODELS", "llava,custom-vision")
		if !matchesEnvAllowlist("custom-vision-7b") {
			t.Error("expected true for substring match custom-vision in custom-vision-7b")
		}
	})

	t.Run("no match", func(t *testing.T) {
		t.Setenv("GITCHAT_VISION_MODELS", "llava")
		if matchesEnvAllowlist("mistral") {
			t.Error("expected false for non-matching model")
		}
	})

	t.Run("case insensitive", func(t *testing.T) {
		t.Setenv("GITCHAT_VISION_MODELS", "LLAVA")
		if !matchesEnvAllowlist("llava-7b") {
			t.Error("expected case-insensitive match")
		}
	})

	t.Run("case insensitive model", func(t *testing.T) {
		t.Setenv("GITCHAT_VISION_MODELS", "llava")
		if !matchesEnvAllowlist("LLAVA-13B") {
			t.Error("expected case-insensitive match on model side")
		}
	})
}

// ---------------------------------------------------------------------------
// collapseSystemMessages
// ---------------------------------------------------------------------------

func TestCollapseSystemMessages(t *testing.T) {
	t.Run("two consecutive system messages", func(t *testing.T) {
		in := []Message{
			{Role: RoleSystem, Content: "You are helpful."},
			{Role: RoleSystem, Content: "Be concise."},
		}
		out := collapseSystemMessages(in)
		if len(out) != 1 {
			t.Fatalf("want 1 message, got %d", len(out))
		}
		if out[0].Role != RoleSystem {
			t.Fatalf("role = %v, want system", out[0].Role)
		}
		want := "You are helpful.\n\nBe concise."
		if out[0].Content != want {
			t.Errorf("content = %q, want %q", out[0].Content, want)
		}
	})

	t.Run("system user system not collapsed across gap", func(t *testing.T) {
		in := []Message{
			{Role: RoleSystem, Content: "sys1"},
			{Role: RoleUser, Content: "hello"},
			{Role: RoleSystem, Content: "sys2"},
		}
		out := collapseSystemMessages(in)
		if len(out) != 3 {
			t.Fatalf("want 3 messages, got %d", len(out))
		}
		if out[0].Role != RoleSystem || out[0].Content != "sys1" {
			t.Errorf("msg[0] = %+v", out[0])
		}
		if out[1].Role != RoleUser || out[1].Content != "hello" {
			t.Errorf("msg[1] = %+v", out[1])
		}
		if out[2].Role != RoleSystem || out[2].Content != "sys2" {
			t.Errorf("msg[2] = %+v", out[2])
		}
	})

	t.Run("single system unchanged", func(t *testing.T) {
		in := []Message{{Role: RoleSystem, Content: "only one"}}
		out := collapseSystemMessages(in)
		if len(out) != 1 || out[0].Content != "only one" {
			t.Errorf("unexpected: %+v", out)
		}
	})

	t.Run("no system messages", func(t *testing.T) {
		in := []Message{
			{Role: RoleUser, Content: "hi"},
			{Role: RoleAssistant, Content: "hello"},
		}
		out := collapseSystemMessages(in)
		if len(out) != 2 {
			t.Fatalf("want 2, got %d", len(out))
		}
	})

	t.Run("empty input", func(t *testing.T) {
		out := collapseSystemMessages(nil)
		if len(out) != 0 {
			t.Fatalf("want 0, got %d", len(out))
		}
	})
}

// ---------------------------------------------------------------------------
// buildOpenAIMessage
// ---------------------------------------------------------------------------

func TestBuildOpenAIMessage(t *testing.T) {
	t.Run("plain text user message", func(t *testing.T) {
		m := Message{Role: RoleUser, Content: "hello world"}
		got := buildOpenAIMessage(m)
		if got.Role != "user" {
			t.Errorf("role = %q", got.Role)
		}
		if got.Content != "hello world" {
			t.Errorf("content = %q", got.Content)
		}
		if got.MultiContent != nil {
			t.Error("expected nil MultiContent for plain text")
		}
	})

	t.Run("tool role message", func(t *testing.T) {
		m := Message{Role: RoleTool, Content: "result data", ToolUseID: "call_123"}
		got := buildOpenAIMessage(m)
		if got.Role != "tool" {
			t.Errorf("role = %q", got.Role)
		}
		if got.ToolCallID != "call_123" {
			t.Errorf("ToolCallID = %q", got.ToolCallID)
		}
		if got.Content != "result data" {
			t.Errorf("content = %q", got.Content)
		}
	})

	t.Run("assistant with tool calls", func(t *testing.T) {
		m := Message{
			Role:    RoleAssistant,
			Content: "Let me check.",
			ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read_file", Args: json.RawMessage(`{"path":"foo.go"}`)},
				{ID: "call_2", Name: "list_dir", Args: json.RawMessage(`{"dir":"."}`)},
			},
		}
		got := buildOpenAIMessage(m)
		if got.Role != "assistant" {
			t.Errorf("role = %q", got.Role)
		}
		if len(got.ToolCalls) != 2 {
			t.Fatalf("want 2 tool calls, got %d", len(got.ToolCalls))
		}
		tc0 := got.ToolCalls[0]
		if tc0.ID != "call_1" || tc0.Function.Name != "read_file" {
			t.Errorf("tc[0] = %+v", tc0)
		}
		if tc0.Function.Arguments != `{"path":"foo.go"}` {
			t.Errorf("tc[0].args = %q", tc0.Function.Arguments)
		}
		if tc0.Type != openai.ToolTypeFunction {
			t.Errorf("tc[0].type = %v", tc0.Type)
		}
		tc1 := got.ToolCalls[1]
		if tc1.ID != "call_2" || tc1.Function.Name != "list_dir" {
			t.Errorf("tc[1] = %+v", tc1)
		}
	})

	t.Run("image attachment produces MultiContent", func(t *testing.T) {
		m := Message{
			Role:    RoleUser,
			Content: "What is this?",
			Attachments: []Attachment{
				{MimeType: "image/png", Filename: "pic.png", Data: []byte{0x89, 0x50}},
			},
		}
		got := buildOpenAIMessage(m)
		if got.MultiContent == nil {
			t.Fatal("expected MultiContent for image attachment")
		}
		// Should have image_url part + text part
		if len(got.MultiContent) != 2 {
			t.Fatalf("want 2 parts, got %d", len(got.MultiContent))
		}
		imgPart := got.MultiContent[0]
		if imgPart.Type != openai.ChatMessagePartTypeImageURL {
			t.Errorf("part[0].type = %v", imgPart.Type)
		}
		if imgPart.ImageURL == nil {
			t.Fatal("expected ImageURL")
		}
		if imgPart.ImageURL.URL == "" {
			t.Error("expected non-empty image URL")
		}
		textPart := got.MultiContent[1]
		if textPart.Type != openai.ChatMessagePartTypeText {
			t.Errorf("part[1].type = %v", textPart.Type)
		}
		if textPart.Text != "What is this?" {
			t.Errorf("part[1].text = %q", textPart.Text)
		}
	})

	t.Run("text attachment folded into content", func(t *testing.T) {
		m := Message{
			Role:    RoleUser,
			Content: "Summarise this.",
			Attachments: []Attachment{
				{MimeType: "text/plain", Filename: "notes.txt", Data: []byte("some notes")},
			},
		}
		got := buildOpenAIMessage(m)
		if got.MultiContent != nil {
			t.Error("expected nil MultiContent for text-only attachment")
		}
		if got.Content == "" {
			t.Fatal("expected non-empty content")
		}
		// Should contain the attachment text and the original content.
		if !strings.Contains(got.Content, "notes.txt") {
			t.Errorf("content missing filename: %q", got.Content)
		}
		if !strings.Contains(got.Content, "some notes") {
			t.Errorf("content missing attachment data: %q", got.Content)
		}
		if !strings.Contains(got.Content, "Summarise this.") {
			t.Errorf("content missing original message: %q", got.Content)
		}
	})

	t.Run("mixed image and text attachments", func(t *testing.T) {
		m := Message{
			Role:    RoleUser,
			Content: "Describe both.",
			Attachments: []Attachment{
				{MimeType: "image/jpeg", Filename: "photo.jpg", Data: []byte{0xFF, 0xD8}},
				{MimeType: "text/plain", Filename: "caption.txt", Data: []byte("a caption")},
			},
		}
		got := buildOpenAIMessage(m)
		if got.MultiContent == nil {
			t.Fatal("expected MultiContent for mixed attachments")
		}
		// image part + text part (text attachment folded into the text part)
		if len(got.MultiContent) != 2 {
			t.Fatalf("want 2 parts, got %d", len(got.MultiContent))
		}
		imgPart := got.MultiContent[0]
		if imgPart.Type != openai.ChatMessagePartTypeImageURL {
			t.Errorf("part[0].type = %v", imgPart.Type)
		}
		textPart := got.MultiContent[1]
		if textPart.Type != openai.ChatMessagePartTypeText {
			t.Errorf("part[1].type = %v", textPart.Type)
		}
		// Text part should contain both the caption attachment and original content.
		if !strings.Contains(textPart.Text, "a caption") {
			t.Errorf("text part missing caption: %q", textPart.Text)
		}
		if !strings.Contains(textPart.Text, "Describe both.") {
			t.Errorf("text part missing original: %q", textPart.Text)
		}
	})
}

// ---------------------------------------------------------------------------
// parseHermesToolCalls (additional cases beyond hermes_test.go)
// ---------------------------------------------------------------------------

func TestParseHermesToolCallsMalformed(t *testing.T) {
	// Missing <function=...> inside the tool_call block.
	raw := `<tool_call>this has no function tag</tool_call>`
	got := parseHermesToolCalls(raw)
	if len(got) != 0 {
		t.Fatalf("want 0 for malformed block, got %d", len(got))
	}
}

func TestParseHermesToolCallsSequentialIDs(t *testing.T) {
	raw := `<tool_call><function=foo><parameter=a>1</parameter></function></tool_call>
<tool_call><function=bar><parameter=b>2</parameter></function></tool_call>
<tool_call><function=baz><parameter=c>3</parameter></function></tool_call>`
	chunks := parseHermesToolCalls(raw)
	if len(chunks) != 3 {
		t.Fatalf("want 3, got %d", len(chunks))
	}
	for i, c := range chunks {
		if c.Kind != ChunkToolUse {
			t.Errorf("chunk[%d].Kind = %v, want ChunkToolUse", i, c.Kind)
		}
		wantID := fmt.Sprintf("call_hermes_%d", i)
		if c.ToolUseID != wantID {
			t.Errorf("chunk[%d].ToolUseID = %q, want %q", i, c.ToolUseID, wantID)
		}
	}
	if chunks[0].ToolName != "foo" || chunks[1].ToolName != "bar" || chunks[2].ToolName != "baz" {
		t.Errorf("names: %q %q %q", chunks[0].ToolName, chunks[1].ToolName, chunks[2].ToolName)
	}
}

