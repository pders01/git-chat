# Architecture

Git-chat is currently headless. Its stable boundary is repository-aware chat,
knowledge storage, and read-only git tooling rather than an application UI.

## Entry points

- `git-chat chat` calls the chat service in-process for a single terminal turn.
- `git-chat mcp` exposes repository and knowledge tools over stdio.
- `git-chat local` serves the Connect API on loopback and issues a local claim
  token.
- `git-chat serve` serves the Connect API with SSH pairing and registered
  principals.

## Packages

- `internal/repo` owns confined, read-only repository inspection: trees, files,
  history, blame, status, comparisons, diffs, and search.
- `internal/chat` owns model turns, tool execution, and knowledge-card promotion
  and invalidation.
- `internal/storage` owns SQLite migrations and persistent sessions, cards,
  provenance, configuration, and search indexes.
- `internal/auth` owns local claims, session cookies, SSH identities, and
  authorization interceptors.
- `internal/rpc` wires the generated Go Connect handlers. It serves no static
  application assets.
- `internal/mcp` adapts repository operations to MCP tools.

## Data and trust boundaries

Repository IDs resolve through the registry; clients never supply arbitrary
server filesystem roots. Git reads use fixed executable arguments and repository
confinement. Connect repository and chat methods require an authenticated
principal. Local mode refuses non-loopback addresses. Knowledge cards retain the
commit and blob provenance used to derive them so changed source can invalidate
stale answers.

## Protocol

`proto/gitchat/v1` remains the source of truth. Buf generates Go messages and
Connect handlers under `gen/go`. No browser TypeScript client is generated in
this repository.

## User interfaces

There is intentionally no browser, Lit, VS Code, Open VSX, calendar, or code-city
surface here. Practical repository and knowledge workflows are being rebuilt in
`pi-webui` against its own typed WebSocket and workspace/session model.
