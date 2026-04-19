package repo

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// openRouterFixture is a trimmed version of a real /api/v1/models
// response — enough to exercise parsing without pinning the test to
// every field OpenRouter might add later.
const openRouterFixture = `{
  "data": [
    {
      "id": "openai/gpt-4o",
      "name": "OpenAI: GPT-4o",
      "context_length": 128000,
      "architecture": { "modality": "text+image->text" },
      "pricing": { "prompt": "0.0000025", "completion": "0.00001" },
      "top_provider": { "context_length": 128000, "max_completion_tokens": 16384 }
    },
    {
      "id": "anthropic/claude-3.5-sonnet",
      "name": "Anthropic: Claude 3.5 Sonnet",
      "context_length": 200000,
      "architecture": { "modality": "text->text" },
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "top_provider": { "context_length": 200000, "max_completion_tokens": 8192 }
    },
    {
      "id": "meta-llama/llama-3.3-70b-instruct:free",
      "name": "Meta: Llama 3.3 70B Instruct (free)",
      "context_length": 131072,
      "architecture": { "modality": "text->text" },
      "pricing": { "prompt": "0", "completion": "0" },
      "top_provider": { "context_length": 131072 }
    }
  ]
}`

func newOpenRouterTestServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("expected Accept: application/json, got %q", got)
		}
		if got := r.Header.Get("User-Agent"); !strings.Contains(got, "git-chat") {
			t.Errorf("expected User-Agent to include git-chat, got %q", got)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
}

func TestOpenRouterSource_FetchParsesModels(t *testing.T) {
	srv := newOpenRouterTestServer(t, http.StatusOK, openRouterFixture)
	defer srv.Close()

	src := newOpenRouterSourceWith(srv.URL, srv.Client())
	providers, err := src.Fetch(context.Background())
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	if len(providers) != 1 {
		t.Fatalf("want 1 provider bucket, got %d", len(providers))
	}
	p := providers[0]
	if p.Id != "openrouter" || p.Type != "openai" {
		t.Errorf("provider shell wrong: id=%q type=%q", p.Id, p.Type)
	}
	if p.DefaultBaseUrl != openRouterBaseURL {
		t.Errorf("base URL wrong: %q", p.DefaultBaseUrl)
	}
	if len(p.Models) != 3 {
		t.Fatalf("want 3 models, got %d", len(p.Models))
	}

	gpt := p.Models[0]
	if gpt.Id != "openai/gpt-4o" || gpt.Name != "OpenAI: GPT-4o" {
		t.Errorf("gpt-4o id/name wrong: %+v", gpt)
	}
	if gpt.ContextWindow != 128000 {
		t.Errorf("context window: want 128000, got %d", gpt.ContextWindow)
	}
	// 0.0000025 USD/token × 1M = 2.50 USD per 1M tokens.
	if gpt.CostPer_1MIn != 2.50 || gpt.CostPer_1MOut != 10.00 {
		t.Errorf("pricing conversion wrong: in=%v out=%v", gpt.CostPer_1MIn, gpt.CostPer_1MOut)
	}
	if !gpt.SupportsImages {
		t.Errorf("gpt-4o should be flagged SupportsImages (modality includes 'image')")
	}
	if gpt.DefaultMaxTokens != 16384 {
		t.Errorf("default max tokens: want 16384, got %d", gpt.DefaultMaxTokens)
	}
	if len(gpt.Sources) != 1 || gpt.Sources[0] != "openrouter" {
		t.Errorf("sources tag: want [openrouter], got %v", gpt.Sources)
	}

	claude := p.Models[1]
	if claude.SupportsImages {
		t.Errorf("claude-3.5-sonnet modality is text->text, should not be flagged as image-capable")
	}

	free := p.Models[2]
	if free.CostPer_1MIn != 0 || free.CostPer_1MOut != 0 {
		t.Errorf("free model pricing should be 0/0: in=%v out=%v", free.CostPer_1MIn, free.CostPer_1MOut)
	}
}

func TestOpenRouterSource_FetchNon200ReturnsError(t *testing.T) {
	srv := newOpenRouterTestServer(t, http.StatusBadGateway, "upstream down")
	defer srv.Close()

	src := newOpenRouterSourceWith(srv.URL, srv.Client())
	_, err := src.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on non-200, got nil")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("expected status code in error, got %q", err.Error())
	}
}

func TestOpenRouterSource_FetchBadJSONReturnsError(t *testing.T) {
	srv := newOpenRouterTestServer(t, http.StatusOK, "not json at all")
	defer srv.Close()

	src := newOpenRouterSourceWith(srv.URL, srv.Client())
	_, err := src.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on malformed JSON, got nil")
	}
	if !strings.Contains(err.Error(), "decode") {
		t.Errorf("expected decode error, got %q", err.Error())
	}
}

func TestOpenRouterSource_FetchHonorsContext(t *testing.T) {
	// A cancelled context should surface as a request error without
	// hanging — important for the orchestrator's partial-failure path.
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	src := newOpenRouterSourceWith(srv.URL, srv.Client())
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	_, err := src.Fetch(ctx)
	if err == nil {
		t.Fatal("expected context cancellation error, got nil")
	}
}

func TestOpenRouterSource_Authoritative(t *testing.T) {
	src := NewOpenRouterSource()
	if !src.Authoritative("openrouter") {
		t.Error("should be authoritative for openrouter bucket")
	}
	for _, pid := range []string{"openai", "anthropic", "gemini", "", "unknown"} {
		if src.Authoritative(pid) {
			t.Errorf("should NOT be authoritative for %q", pid)
		}
	}
}

// End-to-end: real OpenRouterSource + a prescripted Catwalk-like
// contribution go through mergeSources. Validates that an openrouter
// bucket served by both sources resolves with OpenRouter authoritative.
func TestCatalog_OpenRouterMergesWithCatwalkFake(t *testing.T) {
	srv := newOpenRouterTestServer(t, http.StatusOK, openRouterFixture)
	defer srv.Close()

	// Stand-in for Catwalk: reports gpt-4o in the openrouter bucket at
	// stale pricing. newFakeSource's Fetch returns nil, so we pass its
	// contribution directly as the second arg to mergeSources.
	catwalkFake := newFakeSource("catwalk")
	catwalkContribution := []*gitchatv1.CatalogProvider{
		prov("openrouter", "openai",
			model("openai/gpt-4o", 128000, 2.40, 9.50)), // stale pricing
	}

	orSrc := newOpenRouterSourceWith(srv.URL, srv.Client())
	orContribution, err := orSrc.Fetch(context.Background())
	if err != nil {
		t.Fatalf("openrouter fetch: %v", err)
	}

	merged := mergeSources(
		[]CatalogSource{catwalkFake, orSrc},
		[][]*gitchatv1.CatalogProvider{catwalkContribution, orContribution},
	)

	var gpt *gitchatv1.CatalogModel
	for _, p := range merged {
		if p.Id != "openrouter" {
			continue
		}
		for _, m := range p.Models {
			if m.Id == "openai/gpt-4o" {
				gpt = m
				break
			}
		}
	}
	if gpt == nil {
		t.Fatal("gpt-4o not found in merged openrouter bucket")
	}
	if gpt.CostPer_1MIn != 2.50 {
		t.Errorf("openrouter pricing should win the headline: got %v, want 2.50", gpt.CostPer_1MIn)
	}
	if len(gpt.Sources) != 2 {
		t.Errorf("expected both sources on the entry, got %v", gpt.Sources)
	}
	if len(gpt.Quotes) != 2 {
		t.Errorf("expected 2 quotes (pricing disagreed), got %d", len(gpt.Quotes))
	}
}
