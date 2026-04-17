// Package llm owns the language-model adapter interface and its
// implementations. The interface is deliberately minimal:
//
//   - Stream takes a prompt built from the chat session plus any
//     retrieved context, and returns a channel of chunks.
//   - A chunk is either a token, a usage update, or a terminal Done
//     sentinel (with optional error).
//
// Concrete adapters: openai-compatible (LM Studio / Ollama / vLLM /
// OpenAI itself via BaseURL) and anthropic-native.
package llm

import (
	"context"
	"encoding/json"
)

// Role is the coarse message role sent to the LLM. Mirrors OpenAI's
// chat-completion role enum for wire-level simplicity. "tool" carries
// the result of a prior tool_use; adapters translate it to whichever
// block/role shape the provider expects (Anthropic: a user message
// with a tool_result block; OpenAI: role=tool with tool_call_id).
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// Attachment is a user-uploaded file bundled with a message. Images
// feed into multimodal prompt blocks; adapters that don't support
// images should fall back to a text placeholder so the conversation
// remains intelligible.
type Attachment struct {
	MimeType string
	Filename string
	Data     []byte
}

// ToolCall is one tool_use emitted by an assistant turn. Adapters
// reconstruct it into the provider's native shape when replaying the
// turn on a follow-up request (Anthropic: ToolUseBlockParam; OpenAI:
// ChatCompletionMessage.ToolCalls).
type ToolCall struct {
	ID   string          // provider-assigned unique id (toolu_…, call_…)
	Name string          // tool name as registered in the catalog
	Args json.RawMessage // JSON object matching the tool's input schema
}

// ToolSpec declares a tool the model may invoke. Passed on every
// Request so adapters can advertise the catalog to the provider.
type ToolSpec struct {
	Name        string
	Description string
	InputSchema json.RawMessage
}

// Message is one turn in the prompt. Semantics depend on Role:
//
//   - system/user: Content is the prose body; Attachments carry any
//     files the user uploaded with this turn.
//   - assistant: Content is the prose body; ToolCalls carries any
//     tool_use blocks the assistant emitted on that turn, in order.
//     A prompt reconstructing history must place ToolCalls alongside
//     the text so the provider can match them to the tool_result
//     messages that follow.
//   - tool: carries the result of a prior tool_use. ToolUseID links
//     back to the ToolCall.ID on the preceding assistant message.
//     Content is the tool's textual output.
type Message struct {
	Role        Role
	Content     string
	Attachments []Attachment
	ToolCalls   []ToolCall
	ToolUseID   string
}

// Request is what the caller hands to an adapter. Model is the
// provider-specific identifier (e.g. "gemma-4-e4b-it" on LM Studio).
// Tools, when non-empty, enables tool_use: the adapter advertises
// them to the provider and the stream may emit ChunkToolUse chunks
// instead of (or interleaved with) text tokens.
type Request struct {
	Model       string
	Messages    []Message
	Temperature float32 // 0 = deterministic
	MaxTokens   int     // 0 = provider default
	Tools       []ToolSpec
}

// ChunkKind describes what a chunk carries. An adapter always emits
// exactly one ChunkDone terminal chunk and then closes its channel.
// A stream may also emit any number of ChunkToolUse events before
// the terminal ChunkDone when the model has chosen to invoke tools;
// the caller is expected to execute them and issue a follow-up
// Request that carries the ToolCalls on the assistant message plus a
// tool-role message per result.
type ChunkKind int

const (
	ChunkToken ChunkKind = iota
	ChunkDone
	ChunkToolUse
	// ChunkReasoning carries incremental chain-of-thought from a
	// reasoning model (Qwen3, DeepSeek-R1, o1, Claude thinking, …).
	// Separate from ChunkToken so callers can render it distinctly —
	// typically as a collapsible trace above the final answer — and
	// so it isn't confused with the assistant's actual reply.
	ChunkReasoning
)

// Chunk is one streaming unit from an adapter.
type Chunk struct {
	Kind ChunkKind

	// Populated when Kind == ChunkToken.
	Token string

	// Populated when Kind == ChunkToolUse.
	// Provider adapters buffer the incremental input_json deltas and
	// emit one ChunkToolUse with the fully-assembled Args once the
	// tool_use block terminates. Callers treat Args as opaque JSON.
	ToolUseID string
	ToolName  string
	ToolArgs  json.RawMessage

	// Populated when Kind == ChunkReasoning.
	Reasoning string

	// Populated when Kind == ChunkDone.
	TokenCountIn  int
	TokenCountOut int
	StopReason    string // e.g. "end_turn", "tool_use", "max_tokens"
	Error         string // non-empty → stream ended with an error
}

// Capabilities describes what an adapter/model combination supports.
// Used by the service layer to decide whether to strip incompatible
// attachments before calling Stream (with a soft warning to the UI)
// instead of handing a request to the model that the model will
// silently ignore or reject.
type Capabilities struct {
	// Images is true when the model accepts image parts in multimodal
	// prompts. False for text-only models and when capability
	// discovery could not determine support.
	Images bool
}

// LLM is the adapter-facing interface. Implementations are stateless
// and safe for concurrent use — callers construct one per process and
// share it across goroutines.
type LLM interface {
	// Stream sends req and returns a channel of chunks. The channel is
	// closed after a ChunkDone is delivered. A non-nil error means the
	// request could not be started at all; errors after the channel is
	// returned flow through Chunk.Error on the terminal chunk.
	Stream(ctx context.Context, req Request) (<-chan Chunk, error)

	// Capabilities reports what this adapter/model combination
	// supports. Implementations should cache probe results internally
	// since callers may invoke this on every request. Never blocks
	// indefinitely — adapters must apply their own timeout when
	// talking to external discovery endpoints.
	Capabilities(ctx context.Context, model string) Capabilities
}
