package llm

import (
	"context"
	"errors"
	"fmt"
	"io"

	openai "github.com/sashabaranov/go-openai"
)

// OpenAI is an adapter for any OpenAI-compatible chat-completions endpoint.
// Construct once at startup and share across goroutines.
type OpenAI struct {
	client *openai.Client
}

// NewOpenAI constructs an OpenAI-compatible adapter.
//
//	baseURL example values:
//	  "http://localhost:1234/v1"  — LM Studio default
//	  "http://localhost:11434/v1" — Ollama default
//	  "https://api.openai.com/v1" — OpenAI itself
//
// apiKey may be empty for local runners that don't care; remote APIs
// require a real key.
func NewOpenAI(baseURL, apiKey string) *OpenAI {
	cfg := openai.DefaultConfig(apiKey)
	if baseURL != "" {
		cfg.BaseURL = baseURL
	}
	return &OpenAI{client: openai.NewClientWithConfig(cfg)}
}

// Stream issues a streaming chat-completion request and fans the SSE
// frames out as typed Chunks. The returned channel is closed after the
// terminal ChunkDone is delivered.
func (o *OpenAI) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	msgs := make([]openai.ChatCompletionMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		msgs = append(msgs, openai.ChatCompletionMessage{
			Role:    string(m.Role),
			Content: m.Content,
		})
	}

	stream, err := o.client.CreateChatCompletionStream(ctx, openai.ChatCompletionRequest{
		Model:       req.Model,
		Messages:    msgs,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
		Stream:      true,
	})
	if err != nil {
		return nil, fmt.Errorf("openai: start stream: %w", err)
	}

	out := make(chan Chunk, 16)
	go func() {
		defer close(out)
		defer stream.Close()

		var in, outTokens int
		var errMsg string

		for {
			resp, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				errMsg = err.Error()
				break
			}
			if len(resp.Choices) == 0 {
				continue
			}
			delta := resp.Choices[0].Delta
			if delta.Content != "" {
				select {
				case out <- Chunk{Kind: ChunkToken, Token: delta.Content}:
				case <-ctx.Done():
					errMsg = ctx.Err().Error()
					goto done
				}
			}
			if resp.Usage != nil {
				in = resp.Usage.PromptTokens
				outTokens = resp.Usage.CompletionTokens
			}
		}
	done:
		select {
		case out <- Chunk{
			Kind:          ChunkDone,
			TokenCountIn:  in,
			TokenCountOut: outTokens,
			Error:         errMsg,
		}:
		case <-ctx.Done():
		}
	}()
	return out, nil
}
