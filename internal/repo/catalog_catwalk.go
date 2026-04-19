package repo

import (
	"context"
	"time"

	catwalk "charm.land/catwalk/pkg/catwalk"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// Known base URLs per provider type. Catwalk's Provider uses env var
// references for endpoints; we map to the public defaults so the UI
// can pre-fill base URL when a provider is selected.
var providerBaseURLs = map[catwalk.Type]string{
	"openai":    "https://api.openai.com/v1",
	"anthropic": "https://api.anthropic.com",
	"gemini":    "https://generativelanguage.googleapis.com/v1beta",
	"groq":      "https://api.groq.com/openai/v1",
}

// CatwalkSource wraps the Charm.sh Catwalk client. It's the default
// catalog source — broad provider coverage, curated metadata, but
// pricing can lag. More specialized sources (like OpenRouter for its
// own bucket) declare themselves authoritative for specific providers
// and override Catwalk's claims for those.
type CatwalkSource struct {
	client *catwalk.Client
}

// NewCatwalkSource builds a source pointing at catwalk.charm.sh. The
// URL is fixed rather than configurable — Catwalk isn't self-hostable
// in any meaningful sense, and swapping the URL usually means you
// wanted a different source entirely (implement CatalogSource directly).
func NewCatwalkSource() *CatwalkSource {
	return &CatwalkSource{client: catwalk.NewWithURL("https://catwalk.charm.sh")}
}

func (s *CatwalkSource) ID() string { return "catwalk" }

// Authoritative: Catwalk is a broad aggregator, not specifically
// authoritative for any one provider. It returns false everywhere so
// specialized sources (OpenRouter for its own bucket, a hypothetical
// OpenAI-direct source, etc.) win when they claim a provider. When no
// source claims, mergeSources falls back to "first contributor wins,"
// which naturally picks Catwalk if it's registered first.
func (s *CatwalkSource) Authoritative(providerID string) bool {
	return false
}

func (s *CatwalkSource) Fetch(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	providers, err := s.client.GetProviders(fetchCtx, "")
	if err != nil {
		return nil, err
	}
	return convertCatwalkProviders(s.ID(), providers), nil
}

func convertCatwalkProviders(sourceID string, providers []catwalk.Provider) []*gitchatv1.CatalogProvider {
	out := make([]*gitchatv1.CatalogProvider, 0, len(providers))
	for _, p := range providers {
		pType := string(p.Type)
		switch p.Type {
		case "openai", "anthropic":
			// keep as-is
		case "openrouter":
			pType = "openai" // openrouter is openai-compatible
		case "gemini", "vertexai", "bedrock", "azure":
			continue // skip — requires dedicated backend support
		default:
			pType = "openai" // assume openai-compatible
		}

		baseURL, ok := providerBaseURLs[p.Type]
		if !ok {
			baseURL = ""
		}

		models := make([]*gitchatv1.CatalogModel, 0, len(p.Models))
		for _, m := range p.Models {
			models = append(models, &gitchatv1.CatalogModel{
				Id:               m.ID,
				Name:             m.Name,
				ContextWindow:    m.ContextWindow,
				CostPer_1MIn:     m.CostPer1MIn,
				CostPer_1MOut:    m.CostPer1MOut,
				CanReason:        m.CanReason,
				SupportsImages:   m.SupportsImages,
				DefaultMaxTokens: m.DefaultMaxTokens,
				Sources:          []string{sourceID},
			})
		}

		out = append(out, &gitchatv1.CatalogProvider{
			Id:             string(p.ID),
			Name:           p.Name,
			Type:           pType,
			DefaultBaseUrl: baseURL,
			DefaultModelId: p.DefaultLargeModelID,
			Models:         models,
		})
	}
	return out
}
