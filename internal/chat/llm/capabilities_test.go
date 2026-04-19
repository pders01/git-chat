package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAnthropicCapabilitiesNameHeuristic(t *testing.T) {
	a := &Anthropic{}
	cases := map[string]bool{
		"claude-sonnet-4-6":         true,
		"claude-opus-4-7":           true,
		"claude-haiku-4-5-20251001": true,
		"claude-3-5-sonnet":         true,
		"claude-instant-1.2":        false,
		"claude-2.1":                false,
		"":                          false,
	}
	for model, want := range cases {
		got := a.Capabilities(context.Background(), model).Images
		if got != want {
			t.Errorf("model=%q images=%v, want %v", model, got, want)
		}
	}
}

func TestOpenAINameHeuristic(t *testing.T) {
	cases := map[string]bool{
		"gpt-4o":              true,
		"gpt-4o-mini":         true,
		"gpt-4-turbo":         true,
		"llava-7b":            true,
		"qwen2.5-vl-instruct": true,
		"llama-3.2-vision":    true,
		"gemma-3-4b-it":       true,
		"gemma-4-e4b-it":      false, // not vision-capable
		"mistral-7b-instruct": false,
		"nonsense":            false,
	}
	for model, want := range cases {
		if got := nameLooksVisionCapable(model); got != want {
			t.Errorf("model=%q got=%v want=%v", model, got, want)
		}
	}
}

func TestOpenAIVisionAllowlist(t *testing.T) {
	o := &OpenAI{}
	o.SetVisionAllowlist("my-cool-model,another-one")
	if !o.matchesVisionAllowlist("local/my-cool-model-v2") {
		t.Error("expected allowlist substring match")
	}
	if o.matchesVisionAllowlist("unrelated") {
		t.Error("unexpected allowlist match for unrelated model")
	}
}

func TestOpenAIOllamaProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/show" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"details": map[string]any{
				"families": []string{"llama", "clip"},
			},
		})
	}))
	defer srv.Close()
	o := NewOpenAI(srv.URL+"/v1", "")
	if !o.Capabilities(context.Background(), "mymodel").Images {
		t.Error("expected images=true from Ollama CLIP family")
	}
	// Second call should hit cache — flip server to 404 to prove it.
	srv.Close()
	if !o.Capabilities(context.Background(), "mymodel").Images {
		t.Error("second call should return cached true even with server down")
	}
}

func TestOpenAILMStudioProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v0/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": "text-only-7b", "vision": false},
				{"id": "gemma-4-e4b-it", "vision": false},
				{"id": "llava-next", "vision": true},
			},
		})
	}))
	defer srv.Close()
	o := NewOpenAI(srv.URL+"/v1", "")
	if o.Capabilities(context.Background(), "gemma-4-e4b-it").Images {
		t.Error("expected images=false from LM Studio payload")
	}
	if !o.Capabilities(context.Background(), "llava-next").Images {
		t.Error("expected images=true for llava-next")
	}
}
