# git-chat

A self-hosted, persistent chat session bound to a git repository. Chat with an LLM about your codebase — the knowledge base automatically invalidates when source code changes.

## Quick start

```bash
# Build
make all

# Run locally (LM Studio / Ollama on :1234)
./dist/git-chat local .

# Run with Anthropic
./dist/git-chat local --llm-backend=anthropic --llm-api-key=$ANTHROPIC_API_KEY .

# Multi-repo serve mode (SSH pairing)
./dist/git-chat serve --repo /path/to/repo1 --repo /path/to/repo2
```

## Features

- **Chat** — streaming LLM responses with markdown + Shiki syntax highlighting
- **Browse** — file tree + highlighted source viewer
- **Log** — commit history with inline diff expansion
- **Knowledge cards** — high-frequency answers cached with git-aware invalidation (FTS5 fuzzy matching, blob-SHA provenance)
- **Diff primitives** — `[[diff]]` markers in LLM output auto-resolve to highlighted patches via `GetDiff` RPC
- **Cross-view bridges** — "explain in chat" from log, "ask in chat" from file browser, recent commits in system prompt
- **Two LLM backends** — OpenAI-compatible (LM Studio, Ollama, vLLM, OpenAI) + Anthropic native
- **Single binary** — Go + Lit, no external dependencies at runtime
- **Auth** — local mode (token URL) or SSH key pairing for multi-user

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BACKEND` | `openai` | `openai` or `anthropic` |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible endpoint (ignored for anthropic) |
| `LLM_MODEL` | `gemma-4-e4b-it` / `claude-sonnet-4-6` | Model name (default per backend) |
| `LLM_API_KEY` | — | API key (required for anthropic) |
| `GITCHAT_DB` | `~/.local/state/git-chat/state.db` | SQLite state file |
| `XDG_STATE_HOME` | `~/.local/state` | Base for default DB path |
| `GITCHAT_MAX_FILE_BYTES` | `4096` | Per @-file injection cap (increase for large-context models) |
| `GITCHAT_MAX_TOTAL_INJECT` | `12288` | Total @-file budget per turn |
| `GITCHAT_MAX_BASELINE_BYTES` | `4096` | Overview doc injection cap |
| `GITCHAT_MAX_HISTORY_DIFF` | `4096` | Per-diff cap in history expansion |
| `GITCHAT_MAX_TREE_LINES` | `60` | Max lines in baseline tree listing |
| `GITCHAT_MAX_TREE_BYTES` | `2048` | Max bytes in baseline tree listing |
| `GITCHAT_RECENT_COMMITS` | `5` | Number of recent commits in system prompt |
| `GITCHAT_MAX_MESSAGE_BYTES` | `32768` | Max user message size in bytes |
| `GITCHAT_MAX_HISTORY_TURNS` | `20` | Sliding window of history turns sent to LLM |
| `GITCHAT_TITLE_MAX_LEN` | `48` | Max length of auto-generated session titles |
| `GITCHAT_TITLE_TIMEOUT` | `15s` | Timeout for LLM title generation |
| `GITCHAT_CARD_TIMEOUT` | `10s` | Timeout for knowledge-card promotion |
| `GITCHAT_KB_PROMOTION_THRESHOLD` | `2` | Min similar questions before KB promotion |
| `GITCHAT_DEFAULT_FILE_BYTES` | `524288` | Default max file size for GetFile |
| `GITCHAT_MAX_DIFF_BYTES` | `32768` | Max whole-commit diff size |
| `GITCHAT_DEFAULT_COMMIT_LIMIT` | `50` | Default commit list page size |
| `GITCHAT_DIFF_CONTEXT_LINES` | `3` | Context lines around diff hunks |
| `GITCHAT_SESSION_TTL` | `168h` | Browser session cookie lifetime |
| `GITCHAT_DEFAULT_SESSION_LIMIT` | `100` | Default session list page size |
| `LLM_TEMPERATURE` | `0` | LLM sampling temperature (0 = deterministic) |
| `LLM_MAX_TOKENS` | `0` | Max tokens per LLM response (0 = provider default) |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `⌘K` / `Ctrl+K` | New chat |
| `⌘1-3` / `Ctrl+1-3` | Switch tabs |
| `⌘\` / `Ctrl+\` | Toggle focus mode |
| `/` | Focus composer |
| `Esc` | Blur / close modal |
| `?` | Shortcut help |

## Development

```bash
make dev          # vite HMR on :5173 + Go server on :8080
make check        # go vet + go test + tsc --noEmit
make test-e2e     # Playwright (desktop + mobile)
make proto        # buf generate
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design document covering the knowledge-card lifecycle, Connect-RPC surface, and milestone breakdown.
