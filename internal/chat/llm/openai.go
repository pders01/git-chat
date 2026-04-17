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
func (o *OpenAI) Stream(ctx context.Context, req Request) (<-chan Chunk, error) {
	msgs := make([]openai.ChatCompletionMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		msgs = append(msgs, buildOpenAIMessage(m))
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
func buildOpenAIMessage(m Message) openai.ChatCompletionMessage {
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
