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
protobuf code. Generator versions are pinned in `buf.gen.yaml` to the existing
Go/Connect runtime generation; regeneration must not silently migrate Connect APIs.

`ListBranches` returns additive `Branch.full_ref` metadata for both branches and
tags (for example `refs/heads/main` versus `refs/tags/main`). Use it for exact ref
selection. The legacy `name` stays a display label and may be ambiguity-shortened;
`commit` can identify an annotated tag object and is not a promise of a peeled
commit. Resolve the selected full ref before immutable history reads. Old clients
can ignore `full_ref`; older servers omit it, so clients must not guess through
ambiguous legacy names.

git-chat owns the wire schemas and generated Go code. After an approved schema
change, use the selected git-chat revision to update the generated TypeScript
descriptors in Repokit according to its protocol generation guide, and verify
binary/JSON compatibility there. Chatworks reexports those descriptors from
the compiled protocol package and verifies its own packed consumer. No browser
assets are served or embedded by git-chat.

### History fallback fidelity

`ListCommits` resolves the selector to one commit before paging. Canonical refs
are exact, paths are literal repository-relative filters, and an empty selector
uses the registered default branch. Native Git and the validated linear-history
go-git fallback start from the same commit. Cancellation is terminal rather than
a reason to start another walk. Iterator/tree/blob/stat failures reject the page
instead of reporting false exhaustion or zero stats.
Exact-path history retains mode-only changes; summaries use actual empty-tree
root diffs and honor the literal file/directory filter rather than estimating
root additions from file size or counting unrelated paths.

Disposable native-helper/go-git regression oracles cover these cases, sparse
pinned pagination and legal whitespace/LF paths. `ListCommits` and `GetDiff` refuse
shallow repositories rather than inventing complete roots/exhaustion. Linear
fallback pretty subjects/body whitespace match tested native `%s`/`%b` output.
Native merge history is unchanged; fallback validates complete ancestry before
pagination and explicitly requires native Git for non-linear history. It does
not claim native merge ordering/path simplification through a different walk.

`GetDiff` includes modes in file identity and emits mode-only metadata even for
unchanged empty/binary/oversized blobs. Empty-file creation/deletion keeps metadata;
broken blob objects reject a patch rather than becoming invented additions. Patch
path controls are C-quoted, not literal header delimiters. Ordinary single-file
responses retain their prior shape except for zero-line mode-change evidence;
no new unbounded placeholder-stat reads. Immutable text patches distinguish an
existing empty file from an absent side, retain missing-final-LF notices and use
correct preceding-line coordinates for zero-length hunks. Disposable native-Git
index round trips verify text bytes/presence and numstat in the covered cases.
Renames retain source/destination identities even when the blob is unchanged;
caller `from_path` hints must represent actual disappearance/creation rather than
arbitrary copy/cross-path comparisons. Exact regular-file blob renames left separate
by chmod are coalesced only for unambiguous pairs. Regular-file/symlink transitions
use delete/create blocks while numstat remains a blob-text comparison. Root entry
enumeration includes gitlinks so unsupported modes refuse instead of disappearing.
Invalid UTF-8 patch text/paths refuse; literal U+FFFD remains valid. Binary/oversized
placeholders still do not establish byte completeness.

Go-git fallback message text accepts the tested UTF-8/UTF8 encoding declarations;
other encodings require native Git's conversion rather than publishing different
text. Invalid UTF-8 or NUL fallback metadata refuses. Raw object/header/encoding
normalization, directory/gitlink patch support and complete rename classification
are not certified. Legacy working-tree presence inference remains separate. Full
diff/encoding/version/performance parity remains unestablished.

### Diff work limits

The backend text LCS checks dimensions before line-slice/matrix allocation and uses
at most 1,048,576 matrix cells (8 MiB of ints on 64-bit hosts) per computation.
One context-aware allowance spans each read: 8,388,608 cells across all stats and
render stages, plus 16 MiB of streamed oversized-blob stat bytes. It never resets
per file/stage. Arithmetic overflow, exhausted work and streamed read failures
reject the read without partial patch/files or false empty-success. Native Connect
reports work refusal as `resource_exhausted` (HTTP 429), not a successful truncation.
There is no automatic retry or native/dependency fallback after this refusal.

Matrix/backtracking/hunk/output loops and stat streaming check cancellation;
request cancellation/deadline status is preserved. Branch comparisons and working-
tree LCS use the same per-read policy; the working-tree RPC retains its context
while the legacy public method remains compatible. These limits are independent
of patch byte/file caps, not claims about native Git/go-git algorithms, object
loading, whole-file working-tree I/O, total-process memory or wall-clock containment.

Native history/search use strict NUL-framed UTF-8 pretty fields and NUL numstat
paths; legal SOH/STX/
RS/US, tabs and newlines cannot invent rows. Native `%s`/`%b` text and body whitespace
are preserved (not raw commit-object byte equivalence). Malformed, undecodable or
oversized metadata rejects the whole read under an 8 MiB native-output cap instead
of falling back. Legacy churn framing and search aggregation semantics are separate.
No RPC schema or machine-readable patch-completeness guarantee changed.

## License

MIT
