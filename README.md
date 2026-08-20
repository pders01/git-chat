# git-chat

Headless repository chat and knowledge services. The browser and editor UIs have
been removed while the project takes a new direction; the reusable repository
surfaces now belong in `pi-webui`.

## Modes

```bash
git-chat chat --repo . "summarize the recent changes"
git-chat mcp .
git-chat local .
git-chat serve --repo /path/to/repo
```

- `chat` runs one model turn and streams the answer to stdout.
- `mcp` exposes read-only repository tools over stdio.
- `local` starts the Connect API on loopback and prints a one-shot claim token.
- `serve` starts the authenticated multi-repository Connect API and SSH pairing
  service.

The backend retains persistent sessions, the git-aware knowledge-card store,
repository tools, model adapters, and generated Go Connect contracts. It does
not ship HTML, JavaScript, a browser launcher, or an editor extension.

## Development

```bash
make check
make all
make proto
```

Requirements: Go 1.25+, Git, and Buf when regenerating protobuf code.

## Configuration

The existing `GITCHAT_*` and `LLM_*` environment variables remain supported.
Use `git-chat <command> --help` for command-specific flags. State defaults to
`~/.local/state/git-chat/state.db` unless `GITCHAT_DB` is set.

## License

MIT
