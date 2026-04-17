package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

	// Tool-result messages always flow as a user-role message in
	// Anthropic's schema, so we batch consecutive tool results into a
	// single user message when they arrive back-to-back in history.
	// A buffer holds the in-flight run.
	var pendingToolResults []anthropic.ContentBlockParamUnion
	flushToolResults := func() {
		if len(pendingToolResults) > 0 {
			msgs = append(msgs, anthropic.NewUserMessage(pendingToolResults...))
			pendingToolResults = nil
		}
	}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleSystem:
			flushToolResults()
			systemBlocks = append(systemBlocks, anthropic.TextBlockParam{
				Text: m.Content,
				Type: "text",
			})
		case RoleUser:
			flushToolResults()
			msgs = append(msgs, anthropic.NewUserMessage(buildUserBlocks(m)...))
		case RoleAssistant:
			flushToolResults()
			msgs = append(msgs, anthropic.NewAssistantMessage(buildAssistantBlocks(m)...))
		case RoleTool:
			// Accumulate and flush once we hit the next non-tool
			// message (or the end of the list).
			pendingToolResults = append(pendingToolResults,
				anthropic.NewToolResultBlock(m.ToolUseID, m.Content, false))
		}
	}
	flushToolResults()

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
	if len(req.Tools) > 0 {
		params.Tools = buildAnthropicTools(req.Tools)
	}

	stream := a.client.Messages.NewStreaming(ctx, params)

	out := make(chan Chunk, 16)
	go func() {
		defer close(out)

		var inTokens, outTokens int
		var errMsg, stopReason string
		// Track the active tool_use block, if any. Anthropic streams
		// its JSON input as a sequence of partial_json deltas; we
		// buffer until content_block_stop to emit a single
		// ChunkToolUse with a fully-assembled args payload.
		var toolID, toolName string
		var toolArgs strings.Builder
		inToolBlock := false

		for stream.Next() {
			event := stream.Current()
			switch event.Type {
			case "content_block_start":
				if event.ContentBlock.Type == "tool_use" {
					toolID = event.ContentBlock.ID
					toolName = event.ContentBlock.Name
					toolArgs.Reset()
					inToolBlock = true
				}
			case "content_block_delta":
				if inToolBlock && event.Delta.PartialJSON != "" {
					toolArgs.WriteString(event.Delta.PartialJSON)
					continue
				}
				if event.Delta.Text != "" {
					select {
					case out <- Chunk{Kind: ChunkToken, Token: event.Delta.Text}:
					case <-ctx.Done():
						errMsg = ctx.Err().Error()
						goto done
					}
				}
				// Extended-thinking deltas (claude-opus-4+, sonnet with
				// thinking enabled) arrive with Delta.Type=="thinking_delta"
				// and the text on Delta.Thinking. Stream them out as
				// ChunkReasoning so the UI can render them as a trace
				// without mixing them into the assistant's reply.
				if event.Delta.Thinking != "" {
					select {
					case out <- Chunk{Kind: ChunkReasoning, Reasoning: event.Delta.Thinking}:
					case <-ctx.Done():
						errMsg = ctx.Err().Error()
						goto done
					}
				}
			case "content_block_stop":
				if inToolBlock {
					args := toolArgs.String()
					if args == "" {
						args = "{}" // empty input blocks still need valid JSON
					}
					select {
					case out <- Chunk{
						Kind:      ChunkToolUse,
						ToolUseID: toolID,
						ToolName:  toolName,
						ToolArgs:  json.RawMessage(args),
					}:
					case <-ctx.Done():
						errMsg = ctx.Err().Error()
						goto done
					}
					inToolBlock = false
					toolID, toolName = "", ""
					toolArgs.Reset()
				}
			case "message_start":
				if event.Message.Usage.InputTokens > 0 {
					inTokens = int(event.Message.Usage.InputTokens)
				}
			case "message_delta":
				if event.Usage.OutputTokens > 0 {
					outTokens = int(event.Usage.OutputTokens)
				}
				if event.Delta.StopReason != "" {
					stopReason = string(event.Delta.StopReason)
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
			StopReason:    stopReason,
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

// buildAssistantBlocks rebuilds an assistant message for history replay,
// preserving any tool_use blocks it emitted alongside its text. The
// text block comes first when non-empty so the model sees the prose
// it produced before inspecting the tool calls.
func buildAssistantBlocks(m Message) []anthropic.ContentBlockParamUnion {
	blocks := make([]anthropic.ContentBlockParamUnion, 0, 1+len(m.ToolCalls))
	if strings.TrimSpace(m.Content) != "" {
		blocks = append(blocks, anthropic.NewTextBlock(m.Content))
	}
	for _, tc := range m.ToolCalls {
		var input any
		if len(tc.Args) > 0 {
			if err := json.Unmarshal(tc.Args, &input); err != nil {
				// Anthropic rejects non-JSON input on replay; fall back
				// to an empty object so the turn is still well-formed.
				input = map[string]any{}
			}
		} else {
			input = map[string]any{}
		}
		blocks = append(blocks, anthropic.NewToolUseBlock(tc.ID, input, tc.Name))
	}
	if len(blocks) == 0 {
		// Assistant messages cannot be empty; pad with a space so
		// degenerate history rows (should never happen in practice)
		// don't bomb the request.
		blocks = append(blocks, anthropic.NewTextBlock(" "))
	}
	return blocks
}

// buildAnthropicTools converts our adapter-neutral tool specs into
// anthropic.ToolUnionParam entries. The input_schema is a draft-2020-12
// JSON Schema; we unmarshal it into a generic map so the SDK can
// marshal it back out verbatim against the wire format.
func buildAnthropicTools(specs []ToolSpec) []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(specs))
	for _, s := range specs {
		var schema map[string]any
		if len(s.InputSchema) > 0 {
			_ = json.Unmarshal(s.InputSchema, &schema)
		}
		properties := map[string]any{}
		var required []string
		if schema != nil {
			if p, ok := schema["properties"].(map[string]any); ok {
				properties = p
			}
			if r, ok := schema["required"].([]any); ok {
				for _, name := range r {
					if s, ok := name.(string); ok {
						required = append(required, s)
					}
				}
			}
		}
		tool := anthropic.ToolParam{
			Name:        s.Name,
			Description: anthropic.String(s.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: properties,
				Required:   required,
			},
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tool})
	}
	return out
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
