package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	openai "github.com/sashabaranov/go-openai"
)

// OpenAI is an adapter for any OpenAI-compatible chat-completions endpoint.
// Construct once at startup and share across goroutines.
type OpenAI struct {
	client   *openai.Client
	baseURL  string
	apiKey   string
	http     *http.Client
	capCache sync.Map // model -> Capabilities
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
	return &OpenAI{
		client:  openai.NewClientWithConfig(cfg),
		baseURL: baseURL,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 2 * time.Second},
	}
}

// Capabilities resolves vision support for model. Tries, in order:
//
//  1. An explicit GITCHAT_VISION_MODELS allowlist (comma-separated
//     substrings, case-insensitive) — lets operators mark a specific
//     local model as vision-capable without code changes.
//  2. Ollama's /api/show, which reports the model's projector families
//     (CLIP / mllama indicate vision).
//  3. LM Studio's /api/v0/models, which exposes a "vision" boolean per
//     loaded model.
//  4. A name heuristic against well-known vision-capable model families
//     (gpt-4o, gpt-4-turbo with vision, llava, qwen-vl, gemma3 vision,
//     llama 3.2 vision, mllama, etc.).
//
// Results are cached per-process keyed by model. Probe failures fall
// through to the next strategy; the worst-case answer is "no images",
// which matches the legacy behaviour before this method existed.
func (o *OpenAI) Capabilities(ctx context.Context, model string) Capabilities {
	if cached, ok := o.capCache.Load(model); ok {
		return cached.(Capabilities)
	}
	cap := Capabilities{Images: o.resolveImageSupport(ctx, model)}
	o.capCache.Store(model, cap)
	return cap
}

func (o *OpenAI) resolveImageSupport(ctx context.Context, model string) bool {
	if matchesEnvAllowlist(model) {
		return true
	}
	base := strings.TrimRight(strings.TrimSuffix(o.baseURL, "/v1"), "/")
	if base != "" {
		if v, ok := probeOllamaVision(ctx, o.http, base, model); ok {
			return v
		}
		if v, ok := probeLMStudioVision(ctx, o.http, base, model); ok {
			return v
		}
	}
	return nameLooksVisionCapable(model)
}

// matchesEnvAllowlist returns true when GITCHAT_VISION_MODELS contains a
// comma-separated substring that matches model (case-insensitive).
func matchesEnvAllowlist(model string) bool {
	allow := os.Getenv("GITCHAT_VISION_MODELS")
	if allow == "" {
		return false
	}
	lm := strings.ToLower(model)
	for _, entry := range strings.Split(allow, ",") {
		e := strings.TrimSpace(strings.ToLower(entry))
		if e != "" && strings.Contains(lm, e) {
			return true
		}
	}
	return false
}

// probeOllamaVision queries /api/show and returns (supportsVision, ok).
// ok is false when the endpoint is not reachable or not Ollama.
func probeOllamaVision(ctx context.Context, hc *http.Client, base, model string) (bool, bool) {
	body, _ := json.Marshal(map[string]string{"name": model})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/api/show", strings.NewReader(string(body)))
	if err != nil {
		return false, false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var parsed struct {
		Details struct {
			Families []string `json:"families"`
		} `json:"details"`
		// Newer Ollama builds report projector info under
		// "projector_info" or include a "capabilities" list; accept
		// either so we don't rot with server changes.
		ProjectorInfo map[string]any `json:"projector_info"`
		Capabilities  []string       `json:"capabilities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return false, false
	}
	for _, f := range parsed.Details.Families {
		lf := strings.ToLower(f)
		if lf == "clip" || lf == "mllama" || strings.Contains(lf, "vision") {
			return true, true
		}
	}
	for _, c := range parsed.Capabilities {
		if strings.Contains(strings.ToLower(c), "vision") {
			return true, true
		}
	}
	if len(parsed.ProjectorInfo) > 0 {
		return true, true
	}
	return false, true
}

// probeLMStudioVision queries /api/v0/models and returns (supportsVision,
// ok). LM Studio exposes a per-model `vision` boolean; if the server
// responds but model is missing we return (false, true) so we don't
// fall through to a noisy name heuristic that might disagree.
func probeLMStudioVision(ctx context.Context, hc *http.Client, base, model string) (bool, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v0/models", nil)
	if err != nil {
		return false, false
	}
	resp, err := hc.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var parsed struct {
		Data []struct {
			ID     string `json:"id"`
			Vision bool   `json:"vision"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return false, false
	}
	for _, m := range parsed.Data {
		if strings.EqualFold(m.ID, model) {
			return m.Vision, true
		}
	}
	return false, true
}

// nameLooksVisionCapable recognises model names that are publicly
// documented as multimodal. Kept intentionally conservative — we would
// rather miss a vision model (the user can add it via env override)
// than claim a text-only model can see images.
func nameLooksVisionCapable(model string) bool {
	m := strings.ToLower(model)
	fragments := []string{
		"gpt-4o",
		"gpt-4-vision",
		"gpt-4-turbo",
		"o4-",
		"llava",
		"bakllava",
		"qwen-vl",
		"qwen2-vl",
		"qwen2.5-vl",
		"llama-3.2-vision",
		"llama3.2-vision",
		"mllama",
		"gemma-3",
		"gemma3",
		"moondream",
		"phi-3-vision",
		"phi-4-vision",
		"internvl",
		"minicpm-v",
		"cogvlm",
		"pixtral",
	}
	for _, f := range fragments {
		if strings.Contains(m, f) {
			return true
		}
	}
	return false
}

// Stream issues a streaming chat-completion request and fans the SSE
// frames out as typed Chunks. The returned channel is closed after the
// terminal ChunkDone is delivered.
//
// Tool use: when req.Tools is non-empty the adapter advertises them as
// OpenAI function tools. Assistant turns replayed from history that
// carry ToolCalls are serialised back into ChatCompletionMessage.ToolCalls
// so the model sees the same call/result pairing it produced before.
// Streaming tool_calls arrive as partial deltas indexed by position; we
// buffer per-index and emit one ChunkToolUse per tool once FinishReason
// lands.
func (o *OpenAI) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	// Collapse consecutive system messages into one: some
	// OpenAI-compatible servers reject multiple system roles in a
	// single conversation (llama.cpp, older vLLM). Preserves our
	// stable-prefix-first ordering — server-side prefix cache
	// kicks in just as well since the concatenated string remains
	// identical across turns.
	normalised := collapseSystemMessages(req.Messages)
	msgs := make([]openai.ChatCompletionMessage, 0, len(normalised))
	for _, m := range normalised {
		msgs = append(msgs, buildOpenAIMessage(m))
	}

	apiReq := openai.ChatCompletionRequest{
		Model:       req.Model,
		Messages:    msgs,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
		Stream:      true,
	}
	if len(req.Tools) > 0 {
		apiReq.Tools = buildOpenAITools(req.Tools)
	}

	stream, err := o.client.CreateChatCompletionStream(ctx, apiReq)
	if err != nil {
		return nil, fmt.Errorf("openai: start stream: %w", err)
	}

	out := make(chan Chunk, 16)
	go func() {
		defer close(out)
		defer stream.Close()

		var in, outTokens int
		var errMsg, stopReason string
		// Reasoning models (Qwen3.x, DeepSeek-R1, etc.) stream their
		// chain of thought as `reasoning_content` deltas and the final
		// answer as `content` deltas. Normal responses only use
		// `content`. We buffer the reasoning prefix so that if the
		// provider ends the stream without ever emitting a `content`
		// delta — which happens on some local runners when the model
		// treats a short follow-up answer as "nothing more to say" —
		// we can still surface the reasoning text. If `content` does
		// arrive, the reasoning stays buffered and we skip it, matching
		// the provider's intent.
		var reasoningBuf strings.Builder
		sawContent := false
		// Tool_calls stream in as indexed partial deltas: the first
		// delta for a given index carries the ID + Function.Name; the
		// subsequent deltas carry Function.Arguments piecewise. We
		// accumulate by position and flush each buffered call on
		// FinishReason="tool_calls" (or stream end).
		type pending struct {
			id   string
			name string
			args strings.Builder
		}
		buffers := map[int]*pending{}
		flush := func() error {
			// Emit buffered tool_use chunks in index order so the
			// server-side loop sees them deterministically.
			keys := make([]int, 0, len(buffers))
			for k := range buffers {
				keys = append(keys, k)
			}
			sort.Ints(keys)
			for _, k := range keys {
				b := buffers[k]
				args := b.args.String()
				if args == "" {
					args = "{}"
				}
				select {
				case out <- Chunk{
					Kind:      ChunkToolUse,
					ToolUseID: b.id,
					ToolName:  b.name,
					ToolArgs:  json.RawMessage(args),
				}:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			buffers = map[int]*pending{}
			return nil
		}

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
			choice := resp.Choices[0]
			delta := choice.Delta
			if delta.Content != "" {
				sawContent = true
				select {
				case out <- Chunk{Kind: ChunkToken, Token: delta.Content}:
				case <-ctx.Done():
					errMsg = ctx.Err().Error()
					goto done
				}
			}
			if delta.ReasoningContent != "" {
				reasoningBuf.WriteString(delta.ReasoningContent)
				select {
				case out <- Chunk{Kind: ChunkReasoning, Reasoning: delta.ReasoningContent}:
				case <-ctx.Done():
					errMsg = ctx.Err().Error()
					goto done
				}
			}
			for _, tc := range delta.ToolCalls {
				idx := 0
				if tc.Index != nil {
					idx = *tc.Index
				}
				b, ok := buffers[idx]
				if !ok {
					b = &pending{}
					buffers[idx] = b
				}
				if tc.ID != "" {
					b.id = tc.ID
				}
				if tc.Function.Name != "" {
					b.name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					b.args.WriteString(tc.Function.Arguments)
				}
			}
			if choice.FinishReason != "" {
				stopReason = string(choice.FinishReason)
				if choice.FinishReason == openai.FinishReasonToolCalls && len(buffers) > 0 {
					if err := flush(); err != nil {
						errMsg = err.Error()
						goto done
					}
				}
			}
			if resp.Usage != nil {
				in = resp.Usage.PromptTokens
				outTokens = resp.Usage.CompletionTokens
			}
		}
		// Belt-and-braces: some local runners close the stream without
		// a FinishReason. Flush anything we've buffered so the service
		// loop still sees the tool calls.
		if len(buffers) > 0 {
			if err := flush(); err != nil && errMsg == "" {
				errMsg = err.Error()
			}
		}
		// Hermes-style fallback: some OpenAI-compatible servers (notably
		// LM Studio serving Qwen3.x) route the model's tool invocations
		// into reasoning_content as <tool_call>…</tool_call> XML blocks
		// instead of populating the structured tool_calls field, which
		// breaks the agentic loop. If the stream produced no structured
		// tool calls and no normal content, look for Hermes XML in the
		// reasoning buffer and synthesise ChunkToolUse events so the
		// service layer can still execute them. If no tool calls show
		// up either, the reasoning text is the actual answer — surface
		// it as tokens so the user sees something instead of an empty
		// bubble at the end of the agentic loop.
		if !sawContent && len(buffers) == 0 && reasoningBuf.Len() > 0 {
			hermes := parseHermesToolCalls(reasoningBuf.String())
			for _, tc := range hermes {
				select {
				case out <- tc:
				case <-ctx.Done():
					if errMsg == "" {
						errMsg = ctx.Err().Error()
					}
				}
			}
			if len(hermes) == 0 {
				select {
				case out <- Chunk{Kind: ChunkToken, Token: reasoningBuf.String()}:
				case <-ctx.Done():
					if errMsg == "" {
						errMsg = ctx.Err().Error()
					}
				}
			}
		}
	done:
		select {
		case out <- Chunk{
			Kind:          ChunkDone,
			TokenCountIn:  in,
			TokenCountOut: outTokens,
			StopReason:    stopReason,
			Error:         errMsg,
		}:
		case <-ctx.Done():
		}
	}()
	return out, nil
}

// hermesToolCallRE matches one <tool_call>…</tool_call> block. The
// inner <function=NAME> tag names the tool; <parameter=KEY>VALUE</parameter>
// pairs describe its args.
var (
	hermesToolCallRE   = regexp.MustCompile(`(?s)<tool_call>\s*(.*?)\s*</tool_call>`)
	hermesFunctionRE   = regexp.MustCompile(`(?s)<function=([^>]+)>\s*(.*?)\s*</function>`)
	hermesParameterRE  = regexp.MustCompile(`(?s)<parameter=([^>]+)>\s*(.*?)\s*</parameter>`)
	hermesToolIDPrefix = "call_hermes_"
)

// parseHermesToolCalls extracts Hermes-style <tool_call> XML blocks
// from a reasoning buffer and returns synthetic ChunkToolUse events.
// Each block gets a generated id since Hermes XML never carries one.
// Silently skips malformed blocks — better to lose a stray fragment
// than to abort the whole round.
func parseHermesToolCalls(raw string) []Chunk {
	var out []Chunk
	for i, block := range hermesToolCallRE.FindAllStringSubmatch(raw, -1) {
		body := block[1]
		fn := hermesFunctionRE.FindStringSubmatch(body)
		if len(fn) != 3 {
			continue
		}
		name := strings.TrimSpace(fn[1])
		inner := fn[2]
		args := map[string]any{}
		for _, p := range hermesParameterRE.FindAllStringSubmatch(inner, -1) {
			key := strings.TrimSpace(p[1])
			val := strings.TrimSpace(p[2])
			// Try to parse the value as JSON so bools/numbers survive
			// round-tripping into the real tool spec; fall back to
			// string on failure (handles raw paths, queries, etc.).
			var parsed any
			if err := json.Unmarshal([]byte(val), &parsed); err == nil {
				args[key] = parsed
			} else {
				args[key] = val
			}
		}
		argsJSON, err := json.Marshal(args)
		if err != nil {
			continue
		}
		out = append(out, Chunk{
			Kind:      ChunkToolUse,
			ToolUseID: fmt.Sprintf("%s%d", hermesToolIDPrefix, i),
			ToolName:  name,
			ToolArgs:  argsJSON,
		})
	}
	return out
}

// collapseSystemMessages merges adjacent Role=system entries into a
// single system message separated by a blank line. Non-system messages
// and gaps reset the run.
func collapseSystemMessages(in []Message) []Message {
	out := make([]Message, 0, len(in))
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			out = append(out, Message{Role: RoleSystem, Content: buf.String()})
			buf.Reset()
		}
	}
	for _, m := range in {
		if m.Role == RoleSystem {
			if buf.Len() > 0 {
				buf.WriteString("\n\n")
			}
			buf.WriteString(m.Content)
			continue
		}
		flush()
		out = append(out, m)
	}
	flush()
	return out
}

// buildOpenAITools converts adapter-neutral specs into the OpenAI
// `tools` payload. The input schema travels as json.RawMessage so the
// HTTP client serialises the exact shape we defined in the catalog.
func buildOpenAITools(specs []ToolSpec) []openai.Tool {
	out := make([]openai.Tool, 0, len(specs))
	for _, s := range specs {
		out = append(out, openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        s.Name,
				Description: s.Description,
				Parameters:  s.InputSchema,
			},
		})
	}
	return out
}

// buildOpenAIMessage adapts an llm.Message (with its attachments) into
// the shape the OpenAI chat-completions endpoint expects. When images
// are present the message uses MultiContent with image_url parts
// carrying a base64 data URL, which is the OpenAI multimodal wire
// format that local runners (LM Studio, Ollama with vision models,
// vLLM) also implement. Plain-text attachments always fold into the
// leading text part so every model — vision-capable or not — sees
// their contents. Messages with no attachments take the simpler
// Content string path for backward compatibility with non-vision
// servers that reject MultiContent.
//
// Tool use is handled outside the attachment path:
//
//   - Role=tool becomes a tool-role ChatCompletionMessage carrying
//     ToolCallID + Content. Attachments on a tool message are ignored
//     because the OpenAI schema has no place for them.
//   - Role=assistant with ToolCalls produces an assistant message
//     with its tool_calls array populated, so replayed history is
//     symmetric with the tool messages that follow it.
func buildOpenAIMessage(m Message) openai.ChatCompletionMessage {
	if m.Role == RoleTool {
		return openai.ChatCompletionMessage{
			Role:       string(RoleTool),
			Content:    m.Content,
			ToolCallID: m.ToolUseID,
		}
	}
	if m.Role == RoleAssistant && len(m.ToolCalls) > 0 {
		calls := make([]openai.ToolCall, 0, len(m.ToolCalls))
		for _, tc := range m.ToolCalls {
			calls = append(calls, openai.ToolCall{
				ID:   tc.ID,
				Type: openai.ToolTypeFunction,
				Function: openai.FunctionCall{
					Name:      tc.Name,
					Arguments: string(tc.Args),
				},
			})
		}
		return openai.ChatCompletionMessage{
			Role:      string(RoleAssistant),
			Content:   m.Content,
			ToolCalls: calls,
		}
	}
	if len(m.Attachments) == 0 {
		return openai.ChatCompletionMessage{Role: string(m.Role), Content: m.Content}
	}
	var images []Attachment
	var textFolds []string
	for _, a := range m.Attachments {
		name := a.Filename
		if name == "" {
			name = "attachment"
		}
		if strings.HasPrefix(a.MimeType, "image/") {
			images = append(images, a)
			continue
		}
		if strings.HasPrefix(a.MimeType, "text/") {
			textFolds = append(textFolds, fmt.Sprintf("--- %s ---\n%s", name, string(a.Data)))
		}
	}
	if len(images) == 0 {
		var sb strings.Builder
		for _, f := range textFolds {
			sb.WriteString(f)
			sb.WriteString("\n\n")
		}
		sb.WriteString(m.Content)
		return openai.ChatCompletionMessage{Role: string(m.Role), Content: sb.String()}
	}
	parts := make([]openai.ChatMessagePart, 0, len(images)+1)
	for _, img := range images {
		dataURL := fmt.Sprintf("data:%s;base64,%s", img.MimeType,
			base64.StdEncoding.EncodeToString(img.Data))
		parts = append(parts, openai.ChatMessagePart{
			Type:     openai.ChatMessagePartTypeImageURL,
			ImageURL: &openai.ChatMessageImageURL{URL: dataURL},
		})
	}
	var textBody strings.Builder
	for _, f := range textFolds {
		textBody.WriteString(f)
		textBody.WriteString("\n\n")
	}
	textBody.WriteString(m.Content)
	parts = append(parts, openai.ChatMessagePart{
		Type: openai.ChatMessagePartTypeText,
		Text: textBody.String(),
	})
	return openai.ChatCompletionMessage{Role: string(m.Role), MultiContent: parts}
}
