package llm

import "fmt"

// Build constructs the right LLM adapter for the given backend.
// If *model is empty, a backend-specific default is applied in place.
func Build(backend, baseURL, apiKey string, model *string) (LLM, error) {
	switch backend {
	case "openai", "":
		if *model == "" {
			*model = "gemma-4-e4b-it"
		}
		return NewOpenAI(baseURL, apiKey), nil
	case "anthropic":
		if apiKey == "" {
			return nil, fmt.Errorf("API key is required for the anthropic backend")
		}
		if *model == "" {
			*model = "claude-sonnet-4-6"
		}
		return NewAnthropic(apiKey), nil
	default:
		return nil, fmt.Errorf("unknown LLM backend %q (expected 'openai' or 'anthropic')", backend)
	}
}
