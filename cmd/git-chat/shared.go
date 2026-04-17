package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/pders01/git-chat/internal/chat/llm"
	"github.com/pders01/git-chat/internal/storage"
)

// envOr returns the value of env var name, or def if the var is unset or
// empty. Used for flag default values so environment wins over the
// compiled default but loses to an explicit --flag.
func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// buildLLM constructs the right LLM adapter based on --llm-backend.
// Applies default model names per-backend if the user didn't specify one.
func buildLLM(backend, baseURL, apiKey string, model *string) (llm.LLM, error) {
	return llm.Build(backend, baseURL, apiKey, model)
}

// openDB resolves the SQLite path (explicit override or XDG default) and
// opens it. Factored here so both `serve` and `local` can share the
// exact same lifecycle.
func openDB(override string) (*storage.DB, error) {
	path := override
	if path == "" {
		p, err := storage.DefaultPath()
		if err != nil {
			return nil, fmt.Errorf("resolve state path: %w", err)
		}
		path = p
	}
	db, err := storage.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	return db, nil
}

func envFloat(name string, def float64) float64 {
	if v := os.Getenv(name); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envIntFlag(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
