package repo

import (
	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// mergeSources folds multiple CatalogSource contributions into one
// deduped catalog. `sources` and `contributions` must be parallel and
// in the same order the orchestrator registered them — that order
// breaks ties when no source is authoritative for a provider.
//
// Merge rules:
//
//   - Dedup key is (provider_id, model_id). Same model reported by
//     multiple sources collapses into one entry with sources[] listing
//     each contributor.
//
//   - Headline fields on CatalogModel (context window, pricing, flags)
//     come from the authoritative source for the provider. The first
//     source where Authoritative(provider_id) == true wins. If no
//     source is authoritative, the first contributor wins — the
//     orchestrator controls that order (Catwalk first today, so it
//     speaks when nothing else does).
//
//   - PricingQuote.quotes is populated only when contributing sources
//     *disagree* on pricing. Single-source entries and full-agreement
//     multi-source entries leave quotes empty to avoid wire-weight
//     noise. The UI can render headline pricing without checking.
//
//   - Provider-level fields (name, type, default_base_url,
//     default_model_id) come from the first contributor for the
//     provider_id. Provider output order follows first-appearance in
//     the contribution stream — deterministic across refreshes given
//     the same source registration.
func mergeSources(
	sources []CatalogSource,
	contributions [][]*gitchatv1.CatalogProvider,
) []*gitchatv1.CatalogProvider {
	if len(sources) != len(contributions) {
		// Caller bug; an empty catalog is safer than a nil panic.
		return nil
	}

	// Provider accumulator keyed by provider_id. Preserves shell-level
	// metadata (name, type, base URL, default model) from the first
	// contributor.
	type providerAccum struct {
		id             string
		name           string
		pType          string
		defaultBaseURL string
		defaultModelID string
		// Model claims keyed by model_id. claims[i] comes from sources[i]
		// so we can look up authoritative claims and source IDs.
		claims map[string][]modelClaim
		// Model insertion order for deterministic output.
		modelOrder []string
	}
	providers := make(map[string]*providerAccum)
	providerOrder := make([]string, 0)

	for i, contribution := range contributions {
		src := sources[i]
		for _, p := range contribution {
			if p == nil {
				continue
			}
			acc, ok := providers[p.Id]
			if !ok {
				acc = &providerAccum{
					id:             p.Id,
					name:           p.Name,
					pType:          p.Type,
					defaultBaseURL: p.DefaultBaseUrl,
					defaultModelID: p.DefaultModelId,
					claims:         make(map[string][]modelClaim),
				}
				providers[p.Id] = acc
				providerOrder = append(providerOrder, p.Id)
			}
			for _, m := range p.Models {
				if m == nil {
					continue
				}
				if _, seen := acc.claims[m.Id]; !seen {
					acc.modelOrder = append(acc.modelOrder, m.Id)
				}
				acc.claims[m.Id] = append(acc.claims[m.Id], modelClaim{
					sourceIdx: i,
					sourceID:  src.ID(),
					model:     m,
				})
			}
		}
	}

	out := make([]*gitchatv1.CatalogProvider, 0, len(providerOrder))
	for _, pid := range providerOrder {
		acc := providers[pid]
		models := make([]*gitchatv1.CatalogModel, 0, len(acc.modelOrder))
		for _, mid := range acc.modelOrder {
			models = append(models, resolveModel(sources, pid, acc.claims[mid]))
		}
		out = append(out, &gitchatv1.CatalogProvider{
			Id:             acc.id,
			Name:           acc.name,
			Type:           acc.pType,
			DefaultBaseUrl: acc.defaultBaseURL,
			DefaultModelId: acc.defaultModelID,
			Models:         models,
		})
	}
	return out
}

// modelClaim is one source's contribution for a given (provider, model).
// sourceIdx is the orchestrator registration order; sourceID is the
// user-facing tag ("catwalk", "openrouter"); model is the raw claim
// before merging.
type modelClaim struct {
	sourceIdx int
	sourceID  string
	model     *gitchatv1.CatalogModel
}

// resolveModel picks the authoritative claim and builds the final
// merged CatalogModel. Headline fields come from the authoritative
// claim; `sources` enumerates every contributor; `quotes` captures
// per-source pricing only when sources disagree.
func resolveModel(
	sources []CatalogSource,
	providerID string,
	claims []modelClaim,
) *gitchatv1.CatalogModel {
	// Pick authoritative: first-registered source with Authoritative()
	// true for this provider. Fall back to first contributor.
	auth := claims[0]
	for _, c := range claims {
		if sources[c.sourceIdx].Authoritative(providerID) {
			auth = c
			break
		}
	}

	sourceIDs := make([]string, 0, len(claims))
	for _, c := range claims {
		sourceIDs = append(sourceIDs, c.sourceID)
	}

	// Only surface quotes when sources disagree on at least one price.
	// Agreement (including single-source) leaves quotes empty — callers
	// just read the headline.
	var quotes []*gitchatv1.PricingQuote
	if pricingDisagrees(claims) {
		quotes = make([]*gitchatv1.PricingQuote, 0, len(claims))
		for _, c := range claims {
			quotes = append(quotes, &gitchatv1.PricingQuote{
				Source:        c.sourceID,
				CostPer_1MIn:  c.model.CostPer_1MIn,
				CostPer_1MOut: c.model.CostPer_1MOut,
			})
		}
	}

	return &gitchatv1.CatalogModel{
		Id:               auth.model.Id,
		Name:             auth.model.Name,
		ContextWindow:    auth.model.ContextWindow,
		CostPer_1MIn:     auth.model.CostPer_1MIn,
		CostPer_1MOut:    auth.model.CostPer_1MOut,
		CanReason:        auth.model.CanReason,
		SupportsImages:   auth.model.SupportsImages,
		DefaultMaxTokens: auth.model.DefaultMaxTokens,
		Sources:          sourceIDs,
		Quotes:           quotes,
	}
}

func pricingDisagrees(claims []modelClaim) bool {
	if len(claims) < 2 {
		return false
	}
	in := claims[0].model.CostPer_1MIn
	out := claims[0].model.CostPer_1MOut
	for _, c := range claims[1:] {
		if c.model.CostPer_1MIn != in || c.model.CostPer_1MOut != out {
			return true
		}
	}
	return false
}
