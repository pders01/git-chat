package repo

import (
	"context"
	"testing"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// fakeSource is a test double — we drive merge behavior off the
// sources slice, so Fetch is irrelevant here. The interesting knob is
// Authoritative(providerID).
type fakeSource struct {
	id       string
	authFor  map[string]bool // providers this source claims
	authAll  bool            // overrides authFor, used for "authoritative for everything"
}

func (f *fakeSource) ID() string { return f.id }
func (f *fakeSource) Fetch(_ context.Context) ([]*gitchatv1.CatalogProvider, error) {
	return nil, nil
}
func (f *fakeSource) Authoritative(providerID string) bool {
	if f.authAll {
		return true
	}
	return f.authFor[providerID]
}

func newFakeSource(id string, authFor ...string) *fakeSource {
	m := make(map[string]bool, len(authFor))
	for _, p := range authFor {
		m[p] = true
	}
	return &fakeSource{id: id, authFor: m}
}

func prov(id, pType string, models ...*gitchatv1.CatalogModel) *gitchatv1.CatalogProvider {
	return &gitchatv1.CatalogProvider{
		Id:     id,
		Name:   id,
		Type:   pType,
		Models: models,
	}
}

func model(id string, ctx int64, costIn, costOut float64) *gitchatv1.CatalogModel {
	return &gitchatv1.CatalogModel{
		Id:            id,
		Name:          id,
		ContextWindow: ctx,
		CostPer_1MIn:  costIn,
		CostPer_1MOut: costOut,
	}
}

func TestMergeSources_SingleSource(t *testing.T) {
	src := newFakeSource("catwalk")
	contribution := []*gitchatv1.CatalogProvider{
		prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00)),
	}

	out := mergeSources([]CatalogSource{src}, [][]*gitchatv1.CatalogProvider{contribution})
	if len(out) != 1 {
		t.Fatalf("want 1 provider, got %d", len(out))
	}
	if got := out[0].Models[0].Sources; len(got) != 1 || got[0] != "catwalk" {
		t.Errorf("want sources=[catwalk], got %v", got)
	}
	if len(out[0].Models[0].Quotes) != 0 {
		t.Errorf("single source should have no quotes, got %d", len(out[0].Models[0].Quotes))
	}
}

func TestMergeSources_TwoSourcesSameModelAgreeOnPrice(t *testing.T) {
	// Both sources report gpt-4o with identical pricing — quotes stay
	// empty to avoid wire noise.
	catwalk := newFakeSource("catwalk")
	openrouter := newFakeSource("openrouter", "openrouter")

	out := mergeSources(
		[]CatalogSource{catwalk, openrouter},
		[][]*gitchatv1.CatalogProvider{
			{prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00))},
			{prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00))},
		},
	)

	m := out[0].Models[0]
	if len(m.Sources) != 2 || m.Sources[0] != "catwalk" || m.Sources[1] != "openrouter" {
		t.Errorf("want sources=[catwalk openrouter], got %v", m.Sources)
	}
	if len(m.Quotes) != 0 {
		t.Errorf("agreeing prices should leave quotes empty, got %d", len(m.Quotes))
	}
}

func TestMergeSources_PricingDisagreementPopulatesQuotes(t *testing.T) {
	catwalk := newFakeSource("catwalk")
	openrouter := newFakeSource("openrouter", "openrouter")

	out := mergeSources(
		[]CatalogSource{catwalk, openrouter},
		[][]*gitchatv1.CatalogProvider{
			{prov("openrouter", "openai", model("openai/gpt-4o", 128000, 2.50, 10.00))},
			{prov("openrouter", "openai", model("openai/gpt-4o", 128000, 2.63, 10.50))},
		},
	)

	m := out[0].Models[0]
	// OpenRouter authoritative for openrouter bucket, so headline = 2.63/10.50.
	if m.CostPer_1MIn != 2.63 || m.CostPer_1MOut != 10.50 {
		t.Errorf("authoritative headline wrong: in=%v out=%v", m.CostPer_1MIn, m.CostPer_1MOut)
	}
	if len(m.Quotes) != 2 {
		t.Fatalf("disagreement should yield 2 quotes, got %d", len(m.Quotes))
	}
	// Quote order follows source registration (catwalk first, openrouter second).
	if m.Quotes[0].Source != "catwalk" || m.Quotes[0].CostPer_1MIn != 2.50 {
		t.Errorf("catwalk quote wrong: %+v", m.Quotes[0])
	}
	if m.Quotes[1].Source != "openrouter" || m.Quotes[1].CostPer_1MIn != 2.63 {
		t.Errorf("openrouter quote wrong: %+v", m.Quotes[1])
	}
}

func TestMergeSources_NoAuthoritativeFallsBackToFirstContributor(t *testing.T) {
	// Neither source claims authority over "openai". Catwalk is first,
	// so its claim becomes headline despite the disagreement.
	catwalk := newFakeSource("catwalk")
	other := newFakeSource("other") // no authoritative claims

	out := mergeSources(
		[]CatalogSource{catwalk, other},
		[][]*gitchatv1.CatalogProvider{
			{prov("openai", "openai", model("gpt-4o", 128000, 5.00, 15.00))},
			{prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00))},
		},
	)
	m := out[0].Models[0]
	if m.CostPer_1MIn != 5.00 {
		t.Errorf("first-contributor fallback: want 5.00, got %v", m.CostPer_1MIn)
	}
}

func TestMergeSources_AuthoritativeWinsOverFirstContributor(t *testing.T) {
	// Catwalk first by registration, but a specialist source authoritative
	// for "openai" overrides it.
	catwalk := newFakeSource("catwalk")
	specialist := newFakeSource("openai-direct", "openai")

	out := mergeSources(
		[]CatalogSource{catwalk, specialist},
		[][]*gitchatv1.CatalogProvider{
			{prov("openai", "openai", model("gpt-4o", 128000, 5.00, 15.00))},
			{prov("openai", "openai", model("gpt-4o", 200000, 2.50, 10.00))},
		},
	)
	m := out[0].Models[0]
	if m.ContextWindow != 200000 || m.CostPer_1MIn != 2.50 {
		t.Errorf("authoritative should win: got ctx=%d in=%v", m.ContextWindow, m.CostPer_1MIn)
	}
	// Both quotes recorded since pricing disagreed.
	if len(m.Quotes) != 2 {
		t.Errorf("want 2 quotes for disagreement, got %d", len(m.Quotes))
	}
}

func TestMergeSources_DifferentProvidersStayDistinct(t *testing.T) {
	// (openai, gpt-4o) and (openrouter, openai/gpt-4o) are different keys.
	catwalk := newFakeSource("catwalk")
	out := mergeSources(
		[]CatalogSource{catwalk},
		[][]*gitchatv1.CatalogProvider{{
			prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00)),
			prov("openrouter", "openai", model("openai/gpt-4o", 128000, 2.63, 10.50)),
		}},
	)
	if len(out) != 2 {
		t.Fatalf("want 2 distinct providers, got %d", len(out))
	}
	if out[0].Id != "openai" || out[1].Id != "openrouter" {
		t.Errorf("provider order: got %s, %s", out[0].Id, out[1].Id)
	}
}

func TestMergeSources_ProviderOrderIsFirstAppearance(t *testing.T) {
	// Source A contributes [openai], source B contributes [anthropic, openai].
	// Output order should be [openai, anthropic] — openai appeared first.
	a := newFakeSource("a")
	b := newFakeSource("b")
	out := mergeSources(
		[]CatalogSource{a, b},
		[][]*gitchatv1.CatalogProvider{
			{prov("openai", "openai")},
			{prov("anthropic", "anthropic"), prov("openai", "openai")},
		},
	)
	if len(out) != 2 || out[0].Id != "openai" || out[1].Id != "anthropic" {
		t.Errorf("want [openai, anthropic], got [%s, %s]", out[0].Id, out[1].Id)
	}
}

func TestMergeSources_EmptyContributionsIsSafe(t *testing.T) {
	// A source can return nil/empty without breaking the merge.
	a := newFakeSource("a")
	b := newFakeSource("b")
	out := mergeSources(
		[]CatalogSource{a, b},
		[][]*gitchatv1.CatalogProvider{
			nil,
			{prov("openai", "openai", model("gpt-4o", 128000, 2.50, 10.00))},
		},
	)
	if len(out) != 1 || out[0].Models[0].Sources[0] != "b" {
		t.Errorf("unexpected merge output: %+v", out)
	}
}

func TestMergeSources_MalformedLengthsReturnNil(t *testing.T) {
	// Caller bug: sources and contributions must be parallel.
	a := newFakeSource("a")
	out := mergeSources([]CatalogSource{a}, [][]*gitchatv1.CatalogProvider{nil, nil})
	if out != nil {
		t.Errorf("mismatched lengths should return nil, got %+v", out)
	}
}
