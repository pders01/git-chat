package repo

import (
	"context"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// CatalogSource is one feed of provider/model metadata. The orchestrator
// in catalog.go fans out to every registered source concurrently and
// merges their output via mergeSources (catalog_merge.go).
//
// A source that returns an error is warned-about and skipped — one
// misbehaving source must not take the whole catalog down. Sources that
// return an empty list are silently ignored.
type CatalogSource interface {
	// ID is a short, stable identifier surfaced to users ("catwalk",
	// "openrouter"). Used as the tag in CatalogModel.sources and in
	// PricingQuote.source so the UI can render per-source attribution.
	ID() string

	// Fetch pulls the current catalog from this source. The orchestrator
	// wraps the call with a per-source timeout; implementations can also
	// enforce their own if they have tighter network budgets.
	Fetch(ctx context.Context) ([]*gitchatv1.CatalogProvider, error)

	// Authoritative declares whether this source should win field-level
	// conflicts (pricing, context window) for a given provider_id. Each
	// (provider_id, model_id) gets exactly one authoritative claim for
	// its headline fields; non-authoritative claims are preserved in
	// PricingQuote.quotes for transparency but don't overwrite the
	// headline.
	//
	// When no registered source is authoritative for a provider, the
	// first source to contribute (deterministic source-order) wins by
	// default. See mergeSources.
	Authoritative(providerID string) bool
}
