package repo

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
	"github.com/pders01/git-chat/internal/storage"
)

// catalogStaleTTL is how long a cached catalog is considered fresh.
// Beyond this, Get still serves the cache (so the UI keeps working
// offline) but logs a warning so operators notice a refresh is overdue.
const catalogStaleTTL = 24 * time.Hour

// perSourceFetchTimeout bounds each individual source's Fetch call so a
// slow or stuck source can't delay the whole refresh. The orchestrator
// additionally runs sources concurrently, so total refresh time is
// roughly max(per-source latency) rather than the sum.
const perSourceFetchTimeout = 15 * time.Second

// Catalog provides the provider/model catalog for the settings UI. The
// catalog is fetched on-demand (user clicks "refresh") and cached in
// SQLite so it works offline and doesn't phone home silently.
//
// Catalog fans out across multiple CatalogSource implementations; each
// source contributes its own view of the provider/model landscape and
// the results are merged via mergeSources (catalog_merge.go). Partial
// source failures are warned and skipped — one broken source doesn't
// break the whole catalog.
type Catalog struct {
	mu       sync.Mutex
	sources  []CatalogSource
	db       *storage.DB
	cached   []*gitchatv1.CatalogProvider
	cachedAt time.Time
}

// NewCatalog builds the default multi-source catalog. The source order
// matters for "first-contributor wins" tiebreaking in mergeSources —
// Catwalk is registered first since it's the broadest default. More
// specialized sources (OpenRouter etc.) go after; they override Catwalk
// via Authoritative(providerID) for the providers they own.
func NewCatalog(db *storage.DB) *Catalog {
	return &Catalog{
		db: db,
		sources: []CatalogSource{
			NewCatwalkSource(),
			NewOpenRouterSource(),
			NewModelsDevSource(),
		},
	}
}

// Get returns the cached catalog from memory or SQLite. Never fetches
// from the network — call Refresh for that. When the cached data is
// older than catalogStaleTTL, a warning is logged but the data is
// still returned so the UI remains usable offline.
func (c *Catalog) Get(ctx context.Context) []*gitchatv1.CatalogProvider {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cached == nil {
		cached, err := c.db.GetCatalogCache(ctx)
		if err != nil || len(cached) == 0 {
			return nil
		}
		ts, _ := c.db.GetCatalogCacheTime(ctx)
		c.cached = cached
		c.cachedAt = ts
	}
	if !c.cachedAt.IsZero() {
		age := time.Since(c.cachedAt)
		if age > catalogStaleTTL {
			slog.Warn("serving stale catalog; user should refresh", "age", age.Round(time.Hour))
		}
	} else {
		// Legacy cache written before timestamp tracking — treat as stale.
		slog.Warn("serving catalog without a timestamp; user should refresh")
	}
	return c.cached
}

// Refresh fans out across every registered source concurrently, merges
// the results with deterministic tiebreaking, and caches in memory and
// SQLite. A source that errors or times out is warned about and skipped
// — a partial catalog is strictly better than no catalog.
//
// Returns an error only when *every* source failed; otherwise the
// merged result (possibly from fewer sources than registered) comes
// back and is treated as authoritative.
func (c *Catalog) Refresh(ctx context.Context) ([]*gitchatv1.CatalogProvider, error) {
	type sourceResult struct {
		source    CatalogSource
		providers []*gitchatv1.CatalogProvider
		err       error
	}

	results := make([]sourceResult, len(c.sources))
	var wg sync.WaitGroup
	for i, src := range c.sources {
		wg.Add(1)
		go func(i int, src CatalogSource) {
			defer wg.Done()
			srcCtx, cancel := context.WithTimeout(ctx, perSourceFetchTimeout)
			defer cancel()
			providers, err := src.Fetch(srcCtx)
			results[i] = sourceResult{source: src, providers: providers, err: err}
		}(i, src)
	}
	wg.Wait()

	sources := make([]CatalogSource, 0, len(c.sources))
	contributions := make([][]*gitchatv1.CatalogProvider, 0, len(c.sources))
	failed := 0
	for _, r := range results {
		if r.err != nil {
			slog.Warn("catalog source failed; skipping", "source", r.source.ID(), "err", r.err)
			failed++
			continue
		}
		sources = append(sources, r.source)
		contributions = append(contributions, r.providers)
	}

	if len(sources) == 0 {
		return nil, fmt.Errorf("all %d catalog sources failed", failed)
	}

	merged := mergeSources(sources, contributions)

	c.mu.Lock()
	c.cached = merged
	c.cachedAt = time.Now()
	c.mu.Unlock()

	if err := c.db.SetCatalogCache(ctx, merged); err != nil {
		slog.Warn("failed to cache catalog to SQLite", "err", err)
	}

	return merged, nil
}
