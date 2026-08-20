# git-chat

git-chat is a headless, repository-aware chat and knowledge service for Git
repositories. It provides command-line workflows, an MCP server, and Connect
APIs without shipping a browser or editor interface.

> [!NOTE]
> The deprecated browser and editor UI is preserved on the
> [`archive/legacy-ui`](https://github.com/pders01/git-chat/tree/archive/legacy-ui)
> branch for historical reference. It is no longer maintained.

## Commands

```bash
# Run one model turn and stream the response to stdout.
git-chat chat --repo . "summarize the recent changes"

# Expose repository tools to MCP clients over stdio.
git-chat mcp .

# Start a loopback Connect API and print a one-shot claim token.
git-chat local .

# Serve one or more repositories with SSH-key pairing.
git-chat serve --repo /path/to/repo
```

Run `git-chat <command> --help` for command-specific options.

## Capabilities

- Repository-aware chat with bounded file, tree, commit, and diff context.
- Read-only MCP tools for files, history, search, branches, diffs, outlines, and
  blame.
- Persistent chat sessions and a Git-aware knowledge-card store backed by
  SQLite and FTS5.
- Blob-based knowledge provenance and invalidation when source content changes.
- OpenAI-compatible and Anthropic model adapters.
- Loopback token claims for local API clients and SSH-key pairing for served
  repositories.
- Slack and Discord webhook notifications for knowledge-card lifecycle events.

The distribution is a Go binary. It contains no embedded HTML or JavaScript,
does not launch a browser, and does not include an editor extension.

## Configuration

Configuration is available through command flags and the existing `GITCHAT_*`
and `LLM_*` environment variables. Common settings include:

- `GITCHAT_DB` — SQLite state path; defaults to
  `~/.local/state/git-chat/state.db`.
- `LLM_BACKEND` — `openai` or `anthropic`.
- `LLM_BASE_URL` — endpoint for an OpenAI-compatible provider.
- `LLM_MODEL` — model identifier.
- `LLM_API_KEY` — provider API key.
- `GITCHAT_WEBHOOK_URL` — optional Slack or Discord webhook.

## Development

```bash
make check
make all
make proto
```

Development requires Go 1.25+ and Git. Buf is required only when regenerating
protobuf code.

## License

MIT
