package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// openRouterModelsURL is the public endpoint that lists every model
// available via OpenRouter's aggregator. No auth required; rate limits
// are generous for anonymous reads.
const openRouterModelsURL = "https://openrouter.ai/api/v1/models"

// openRouterProviderID is the provider bucket OpenRouter claims. It
// matches the key Catwalk already uses for OpenRouter models, so their
// contributions merge on the same dedup key in mergeSources.
const openRouterProviderID = "openrouter"

// openRouterBaseURL is the endpoint users should point LLM_BASE_URL at
// to actually call OpenRouter. Mirrors Catwalk's default surface.
const openRouterBaseURL = "https://openrouter.ai/api/v1"

// OpenRouterSource fetches the full OpenRouter catalog directly from
// their API. Its purpose is to *enrich* Catwalk's coverage: fresher
// model list, first-party pricing. Authoritative for the "openrouter"
// provider bucket — for every other provider (OpenAI direct, Anthropic
// direct), this source returns nothing.
type OpenRouterSource struct {
	httpClient *http.Client
	endpoint   string
}

// NewOpenRouterSource builds a source pointing at the public models
// endpoint. The HTTP client has no timeout — per-source timeout is
// enforced by the catalog orchestrator so all sources share one policy.
func NewOpenRouterSource() *OpenRouterSource {
	return &OpenRouterSource{
		httpClient: &http.Client{},
		endpoint:   openRouterModelsURL,
	}
}

func (s *OpenRouterSource) ID() string { return "openrouter" }

// Authoritative: OpenRouter knows its own pricing and model list
// better than any aggregator, so we win on conflicts for the
// "openrouter" bucket. For everything else this source isn't even
// contributing, so the return value is moot.
func (s *OpenRouterSource) Authoritative(providerID string) bool {
	return providerID == openRouterProviderID
}

func (s *OpenRouterSource) Fetch(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build openrouter request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "git-chat/0 (+catalog)")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch openrouter models: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("openrouter returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload openRouterModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode openrouter payload: %w", err)
	}

	models := make([]*gitchatv1.CatalogModel, 0, len(payload.Data))
	for _, m := range payload.Data {
		models = append(models, convertOpenRouterModel(s.ID(), m))
	}

	return []*gitchatv1.CatalogProvider{{
		Id:             openRouterProviderID,
		Name:           "OpenRouter",
		Type:           "openai", // openai-compatible API
		DefaultBaseUrl: openRouterBaseURL,
		Models:         models,
	}}, nil
}

// openRouterModelsResponse is the subset of OpenRouter's /models payload
// we parse. The full response has more fields (architecture details,
// per_request_limits, moderation flags) that the catalog doesn't need.
type openRouterModelsResponse struct {
	Data []openRouterModel `json:"data"`
}

type openRouterModel struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	ContextLength int64              `json:"context_length"`
	Architecture  *openRouterArch    `json:"architecture"`
	Pricing       *openRouterPricing `json:"pricing"`
	TopProvider   *openRouterTop     `json:"top_provider"`
}

type openRouterArch struct {
	// Modality is "text->text", "text+image->text", etc. We detect image
	// support by substring match — the canonical format has changed
	// before, so "includes image" is sturdier than "equals X".
	Modality string `json:"modality"`
}

type openRouterPricing struct {
	// USD per token, encoded as strings to avoid JSON float rounding
	// on very small values like "0.0000025".
	Prompt     string `json:"prompt"`
	Completion string `json:"completion"`
}

type openRouterTop struct {
	ContextLength       int64 `json:"context_length"`
	MaxCompletionTokens int64 `json:"max_completion_tokens"`
}

func convertOpenRouterModel(sourceID string, m openRouterModel) *gitchatv1.CatalogModel {
	ctx := m.ContextLength
	var maxTokens int64
	if m.TopProvider != nil {
		if m.TopProvider.ContextLength > 0 {
			ctx = m.TopProvider.ContextLength
		}
		maxTokens = m.TopProvider.MaxCompletionTokens
	}

	supportsImages := false
	if m.Architecture != nil {
		supportsImages = strings.Contains(m.Architecture.Modality, "image")
	}

	return &gitchatv1.CatalogModel{
		Id:               m.ID,
		Name:             m.Name,
		ContextWindow:    ctx,
		CostPer_1MIn:     perMillionFromPerToken(m.Pricing.promptOrEmpty()),
		CostPer_1MOut:    perMillionFromPerToken(m.Pricing.completionOrEmpty()),
		SupportsImages:   supportsImages,
		DefaultMaxTokens: maxTokens,
		Sources:          []string{sourceID},
	}
}

// perMillionFromPerToken converts OpenRouter's per-token USD string
// into a per-1M-token float. Silent zero on parse failure — a broken
// pricing field shouldn't drop the model from the catalog entirely.
func perMillionFromPerToken(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v * 1_000_000
}

func (p *openRouterPricing) promptOrEmpty() string {
	if p == nil {
		return ""
	}
	return p.Prompt
}

func (p *openRouterPricing) completionOrEmpty() string {
	if p == nil {
		return ""
	}
	return p.Completion
}

// httpClientForOpenRouter is an internal helper retained for callers
// that want to build an OpenRouterSource with a custom HTTP client
// (e.g. tests using httptest.Server). Not part of the stable API.
func newOpenRouterSourceWith(endpoint string, client *http.Client) *OpenRouterSource {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &OpenRouterSource{httpClient: client, endpoint: endpoint}
}
