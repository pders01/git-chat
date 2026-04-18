package repo

import (
	"context"
	"sync"
	"time"

	catwalk "charm.land/catwalk/pkg/catwalk"
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/storage"
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

// Catalog provides the provider/model catalog for the settings UI.
// The catalog is fetched on-demand (user clicks "refresh") and cached
// in SQLite so it works offline and doesn't phone home silently.
type Catalog struct {
	mu     sync.Mutex
	client *catwalk.Client
	db     *storage.DB
	cached []*gitchatv1.CatalogProvider
}

// NewCatalog creates a catalog backed by SQLite for persistence.
func NewCatalog(db *storage.DB) *Catalog {
	return &Catalog{
		client: catwalk.NewWithURL("https://catwalk.charm.sh"),
		db:     db,
	}
}

// Get returns the cached catalog from memory or SQLite. Never fetches
// from the network — call Refresh for that.
func (c *Catalog) Get(ctx context.Context) []*gitchatv1.CatalogProvider {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cached != nil {
		return c.cached
	}
	// Try loading from SQLite cache.
	if cached, err := c.db.GetCatalogCache(ctx); err == nil && len(cached) > 0 {
		c.cached = cached
		return c.cached
	}
	return nil
}

// Refresh fetches the latest catalog from catwalk.charm.sh and caches
// it in both memory and SQLite. Only called when the user explicitly
// requests it.
func (c *Catalog) Refresh(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	providers, err := c.client.GetProviders(fetchCtx, "")
	if err != nil {
		return nil, err
	}

	out := convertProviders(providers)

	c.mu.Lock()
	c.cached = out
	c.mu.Unlock()

	// Persist to SQLite for offline use.
	_ = c.db.SetCatalogCache(ctx, out)

	return out, nil
}

func convertProviders(providers []catwalk.Provider) []*gitchatv1.CatalogProvider {
	out := make([]*gitchatv1.CatalogProvider, 0, len(providers))
	for _, p := range providers {
		pType := string(p.Type)
		// Map to the two backend types git-chat supports.
		switch p.Type {
		case "openai", "anthropic":
			// keep as-is
		case "openrouter":
			pType = "openai" // openrouter is openai-compatible
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
