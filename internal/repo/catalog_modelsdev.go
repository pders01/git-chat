package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// modelsDevURL is the public models.dev API endpoint. Serves a single
// JSON blob (~1.7 MB at last check) keyed by provider id; each entry
// describes the provider and its models. No auth, generous rate limits.
const modelsDevURL = "https://models.dev/api.json"

// ModelsDevSource pulls the broad provider/model list from models.dev.
// Its role is coverage of the long tail — Fireworks, Together, DeepSeek,
// Cerebras, and ~90 others that neither Catwalk nor OpenRouter ship as
// direct endpoints.
//
// This source is deliberately NOT authoritative for any provider. Its
// data is broad but crowd-maintained; specialist sources (OpenRouter
// for its own bucket, Catwalk for mainstream providers) override it on
// pricing/context conflicts. See mergeSources for the resolution rules.
type ModelsDevSource struct {
	httpClient *http.Client
	endpoint   string
}

func NewModelsDevSource() *ModelsDevSource {
	return &ModelsDevSource{
		httpClient: &http.Client{},
		endpoint:   modelsDevURL,
	}
}

func (s *ModelsDevSource) ID() string { return "models-dev" }

// Authoritative: always false. models.dev is the breadth source —
// trustworthy-enough to seed a dropdown, but yields to specialist
// sources on every field. See package doc for the trust gradient.
func (s *ModelsDevSource) Authoritative(providerID string) bool {
	return false
}

func (s *ModelsDevSource) Fetch(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build models.dev request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "git-chat/0 (+catalog)")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch models.dev: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("models.dev returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload map[string]modelsDevProvider
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode models.dev payload: %w", err)
	}

	// Output in provider-id sort order so refreshes produce stable
	// diffs — the JSON's map key order isn't guaranteed.
	ids := make([]string, 0, len(payload))
	for id := range payload {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]*gitchatv1.CatalogProvider, 0, len(payload))
	for _, id := range ids {
		prov, ok := convertModelsDevProvider(s.ID(), id, payload[id])
		if !ok {
			continue
		}
		out = append(out, prov)
	}
	return out, nil
}

// modelsDevProvider is the subset of each provider entry we consume.
// Upstream also ships `doc`, `release_date`, and a few others we don't
// need — JSON decoding tolerates unknown fields.
type modelsDevProvider struct {
	ID     string                      `json:"id"`
	Name   string                      `json:"name"`
	API    string                      `json:"api"` // base URL; may be null (SDK-only providers)
	Npm    string                      `json:"npm"`
	Env    []string                    `json:"env"`
	Models map[string]modelsDevModel   `json:"models"`
}

type modelsDevModel struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Reasoning   bool                `json:"reasoning"`
	ToolCall    bool                `json:"tool_call"`
	Attachment  bool                `json:"attachment"`
	Modalities  *modelsDevModality  `json:"modalities"`
	Cost        *modelsDevCost      `json:"cost"`
	Limit       *modelsDevLimit     `json:"limit"`
	OpenWeights bool                `json:"open_weights"`
}

type modelsDevModality struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// modelsDevCost values are already denominated per 1M tokens — no
// conversion needed (contrast with OpenRouter's per-token strings).
// CacheRead is captured here so it's documented but NOT yet surfaced
// through the proto; tiered pricing is a future schema extension.
type modelsDevCost struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	CacheRead float64 `json:"cache_read"`
}

type modelsDevLimit struct {
	Context int64 `json:"context"`
	Output  int64 `json:"output"`
}

// convertModelsDevProvider converts one models.dev entry to proto form,
// or returns (nil, false) if the provider should be dropped. Skip
// reasons:
//
//   - Missing `api` — provider is SDK-abstracted (anthropic, google
//     direct, bedrock, azure). Catwalk covers the major ones natively.
//   - Template vars in URL (${CLOUDFLARE_ACCOUNT_ID}) — tenant-specific
//     URL, can't be routed without user input the catalog doesn't have.
func convertModelsDevProvider(sourceID, providerID string, p modelsDevProvider) (*gitchatv1.CatalogProvider, bool) {
	if p.API == "" {
		return nil, false
	}
	if strings.Contains(p.API, "${") {
		return nil, false
	}

	baseURL := strings.TrimRight(p.API, "/")
	if _, err := url.Parse(baseURL); err != nil {
		return nil, false
	}

	// Backend inference: Anthropic-API-compatible providers surface
	// through the @ai-sdk/anthropic adapter. Everything else is
	// OpenAI-compatible (the vast majority — see probe in handoff
	// notes). Two-state inference keeps the backend routing honest.
	backendType := "openai"
	if strings.Contains(p.Npm, "@ai-sdk/anthropic") {
		backendType = "anthropic"
	}

	// Stable model order for clean diffs on refresh.
	modelIDs := make([]string, 0, len(p.Models))
	for id := range p.Models {
		modelIDs = append(modelIDs, id)
	}
	sort.Strings(modelIDs)

	models := make([]*gitchatv1.CatalogModel, 0, len(p.Models))
	for _, mid := range modelIDs {
		models = append(models, convertModelsDevModel(sourceID, p.Models[mid]))
	}

	name := p.Name
	if name == "" {
		name = providerID
	}
	id := p.ID
	if id == "" {
		id = providerID
	}

	return &gitchatv1.CatalogProvider{
		Id:             id,
		Name:           name,
		Type:           backendType,
		DefaultBaseUrl: baseURL,
		Models:         models,
	}, true
}

func convertModelsDevModel(sourceID string, m modelsDevModel) *gitchatv1.CatalogModel {
	var costIn, costOut float64
	if m.Cost != nil {
		costIn = m.Cost.Input
		costOut = m.Cost.Output
	}
	var ctxWin, maxOut int64
	if m.Limit != nil {
		ctxWin = m.Limit.Context
		maxOut = m.Limit.Output
	}

	// Image support: either the explicit Attachment flag or an "image"
	// entry in the input modalities list. Both are in the wild; either
	// alone is sufficient signal to enable the image-capable UI path.
	supportsImages := m.Attachment
	if !supportsImages && m.Modalities != nil {
		for _, mod := range m.Modalities.Input {
			if mod == "image" {
				supportsImages = true
				break
			}
		}
	}

	return &gitchatv1.CatalogModel{
		Id:               m.ID,
		Name:             m.Name,
		ContextWindow:    ctxWin,
		CostPer_1MIn:     costIn,
		CostPer_1MOut:    costOut,
		CanReason:        m.Reasoning,
		SupportsImages:   supportsImages,
		DefaultMaxTokens: maxOut,
		Sources:          []string{sourceID},
	}
}

// newModelsDevSourceWith builds a source with a custom endpoint/client
// for tests. Not part of the stable API.
func newModelsDevSourceWith(endpoint string, client *http.Client) *ModelsDevSource {
	if client == nil {
		client = &http.Client{}
	}
	return &ModelsDevSource{httpClient: client, endpoint: endpoint}
}
