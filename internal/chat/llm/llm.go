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

import "context"

// Role is the coarse message role sent to the LLM. Mirrors OpenAI's
// chat-completion role enum for wire-level simplicity.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Message is one turn in the prompt.
type Message struct {
	Role    Role
	Content string
}

// Request is what the caller hands to an adapter. Model is the
// provider-specific identifier (e.g. "gemma-4-e4b-it" on LM Studio).
type Request struct {
	Model       string
	Messages    []Message
	Temperature float32 // 0 = deterministic
	MaxTokens   int     // 0 = provider default
}

// ChunkKind describes what a chunk carries. An adapter always emits
// exactly one ChunkDone terminal chunk and then closes its channel.
type ChunkKind int

const (
	ChunkToken ChunkKind = iota
	ChunkDone
)

// Chunk is one streaming unit from an adapter.
type Chunk struct {
	Kind ChunkKind

	// Populated when Kind == ChunkToken.
	Token string

	// Populated when Kind == ChunkDone.
	TokenCountIn  int
	TokenCountOut int
	Error         string // non-empty → stream ended with an error
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
}
