package llm

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Anthropic implements the LLM interface using the official Anthropic
// Messages API. Construct once at startup via NewAnthropic and share
// across goroutines — the underlying client is stateless.
type Anthropic struct {
	client anthropic.Client
}

// NewAnthropic constructs an Anthropic adapter. apiKey is required
// (no anonymous access). Model is specified per-request via Request.Model.
func NewAnthropic(apiKey string) *Anthropic {
	client := anthropic.NewClient(
		option.WithAPIKey(apiKey),
	)
	return &Anthropic{client: client}
}

// Stream issues a streaming Messages request and returns a channel of
// Chunks. The system message (if present) is extracted from the
// messages list and placed into the API's dedicated System field —
// Anthropic's API does not accept "system" as a message role.
func (a *Anthropic) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	var systemBlocks []anthropic.TextBlockParam
	var msgs []anthropic.MessageParam

	for _, m := range req.Messages {
		switch m.Role {
		case RoleSystem:
			systemBlocks = append(systemBlocks, anthropic.TextBlockParam{
				Text: m.Content,
				Type: "text",
			})
		case RoleUser:
			msgs = append(msgs, anthropic.NewUserMessage(buildUserBlocks(m)...))
		case RoleAssistant:
			msgs = append(msgs, anthropic.NewAssistantMessage(
				anthropic.NewTextBlock(m.Content),
			))
		}
	}

	maxTokens := int64(req.MaxTokens)
	if maxTokens <= 0 {
		maxTokens = 4096
	}

	params := anthropic.MessageNewParams{
		Model:     req.Model,
		Messages:  msgs,
		System:    systemBlocks,
		MaxTokens: maxTokens,
	}

	stream := a.client.Messages.NewStreaming(ctx, params)

	out := make(chan Chunk, 16)
	go func() {
		defer close(out)

		var inTokens, outTokens int
		var errMsg string

		for stream.Next() {
			event := stream.Current()
			switch event.Type {
			case "content_block_delta":
				// Text delta carries the incremental token.
				if event.Delta.Text != "" {
					select {
					case out <- Chunk{Kind: ChunkToken, Token: event.Delta.Text}:
					case <-ctx.Done():
						errMsg = ctx.Err().Error()
						goto done
					}
				}
			case "message_start":
				// Initial message carries input token count.
				if event.Message.Usage.InputTokens > 0 {
					inTokens = int(event.Message.Usage.InputTokens)
				}
			case "message_delta":
				// Final delta carries output token count.
				if event.Usage.OutputTokens > 0 {
					outTokens = int(event.Usage.OutputTokens)
				}
			}
		}
		if err := stream.Err(); err != nil {
			errMsg = fmt.Sprintf("anthropic: stream error: %v", err)
		}

	done:
		select {
		case out <- Chunk{
			Kind:          ChunkDone,
			TokenCountIn:  inTokens,
			TokenCountOut: outTokens,
			Error:         errMsg,
		}:
		case <-ctx.Done():
		}
	}()
	return out, nil
}

// Capabilities reports vision support for the given Claude model.
// Anthropic's /v1/models endpoint does not surface a vision flag, so
// we rely on the public model ladder: every Claude 3, Claude 3.5,
// Claude 3.7, and Claude 4 family model ships with image support.
// Retired Claude 2 / Claude Instant are treated as text-only.
func (a *Anthropic) Capabilities(_ context.Context, model string) Capabilities {
	m := strings.ToLower(model)
	switch {
	case strings.HasPrefix(m, "claude-3"),
		strings.HasPrefix(m, "claude-4"),
		strings.HasPrefix(m, "claude-opus-"),
		strings.HasPrefix(m, "claude-sonnet-"),
		strings.HasPrefix(m, "claude-haiku-"):
		return Capabilities{Images: true}
	}
	return Capabilities{}
}

// buildUserBlocks turns a user Message plus any attachments into the
// ordered slice of content blocks Anthropic expects. Images become
// base64 image blocks; plain-text attachments are folded into the
// trailing text block so the model sees their content with a visible
// header. The user's own text always comes last so it reads naturally
// against the context above.
func buildUserBlocks(m Message) []anthropic.ContentBlockParamUnion {
	if len(m.Attachments) == 0 {
		return []anthropic.ContentBlockParamUnion{anthropic.NewTextBlock(m.Content)}
	}
	blocks := make([]anthropic.ContentBlockParamUnion, 0, len(m.Attachments)+1)
	var textFolds []string
	for _, a := range m.Attachments {
		if strings.HasPrefix(a.MimeType, "image/") {
			blocks = append(blocks, anthropic.NewImageBlockBase64(
				a.MimeType,
				base64.StdEncoding.EncodeToString(a.Data),
			))
			continue
		}
		if strings.HasPrefix(a.MimeType, "text/") {
			name := a.Filename
			if name == "" {
				name = "attachment"
			}
			textFolds = append(textFolds, fmt.Sprintf("--- %s ---\n%s", name, string(a.Data)))
		}
	}
	var textBody strings.Builder
	for _, f := range textFolds {
		textBody.WriteString(f)
		textBody.WriteString("\n\n")
	}
	textBody.WriteString(m.Content)
	blocks = append(blocks, anthropic.NewTextBlock(textBody.String()))
	return blocks
}
