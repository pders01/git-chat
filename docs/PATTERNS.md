# Patterns and conventions

This document captures the *rules of engagement* for contributing to
git-chat. It exists because most of the debt surfaced by codebase
audits (see commit history around April 2026) came from the same
patterns being applied inconsistently — not from genuinely hard
architectural choices. When you're tempted to do something clever,
check here first.

If you find yourself breaking a rule below, either (a) the rule is
wrong for your case and the exception should be documented inline
next to the code, or (b) you're about to add tech debt. Both are
fine; just be deliberate.

---

## Section 1 — Error handling

### 1.1 Never swallow errors silently in user-initiated mutations

If the user clicked a button that writes data (save profile, update
config, refresh catalog, delete something), a failure MUST surface
via a `gc:toast` event with `kind: "error"`. The `// TODO: surface
error` pattern is banned — it drifts into "we'll do it later" which
means "nobody ever notices the RPC started 500-ing."

```ts
// ❌ Don't
try { await repoClient.saveProfile({ profile }); }
catch { /* TODO: surface error */ }

// ✅ Do
try { await repoClient.saveProfile({ profile }); }
catch (e) {
  this.toast("error", this.errorMessage(e, "could not save profile"));
}
```

### 1.2 Discriminate user-initiated vs. passive loads

Passive loads (e.g. `loadCatalog` on panel open, `loadSessions` on
mount) don't toast on failure — the user didn't ask for them to
succeed. They fall back to a sensible empty state. Only mutations and
explicit refresh actions toast.

### 1.3 Backend: log non-fatal DB errors at Warn, propagate fatal ones

A write failure that *doesn't* affect the current response (KB hit
count increment, card verification update, provenance invalidation)
logs at `slog.Warn` with enough context to diagnose (card_id, reason,
err). The call site continues.

A write failure that leaves state inconsistent (e.g. `DeleteProfile`
couldn't clear the active profile pointer) propagates to the client
via `connect.NewError(connect.CodeInternal, ...)`.

The `_ = s.DB.X(ctx, ...)` pattern is always wrong for non-trivial
writes. Either log or propagate.

### 1.4 Streaming handlers check `send(...)` errors

In any `for chunk := range stream { ... send(chunk) ... }` loop, the
`send` call returns an error on client disconnect. Swallowing it
means we keep executing (and spending tokens) against a dead client.
Check it and `return` on failure, matching the pattern in
`chat/service.go:agenticLoop`.

---

## Section 2 — Custom events

### 2.1 Declare every `gc:*` event in `web/src/lib/events.ts`

Lit components dispatch `CustomEvent` instances that bubble up through
the app. Every such event MUST have a corresponding entry in
`HTMLElementEventMap` in `lib/events.ts`, with a named payload
interface exported from the same file.

Adding a new event is a four-step ritual:
1. Add `export interface MyEventDetail { ... }` to `lib/events.ts`.
2. Add `"gc:my-event": CustomEvent<MyEventDetail>;` to the
   `HTMLElementEventMap` block.
3. Dispatch with `bubbles: true, composed: true`.
4. Listen with `addEventListener("gc:my-event", handler)` — no
   `as EventListener` cast, no inline `CustomEvent<{...}>` retype.

The project previously had declarations scattered across composer.ts
and diff-pane.ts with inconsistent payload shapes. Centralized for
one-place-to-grep contracts.

### 2.2 Naming: `gc:<noun-or-verb-phrase>`, kebab-case

Examples: `gc:toast`, `gc:open-file`, `gc:slash-action`,
`gc:input-changed`, `gc:close`. The `gc:` prefix is a hard rule.

### 2.3 Empty payloads use `Record<string, never>`

For events with no useful detail (stop, retry, regenerate), declare
the payload as `CustomEvent<Record<string, never>>` rather than
`CustomEvent<{}>` or `CustomEvent` alone. Keeps the handler signature
consistent.

---

## Section 3 — Config and context

### 3.1 Every `GITCHAT_*` and `LLM_*` key is registered in `defaults.go`

If your code reads a config value via `s.cfgInt`, `s.cfgDur`,
`cfg.GetCtx`, etc., there MUST be a matching `r.Register(...)` call
in `internal/config/defaults.go`. Unregistered keys don't appear in
the settings UI and can't be edited by the user.

Exception: one documented legacy (`prewarmChurn` in
`internal/repo/registry.go`) reads env directly because the registry
doesn't exist yet at repo-registration time. A comment points this
out so a future sweep doesn't "fix" it.

### 3.2 Don't use `os.Getenv` directly for user-facing tunables

Always go through the registry. The registry chain resolves SQLite
override → env var → compiled default, which gives users UI-based
tuning. Direct `os.Getenv` only reads the env layer, so UI edits
never take effect.

### 3.3 Pass `context.Context` through to DB + RPC calls

Any function that does a config DB lookup, a go-git operation, an
HTTP call, or calls another function that does one of those MUST
accept `ctx context.Context` as its first parameter and forward it.

Exception: synchronous paths that have no natural request context
(e.g. cookie setup in `SetCookie`). Document the choice inline —
`// Using Background here is deliberate: no request ctx; the DB call
has a 5s internal timeout.`

### 3.4 Avoid repeated config lookups in hot paths

If the same config key is read on every RPC, cache it on the
receiving struct with a refresh interval (see `SessionStore.ttlDur`
for a 30s-cache example). Users can tolerate "change takes effect
within 30s"; the DB cannot tolerate "every auth check hits SQLite."

---

## Section 4 — Helpers and modules

### 4.1 Three-use threshold for lifting helpers

If a helper is used in 1 component: keep it local. If 2: maybe lift
to `lib/`, but not required. If 3+: lift. Two identical copies is
not debt; three is.

Recent lifts (as examples):
- `formatSources`, `providerSources`, `isProviderAvailable`,
  `findModelPricing`, `estimateCostUsd` → `lib/catalog.ts`
- `statusLabel`, `fileName` → `lib/diff-types.ts`
- `buildAvailabilityContext` → `lib/catalog.ts`

### 4.2 Pure helpers live in `web/src/lib/`

Anything without DOM/Lit dependencies goes in `lib/`. Component-
specific rendering helpers stay in the component file. If a helper
grows a DOM dep later, extract the pure core, keep the DOM wrapper
in the component.

### 4.3 One lib/ file per domain concept

Not one file per helper. `lib/slash.ts` holds all slash-command
parsing; `lib/catalog.ts` holds everything catalog-related;
`lib/events.ts` holds all event contracts. Don't create
`lib/format-sources.ts`.

### 4.4 Test pure helpers in `lib/`; skip trivial ones

`*.test.ts` alongside the module. bun:test + happy-dom. Non-trivial
pure logic needs tests (merge/dedup, URL matching, pricing math).
Helpers like `formatSources(["a","b"]) → "a+b"` are arguably trivial
but we added tests anyway because they anchor the contract.

---

## Section 5 — Lit conventions

### 5.1 `classMap` when there are ≥2 conditional classes

```ts
// ✅
class=${classMap({ selected: isSelected, dimmed: isDimmed })}

// Single condition — inline ternary is fine:
class=${isActive ? "active" : ""}
```

### 5.2 `repeat(items, keyFn, template)` for growing/reorderable lists

Turns, commits list, graph rows, per-commit files, toasts — all use
`repeat` with a keyFn. Static short lists (status pills, settings
tabs) use `.map`.

### 5.3 NOT adopted: `when`, `choose`, `guard`, `cache`

Don't add these unless there's a concrete performance or readability
pain point. Ternaries + `nothing` cover 95% of conditional rendering.

### 5.4 Empty-branch rendering: `: nothing`, never `: null` or `: ""`

```ts
${condition ? html`<span>...</span>` : nothing}
```

### 5.5 Mutable state wrapped in immutable shells for change detection

Don't mutate `TreeNode` fields in place and call `this.requestUpdate()`.
Copy-on-write:

```ts
// ❌
node.expanded = true;
this.requestUpdate();

// ✅
this.tree = updateNode(this.tree, path, { expanded: true });
```

`this.requestUpdate()` in a mutation handler is a code smell — it
usually means a `@state` property is being mutated in a way Lit
can't detect.

---

## Section 6 — Git + commits

### 6.1 Commit message format

- Subject line: `type(scope): terse description` — under 70 chars,
  imperative mood.
- Body (if needed): `-` bullets, one line each. No prose paragraphs.
  No section headers. No "What changed:" blocks.
- No references to session scaffolding ("phase A", "sweep 3",
  "part 1/3"). The log is for the change, not the process.

See `feedback_commit_message_style.md` in auto-memory for the full
rule + rationale.

### 6.2 Bundle cohesive work into one commit

For refactors that touch multiple files as one logical change (e.g.
"centralize event contracts"), one commit is preferred over five
tiny ones. Logical unit = commit unit.

### 6.3 Verification before commit

Every commit runs:
- `go test ./...` (or at minimum the packages you touched)
- `go vet ./...`
- `cd web && bun run check` (tsc)
- `cd web && bun run lint` (oxlint)
- `cd web && bun run test` (bun:test)

If any of these fail, fix before committing. `--no-verify` is banned.

---

## Section 7 — Safety invariants (remote model config)

The April 2026 "remote config should never do anything unexpected"
work established these invariants. Preserve them when adding new
features.

### 7.1 Only *callable* providers appear in model pickers

`isProviderAvailable(provider, ctx)` is the predicate. Any UI that
lets the user pick a model filters through it. Adding a new picker
means routing it through the same predicate; do not bypass to show
"all catalog" without an explicit discovery-mode reason (connection
wizard is the one legitimate exception).

### 7.2 Pre-send confirmation gates the first remote-paid call

`chat-view.send()` routes through `pendingSend` consent for
non-local routes. Consent is cached per (model, base_url, profile)
and invalidates on any change. If you add a new remote-paid
execution path, route it through the same gate.

### 7.3 Session cost cap prompts every over-cap turn

`GITCHAT_SESSION_MAX_COST_USD` is enforced by `chat-view`'s
`sessionCostUsd` tracker. Over-cap consent is *not* cached — every
over-cap turn re-prompts. Don't add a "remember for session" toggle
on this unless the user explicitly asks.

### 7.4 API keys never travel on unintended routes

The `maybeWarnKeyReuse` check fires when `LLM_BASE_URL` changes
hosts while `LLM_API_KEY` is still set. If you add a new write path
for either key, route it through the same check.

---

## Section 8 — Testing

### 8.1 Test counts (current — update when they drift)

- Go: 9 test packages, see `go test ./...` for current counts
- Frontend unit: 110 across 4 files (catalog, routing, slash, events)
- Playwright e2e: 34 across 5 files (combobox, composer, features,
  layout, mobile)

### 8.2 What to test

- Pure helpers with non-trivial logic (merge/dedup, URL normalization,
  pricing math).
- Backend critical paths (auth session lifecycle, tool dispatch,
  config encryption round-trip).
- User-facing flows (e2e): provider selection, model picker
  filtering, consent card behavior, overlay discipline.

### 8.3 What NOT to test

- Single-line formatters that are already named well (`fmtBytes`).
- Proto round-tripping (generated code).
- Lit render output directly — test behavior (what the user
  sees/interacts with) not HTML structure.

---

## Section 9 — When in doubt

1. **Read this file.** Most drift is "I forgot we had a rule about
   that."
2. **Grep for an existing pattern.** If you're adding a toast, grep
   `this.toast(` to see how existing panels format messages.
3. **If you still want to do something different**, leave a comment
   explaining why. A two-line "// Deliberate: X" is the difference
   between an exception and debt.
4. **If the rule itself is wrong for enough cases**, update this doc
   in the same commit that introduces the new pattern. Don't let
   practice drift silently from docs.
