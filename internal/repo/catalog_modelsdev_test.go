package repo

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// modelsDevFixture covers the cases that shape parsing logic:
//   - fireworks-ai: classic openai-compatible entry with pricing + limits
//   - minimax: api set but npm is @ai-sdk/anthropic → should infer "anthropic"
//   - anthropic: api==null → should be filtered out (Catwalk covers it)
//   - cloudflare-workers-ai: api contains ${...} → should be filtered out
//   - partial-model: missing cost/limit/modalities → should parse as zeros
const modelsDevFixture = `{
  "fireworks-ai": {
    "id": "fireworks-ai",
    "name": "Fireworks AI",
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.fireworks.ai/inference/v1/",
    "env": ["FIREWORKS_API_KEY"],
    "models": {
      "accounts/fireworks/models/glm-5p1": {
        "id": "accounts/fireworks/models/glm-5p1",
        "name": "GLM 5.1",
        "reasoning": true,
        "tool_call": true,
        "attachment": false,
        "modalities": {"input": ["text"], "output": ["text"]},
        "cost": {"input": 1.4, "output": 4.4, "cache_read": 0.26},
        "limit": {"context": 202800, "output": 131072},
        "open_weights": true
      },
      "accounts/fireworks/models/llama-vision": {
        "id": "accounts/fireworks/models/llama-vision",
        "name": "Llama Vision",
        "modalities": {"input": ["text", "image"], "output": ["text"]},
        "cost": {"input": 0.2, "output": 0.2},
        "limit": {"context": 128000, "output": 4096}
      }
    }
  },
  "minimax": {
    "id": "minimax",
    "name": "MiniMax",
    "npm": "@ai-sdk/anthropic",
    "api": "https://api.minimax.io/anthropic/v1",
    "env": ["MINIMAX_API_KEY"],
    "models": {
      "abab-6.5": {
        "id": "abab-6.5",
        "name": "MiniMax abab 6.5",
        "cost": {"input": 1.0, "output": 1.0},
        "limit": {"context": 245000}
      }
    }
  },
  "anthropic": {
    "id": "anthropic",
    "name": "Anthropic",
    "npm": "@ai-sdk/anthropic",
    "api": null,
    "env": ["ANTHROPIC_API_KEY"],
    "models": {
      "claude-opus-4": {"id": "claude-opus-4", "name": "Claude Opus 4"}
    }
  },
  "cloudflare-workers-ai": {
    "id": "cloudflare-workers-ai",
    "name": "Cloudflare Workers AI",
    "api": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "models": {}
  },
  "partial-model-provider": {
    "id": "partial-model-provider",
    "name": "Partial",
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.partial.example/v1",
    "models": {
      "sparse": {
        "id": "sparse",
        "name": "Sparse Model"
      }
    }
  }
}`

func newModelsDevTestServer(t *testing.T, status int, body string) *httptest.Server {
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

func TestModelsDevSource_FetchFiltersSDKOnlyAndTemplatedURLs(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	providers, err := src.Fetch(context.Background())
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}

	// anthropic (api==null) and cloudflare-workers-ai (templated URL)
	// should be dropped. Remaining: fireworks-ai, minimax, partial-model-provider.
	if len(providers) != 3 {
		ids := make([]string, len(providers))
		for i, p := range providers {
			ids[i] = p.Id
		}
		t.Fatalf("want 3 providers after filtering, got %d: %v", len(providers), ids)
	}
	ids := make(map[string]bool)
	for _, p := range providers {
		ids[p.Id] = true
	}
	if !ids["fireworks-ai"] || !ids["minimax"] || !ids["partial-model-provider"] {
		t.Errorf("missing expected provider; got %v", ids)
	}
	if ids["anthropic"] {
		t.Error("anthropic (api==null) should have been filtered out")
	}
	if ids["cloudflare-workers-ai"] {
		t.Error("cloudflare-workers-ai (templated URL) should have been filtered out")
	}
}

func TestModelsDevSource_FetchInfersAnthropicBackend(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	providers, _ := src.Fetch(context.Background())

	var minimax, fireworks *struct {
		typ string
	}
	for _, p := range providers {
		if p.Id == "minimax" {
			minimax = &struct{ typ string }{p.Type}
		}
		if p.Id == "fireworks-ai" {
			fireworks = &struct{ typ string }{p.Type}
		}
	}
	if minimax == nil || minimax.typ != "anthropic" {
		t.Errorf("minimax: want type=anthropic (npm @ai-sdk/anthropic), got %v", minimax)
	}
	if fireworks == nil || fireworks.typ != "openai" {
		t.Errorf("fireworks-ai: want type=openai, got %v", fireworks)
	}
}

func TestModelsDevSource_FetchParsesModelFields(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	providers, _ := src.Fetch(context.Background())

	var glm, llamaVision *struct {
		ctx       int64
		in, out   float64
		reason    bool
		images    bool
		maxTokens int64
	}
	for _, p := range providers {
		if p.Id != "fireworks-ai" {
			continue
		}
		for _, m := range p.Models {
			info := &struct {
				ctx       int64
				in, out   float64
				reason    bool
				images    bool
				maxTokens int64
			}{
				ctx:       m.ContextWindow,
				in:        m.CostPer_1MIn,
				out:       m.CostPer_1MOut,
				reason:    m.CanReason,
				images:    m.SupportsImages,
				maxTokens: m.DefaultMaxTokens,
			}
			switch m.Id {
			case "accounts/fireworks/models/glm-5p1":
				glm = info
			case "accounts/fireworks/models/llama-vision":
				llamaVision = info
			}
		}
	}

	if glm == nil || glm.in != 1.4 || glm.out != 4.4 {
		t.Errorf("glm pricing: want 1.4/4.4 (per-1M, no conversion), got %+v", glm)
	}
	if glm == nil || glm.ctx != 202800 || glm.maxTokens != 131072 {
		t.Errorf("glm limits: want ctx=202800 max=131072, got %+v", glm)
	}
	if glm == nil || !glm.reason {
		t.Errorf("glm should be flagged as reasoning model")
	}
	if glm == nil || glm.images {
		t.Errorf("glm has text-only modalities, should not be image-capable")
	}
	if llamaVision == nil || !llamaVision.images {
		t.Errorf("llamaVision has image input modality, should be flagged SupportsImages")
	}
}

func TestModelsDevSource_FetchBaseURLStripsTrailingSlash(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	providers, _ := src.Fetch(context.Background())

	for _, p := range providers {
		if p.Id == "fireworks-ai" {
			// Upstream fixture has trailing slash; stored form must not.
			if p.DefaultBaseUrl != "https://api.fireworks.ai/inference/v1" {
				t.Errorf("trailing slash not stripped: %q", p.DefaultBaseUrl)
			}
		}
	}
}

func TestModelsDevSource_FetchHandlesPartialModel(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	providers, _ := src.Fetch(context.Background())

	// partial-model-provider has one model with only id+name — every
	// other field missing. Should parse without panic, zero values.
	for _, p := range providers {
		if p.Id != "partial-model-provider" {
			continue
		}
		if len(p.Models) != 1 {
			t.Fatalf("want 1 model, got %d", len(p.Models))
		}
		m := p.Models[0]
		if m.Id != "sparse" || m.Name != "Sparse Model" {
			t.Errorf("sparse model identity wrong: %+v", m)
		}
		if m.ContextWindow != 0 || m.CostPer_1MIn != 0 || m.DefaultMaxTokens != 0 {
			t.Errorf("partial model should have zero numerics, got %+v", m)
		}
	}
}

func TestModelsDevSource_Authoritative(t *testing.T) {
	src := NewModelsDevSource()
	for _, pid := range []string{"openai", "anthropic", "openrouter", "fireworks-ai", ""} {
		if src.Authoritative(pid) {
			t.Errorf("models-dev should never be authoritative; was for %q", pid)
		}
	}
}

func TestModelsDevSource_FetchNon200ReturnsError(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusServiceUnavailable, "maintenance")
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())
	_, err := src.Fetch(context.Background())
	if err == nil {
		t.Fatal("expected error on non-200")
	}
	if !strings.Contains(err.Error(), "503") {
		t.Errorf("expected status code in error, got %q", err.Error())
	}
}

func TestModelsDevSource_ProviderOrderIsStable(t *testing.T) {
	srv := newModelsDevTestServer(t, http.StatusOK, modelsDevFixture)
	defer srv.Close()

	src := newModelsDevSourceWith(srv.URL, srv.Client())

	// Fetch twice, assert provider ID order matches. Map iteration in
	// Go is randomized per-run, so without the sort this would flake.
	a, _ := src.Fetch(context.Background())
	b, _ := src.Fetch(context.Background())
	if len(a) != len(b) {
		t.Fatalf("fetch length mismatch: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i].Id != b[i].Id {
			t.Errorf("provider order not stable at %d: %q vs %q", i, a[i].Id, b[i].Id)
		}
	}
}
