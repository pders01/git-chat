# git-chat

Self-hosted LLM chat bound to a git repository. Single binary (Go + Lit). Works as a `git chat` subcommand or standalone CLI. Chat with an LLM about your codebase -- the knowledge base automatically invalidates when source code changes.

## Quick start

```bash
# Install
go install github.com/pders01/git-chat/cmd/git-chat@latest

# Run (auto-detects repo, opens browser)
cd ~/code/my-repo
git chat

# Explicit backend
git chat --llm-backend=anthropic --llm-api-key=$ANTHROPIC_API_KEY
```

## CLI usage

```
git chat                         # local mode, CWD repo, auto-open browser
git chat serve --repo /path/to/repo1 --repo /path/to/repo2
git chat mcp                     # MCP server mode (stdio)
git chat add-key paul@laptop < ~/.ssh/id_ed25519.pub
```

## Features

- **Chat** -- streaming LLM responses with markdown rendering, @-mention file injection (recursive autocomplete), `[[diff]]` marker expansion, KB cache hits
- **Knowledge base** -- FTS5 fuzzy matching, N>=2 promotion threshold, blob-SHA provenance, git-aware invalidation, webhook notifications (Slack/Discord)
- **KB management** -- card list with detail view, provenance display, delete, hit counts, invalidation status
- **File browser** -- expandable file tree (VS Code-style, lazy-load, arrow-key nav) + syntax highlighting (Shiki, 25 languages) + focus mode
- **Git blame** -- 2-panel info pane with interactive tooltip (cursor-following, 300ms debounce), "view in log" / "ask in chat" action buttons
- **Commit log** -- 3-column layout (list | info pane | diff pane), per-file diffs, SVG timeline graph via parent SHA linking
- **Branch comparison** -- file-by-file diff between any two refs
- **Working tree changes** -- staged, unstaged, untracked files with per-file diff viewer
- **3D code city** -- Three.js visualization of file churn (commit frequency, additions/deletions, file size mapped to building dimensions), squarified treemap layout, time slider
- **File history** -- commits filtered to a single file path
- **Side-by-side diff** -- word-level diff highlighting via Shiki diff grammar
- **Commit search** -- filter by message or author
- **Branch/tag switching** -- global ref selector in header (branches + tags)
- **Session pinning** -- star/unstar important sessions
- **Streaming token counter** -- live token count + cost estimate per turn
- **LLM dashboard summaries** -- auto-generated activity summary with suggested questions
- **Runtime-configurable settings** -- 18 GITCHAT_* env vars exposed in UI settings, 3-tier resolution (SQLite override -> env var -> compiled default)
- **Cross-tab navigation** -- "explain in chat" from log, "ask in chat" from browser, blame-to-log SHA linking, Cmd+click files
- **MCP server mode** -- 5 tools: `search_knowledge`, `get_file`, `get_diff`, `list_commits`, `search_files`
- **Two LLM backends** -- OpenAI-compatible (LM Studio, Ollama, vLLM, OpenAI, Groq) + Anthropic native
- **Theme support** -- system/light/dark with Shiki dual-theme
- **Auth** -- local mode (token URL) or SSH key pairing for multi-user

## Architecture

Go backend (Connect-RPC, `connectrpc.com/connect`) + Lit frontend (embedded via `go:embed`). Single `.proto` source of truth generates both Go server handlers and TypeScript clients. All state in one SQLite file (`modernc.org/sqlite`, pure Go, no CGO).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design document.

## Environment variables

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BACKEND` | `openai` | `openai` or `anthropic` |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible endpoint (ignored for anthropic) |
| `LLM_MODEL` | `gemma-4-e4b-it` / `claude-sonnet-4-6` | Model name (default per backend) |
| `LLM_API_KEY` | -- | API key (required for anthropic) |
| `LLM_TEMPERATURE` | `0` | Sampling temperature (0 = deterministic) |
| `LLM_MAX_TOKENS` | `0` | Max tokens per response (0 = provider default) |

### Repo

| Variable | Default | Description |
|----------|---------|-------------|
| `GITCHAT_MAX_DIFF_BYTES` | `32768` | Max whole-commit diff size |
| `GITCHAT_DEFAULT_COMMIT_LIMIT` | `50` | Default commit list page size |
| `GITCHAT_DIFF_CONTEXT_LINES` | `3` | Context lines around diff hunks |
| `GITCHAT_DEFAULT_FILE_BYTES` | `524288` | Default max file size for GetFile |

### Chat / Prompt

| Variable | Default | Description |
|----------|---------|-------------|
| `GITCHAT_MAX_FILE_BYTES` | `4096` | Per @-file injection cap |
| `GITCHAT_MAX_TOTAL_INJECT` | `12288` | Total @-file budget per turn |
| `GITCHAT_MAX_BASELINE_BYTES` | `4096` | Overview doc injection cap |
| `GITCHAT_MAX_HISTORY_DIFF` | `4096` | Per-diff cap in history expansion |
| `GITCHAT_MAX_TREE_LINES` | `60` | Max lines in baseline tree listing |
| `GITCHAT_MAX_TREE_BYTES` | `2048` | Max bytes in baseline tree listing |
| `GITCHAT_RECENT_COMMITS` | `5` | Recent commits in system prompt |
| `GITCHAT_MAX_MESSAGE_BYTES` | `32768` | Max user message size |
| `GITCHAT_MAX_HISTORY_TURNS` | `20` | Sliding window of history turns sent to LLM |
| `GITCHAT_TITLE_MAX_LEN` | `48` | Max auto-generated session title length |
| `GITCHAT_TITLE_TIMEOUT` | `15s` | Timeout for LLM title generation |
| `GITCHAT_CARD_TIMEOUT` | `10s` | Timeout for KB card promotion |
| `GITCHAT_KB_PROMOTION_THRESHOLD` | `2` | Min similar questions before promotion |

### Session

| Variable | Default | Description |
|----------|---------|-------------|
| `GITCHAT_SESSION_TTL` | `168h` | Browser session cookie lifetime |
| `GITCHAT_DEFAULT_SESSION_LIMIT` | `100` | Default session list page size |

### Webhook

| Variable | Default | Description |
|----------|---------|-------------|
| `GITCHAT_WEBHOOK_URL` | (empty) | Slack/Discord incoming webhook URL (empty = disabled) |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `GITCHAT_DB` | `~/.local/state/git-chat/state.db` | SQLite state file |
| `XDG_STATE_HOME` | `~/.local/state` | Base for default DB path |

All `GITCHAT_*` variables are runtime-configurable via the settings UI. Values set in the UI are stored as SQLite overrides and take precedence over env vars.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Cmd+K` / `Ctrl+K` | New chat |
| `Cmd+1-3` / `Ctrl+1-3` | Switch tabs |
| `Cmd+\` / `Ctrl+\` | Toggle focus mode |
| `/` | Focus composer |
| `Esc` | Blur / close modal |
| `?` | Shortcut help |
| `F2` | Rename selected session |
| `ArrowUp/Down` | Navigate lists (sessions, files, commits, mentions) |
| `Enter` | Select / expand |
| `ArrowRight/Left` | Expand / collapse file tree nodes |

## Development

```bash
make dev          # vite HMR on :5173 + Go server on :8080
make check        # go vet + go test + tsc --noEmit
make test-e2e     # Playwright (desktop + mobile), 24 tests
make proto        # buf generate
make all          # frontend + Go binary
```

Requirements: Go 1.24+, Bun 1.2+, Chromium (for Playwright).
