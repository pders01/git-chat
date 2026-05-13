# git-chat for VS Code / Open VSX

Self-hosted LLM chat bound to a git repository, embedded in your editor as a webview.

## Status

**Tier 2 scaffold.** The extension spawns a local `git-chat` binary and hosts the existing Lit SPA in a webview iframe. Reuses ~100% of the frontend.

## How it works

1. Command `git-chat: Open in current workspace` runs `git-chat local --ext-mode --http 127.0.0.1:0 <workspaceFolder>`.
2. The Go server prints exactly one line on stdout once it's ready:
   ```
   GITCHAT_READY port=<port> token=<one-shot-claim-token>
   ```
   Format is stable — extensions parse it positionally. See `src/parseReady.ts`.
3. The extension creates a `WebviewPanel` with a `portMapping` rule pointing at `127.0.0.1:<port>` and an `<iframe>` loading `http://127.0.0.1:<port>/?t=<token>`.
4. The SPA claims the token via `LocalClaim` and a session cookie is set inside the webview. From here on it's the regular SPA flow.
5. Closing the panel kills the child process. `gitChat.restart` respawns.

`--ext-mode` is a thin variant of local mode:
- Replaces `X-Frame-Options: DENY` with a `frame-ancestors` CSP directive that allows `vscode-webview://*` (and `https://*.vscode-cdn.net` for VS Code derivatives).
- Skips the human-readable startup banner; emits `GITCHAT_READY` instead.
- Skips browser auto-open.

The server still binds to loopback. The extension is the only thing that can reach it.

## Binary resolution

The extension does not (yet) bundle or auto-download the Go binary. Resolution order:

1. `gitChat.binaryPath` setting.
2. `GITCHAT_EXT_BINARY` env var.
3. `git-chat` on `$PATH`.
4. Cached download in extension global storage (planned).

Install one of these first:
```
brew install git-chat            # not yet published
go install github.com/pders01/git-chat/cmd/git-chat@latest
make all && sudo make install    # from a clone
```

Auto-download from GitHub releases is the next step — see `extension/src/binary.ts` for the platform-tag helper.

## Build

```
cd extension
bun install
bun run build      # esbuild -> dist/extension.js
bun run package    # vsce package -> git-chat.vsix
```

Or from repo root:
```
make ext           # bundle
make ext-package   # .vsix
```

## Publishing to Open VSX

```
make ext-package
make ext-publish   # ovsx publish git-chat.vsix
```

Requires `OVSX_PAT` env var. Bump `version` in `package.json` first.

## Known gaps (tier 2 -> tier 3)

- No binary auto-download (release pipeline needed).
- Single panel only — switching workspaces requires restart.
- No status bar item.
- `vscode.workspace.workspaceFolders[0]` only; multi-root workspaces ignored.
- LLM config piped through one-way; changes inside the SPA persist to its SQLite, not VS Code settings.

## Settings

| Key | Default | Purpose |
|-----|---------|---------|
| `gitChat.binaryPath` | `""` | Absolute path to `git-chat`. Overrides PATH lookup. |
| `gitChat.llmBackend` | `"openai"` | Forwarded as `--llm-backend`. |
| `gitChat.llmBaseUrl` | `""` | Forwarded as `--llm-base-url`. Empty = use the binary's default. |
| `gitChat.llmModel` | `""` | Forwarded as `--llm-model`. |
