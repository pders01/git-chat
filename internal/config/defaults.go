package config

// RegisterDefaults registers all known GITCHAT_* environment variables
// with their compiled defaults, descriptions, and groups.
func RegisterDefaults(r *Registry) {
	// ── repo ──────────────────────────────────────────────────────
	r.Register("GITCHAT_MAX_DIFF_BYTES", "32768", "Max bytes for whole-commit diffs", "repo")
	r.Register("GITCHAT_DEFAULT_COMMIT_LIMIT", "50", "Default number of commits per page", "repo")
	r.Register("GITCHAT_DIFF_CONTEXT_LINES", "3", "Context lines in unified diffs", "repo")
	r.Register("GITCHAT_DEFAULT_FILE_BYTES", "524288", "Max bytes for file content responses", "repo")

	// ── chat / prompt ─────────────────────────────────────────────
	r.Register("GITCHAT_MAX_FILE_BYTES", "4096", "Per @-file injection cap (bytes)", "chat")
	r.Register("GITCHAT_MAX_TOTAL_INJECT", "12288", "Total @-file budget per turn (bytes)", "chat")
	r.Register("GITCHAT_MAX_BASELINE_BYTES", "4096", "Overview doc cap (bytes)", "chat")
	r.Register("GITCHAT_MAX_HISTORY_DIFF", "4096", "Per-diff cap in history expansion (bytes)", "chat")
	r.Register("GITCHAT_MAX_TREE_LINES", "60", "Max tree lines in context", "chat")
	r.Register("GITCHAT_MAX_TREE_BYTES", "2048", "Max tree bytes in context", "chat")
	r.Register("GITCHAT_RECENT_COMMITS", "5", "Recent commits included in context", "chat")
	r.Register("GITCHAT_MAX_MESSAGE_BYTES", "32768", "Max bytes per chat message", "chat")
	r.Register("GITCHAT_MAX_HISTORY_TURNS", "20", "Max history turns sent to LLM", "chat")
	r.Register("GITCHAT_TITLE_MAX_LEN", "48", "Max characters for auto-generated session titles", "chat")
	r.Register("GITCHAT_TITLE_TIMEOUT", "15s", "Timeout for title generation LLM call", "chat")
	r.Register("GITCHAT_CARD_TIMEOUT", "10s", "Timeout for knowledge card operations", "chat")
	r.Register("GITCHAT_KB_PROMOTION_THRESHOLD", "2", "Similar-question count before KB promotion", "chat")

	// ── session ───────────────────────────────────────────────────
	r.Register("GITCHAT_SESSION_TTL", "168h", "Browser session TTL (Go duration string)", "session")
	r.Register("GITCHAT_DEFAULT_SESSION_LIMIT", "100", "Default number of sessions returned by list", "session")

	// ── llm ──────────────────────────────────────────────────────
	r.Register("LLM_BACKEND", "openai", "LLM backend: 'openai' or 'anthropic'", "llm")
	r.RegisterRestricted("LLM_BASE_URL", "http://localhost:1234/v1", "OpenAI-compatible base URL (ignored for anthropic)", "llm")
	r.Register("LLM_MODEL", "", "Model name (empty = backend default)", "llm")
	r.RegisterSecret("LLM_API_KEY", "", "API key (required for anthropic)", "llm")
	r.Register("LLM_ACTIVE_PROFILE", "", "Active LLM profile ID (empty = use individual LLM_* settings)", "llm")
	r.Register("LLM_TEMPERATURE", "", "Sampling temperature (empty = use startup flag, 0 = deterministic)", "llm")
	r.Register("LLM_MAX_TOKENS", "", "Max tokens per response (empty = use startup flag, 0 = provider default)", "llm")

	// ── webhooks ──────────────────────────────────────────────────
	r.RegisterRestricted("GITCHAT_WEBHOOK_URL", "", "Slack/Discord incoming webhook URL (empty = disabled)", "webhook")
}
