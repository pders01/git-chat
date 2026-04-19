import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import { onChange as onSettingsChange } from "../lib/settings.js";
import type { SideFilesState } from "../lib/diff-types.js";
import { splitDiffHtml, highlightWordDiffs, addLineNumbers } from "../lib/diff-html.js";
import "./loading-indicator.js";
import "./three-pane-view.js";

// Lazy-import the highlighter so the initial bundle stays lean; the
// highlighter pulls in Shiki which is 1MB+ uncompressed.
let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

// DiffPaneState models the right-hand diff area. Exported so parents
// wanting to introspect the pane's state (e.g., conditional action-bar
// rendering) share the same discriminated union.
export type DiffPaneState =
  | { phase: "empty" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rawDiff: string; diffHtml: string; parentSha: string };

// gc-diff-pane owns the right-hand diff area shared by commit-log and
// compare-view. Parents pass identity (fromRef/toRef/path) and layout
// toggles (splitView/threePane/labels); the pane handles its own RPCs,
// caching, word-diff highlighting, and placeholder banners. Events fire
// upward for file-list discovery and toggle sync.
@customElement("gc-diff-pane")
export class GcDiffPane extends LitElement {
  @property({ type: String }) repoId = "";
  // Empty fromRef means "parent of toRef" — matches the GetDiff RPC
  // default and lets commit-log pass just the commit SHA while
  // compare-view passes baseRef/headRef explicitly.
  @property({ type: String }) fromRef = "";
  @property({ type: String }) toRef = "";
  // Empty path means "whole-commit diff": the pane fetches the
  // full unified diff and fires gc:diff-files-loaded with the
  // changed-file list. Non-empty path fetches just that file.
  @property({ type: String }) path = "";
  @property({ type: Boolean }) splitView = false;
  @property({ type: Boolean }) threePane = false;
  // 3-pane view labels. Parents that know human-readable names
  // (branch refs for compare-view, "before/after" with short SHAs for
  // commit-log) pass them; otherwise we fall back to the resolved
  // SHAs from the GetDiff response.
  @property({ type: String }) leftLabel = "";
  @property({ type: String }) rightLabel = "";
  // When true, the pane's second getDiff (after initial fast list)
  // enables rename detection and re-fires gc:diff-files-loaded.
  @property({ type: Boolean }) detectRenames = false;
  // Pre-fetched unified diff to render directly. When non-empty the
  // pane skips its own GetDiff RPC and goes straight to highlight +
  // word-diff + render. Exists so consumers whose diffs come from a
  // different RPC (changes-view → GetWorkingTreeDiff) or from no RPC
  // at all (paste-a-patch, KB previews) can reuse the rendering path
  // without the pane having to know about every diff source. While
  // rawDiff is active, repoId / fromRef / toRef are ignored and 3-pane
  // mode is unavailable (it would need before/after file contents the
  // pane isn't fetching).
  @property({ type: String }) rawDiff = "";

  @state() private diff: DiffPaneState = { phase: "empty" };
  @state() private sideFiles: SideFilesState = { phase: "idle" };
  // Cached whole-commit diff so switching back to path="" after a
  // single-file view is instant. Plain cache, not @state.
  private fullDiff: { rawDiff: string; diffHtml: string; parentSha: string } | null = null;
  private generation = 0;
  private unsubSettings: (() => void) | null = null;
  private renameAbort: AbortController | null = null;
  // Remember the last identity we loaded against so property churn
  // that doesn't change the tuple (e.g. splitView toggling) doesn't
  // re-fire the fetch.
  private lastKey = "";

  override connectedCallback() {
    super.connectedCallback();
    this.unsubSettings = onSettingsChange(() => void this.rehighlight());
    if (this.rawDiff) {
      void this.loadFromRaw();
    } else {
      this.maybeReload();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.renameAbort?.abort();
    this.renameAbort = null;
  }

  override updated(changed: Map<string, unknown>) {
    // rawDiff takes precedence — when a consumer supplies a
    // pre-fetched diff, the pane becomes a pure renderer and stops
    // consulting refs / path entirely. Guard against the first-render
    // entry where Lit lists every declared property in `changed` with
    // previous value `undefined`; whether rawDiff is "" or "some patch"
    // on first render, connectedCallback has already dispatched the
    // right loader, so running it again here just bumps `generation`
    // and cancels the in-flight fetch. Only act when there's a real
    // transition — i.e. a defined previous value that differs from
    // the current one.
    if (changed.has("rawDiff") && changed.get("rawDiff") !== undefined) {
      void this.loadFromRaw();
      return;
    }
    if (this.rawDiff) return; // stay in raw-diff mode as long as prop holds
    if (changed.has("repoId") || changed.has("fromRef") || changed.has("toRef")) {
      this.maybeReload();
    } else if (changed.has("path")) {
      void this.loadForPath();
    }
    if (changed.has("threePane") && this.threePane && this.path) {
      if (this.sideFiles.phase === "idle") void this.loadSideFiles(this.path);
    }
    if (changed.has("detectRenames") && this.detectRenames) {
      void this.detectRenamesBackground();
    }
  }

  /** Render a consumer-supplied unified diff. No RPC, no whole-commit
   * fallback: we highlight and render what we got. Empty input
   * resolves to the empty state so the caller can clear the pane by
   * setting rawDiff back to "". */
  private async loadFromRaw() {
    const gen = ++this.generation;
    this.fullDiff = null;
    this.sideFiles = { phase: "idle" };
    if (!this.rawDiff) {
      this.diff = { phase: "empty" };
      return;
    }
    this.diff = { phase: "loading" };
    try {
      const { highlight } = await loadHighlight();
      let highlighted = await highlight(this.rawDiff, "diff");
      if (gen !== this.generation) return;
      highlighted = highlightWordDiffs(highlighted);
      highlighted = addLineNumbers(highlighted);
      this.diff = {
        phase: "ready",
        rawDiff: this.rawDiff,
        diffHtml: highlighted,
        parentSha: "",
      };
    } catch (e) {
      if (gen !== this.generation) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private maybeReload() {
    const key = `${this.repoId}|${this.fromRef}|${this.toRef}`;
    if (key === this.lastKey || !this.repoId || !this.toRef) return;
    this.lastKey = key;
    this.fullDiff = null;
    void this.loadWhole();
  }

  private async loadWhole() {
    const gen = ++this.generation;
    this.diff = { phase: "loading" };
    this.sideFiles = { phase: "idle" };
    this.fullDiff = null;
    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        fromRef: this.fromRef,
        toRef: this.toRef,
      });
      if (gen !== this.generation) return;
      const parentSha = resp.fromCommit || "";
      this.dispatchEvent(
        new CustomEvent("gc:diff-files-loaded", {
          bubbles: true,
          composed: true,
          detail: { files: resp.files, parentSha, toCommit: resp.toCommit },
        }),
      );
      if (resp.empty) {
        const ready = { phase: "ready" as const, rawDiff: "", diffHtml: "", parentSha };
        this.diff = ready;
        this.fullDiff = { rawDiff: "", diffHtml: "", parentSha };
      } else {
        const { highlight } = await loadHighlight();
        let highlighted = await highlight(resp.unifiedDiff, "diff");
        if (gen !== this.generation) return;
        highlighted = highlightWordDiffs(highlighted);
        highlighted = addLineNumbers(highlighted);
        this.diff = {
          phase: "ready",
          rawDiff: resp.unifiedDiff,
          diffHtml: highlighted,
          parentSha,
        };
        this.fullDiff = { rawDiff: resp.unifiedDiff, diffHtml: highlighted, parentSha };
      }
      // If the path prop is non-empty (parent pre-selected a file, e.g.
      // deep-link), kick that load after the initial whole-commit fetch
      // has established parentSha for 3-pane side-file loads.
      if (this.path) void this.loadForPath();
    } catch (e) {
      if (gen !== this.generation) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async loadForPath() {
    if (this.path === "") {
      if (this.fullDiff) {
        this.diff = { phase: "ready", ...this.fullDiff };
      } else {
        this.diff = { phase: "empty" };
      }
      this.sideFiles = { phase: "idle" };
      return;
    }
    const gen = ++this.generation;
    this.diff = { phase: "loading" };
    this.sideFiles = { phase: "idle" };
    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        fromRef: this.fromRef,
        toRef: this.toRef,
        path: this.path,
      });
      if (gen !== this.generation) return;
      const parentSha = resp.fromCommit || this.fullDiff?.parentSha || "";
      if (resp.empty) {
        this.diff = { phase: "ready", rawDiff: "", diffHtml: "", parentSha };
      } else {
        const { highlight } = await loadHighlight();
        let highlighted = await highlight(resp.unifiedDiff, "diff");
        if (gen !== this.generation) return;
        highlighted = highlightWordDiffs(highlighted);
        highlighted = addLineNumbers(highlighted);
        this.diff = {
          phase: "ready",
          rawDiff: resp.unifiedDiff,
          diffHtml: highlighted,
          parentSha,
        };
      }
    } catch (e) {
      if (gen !== this.generation) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }
    if (this.threePane) void this.loadSideFiles(this.path);
  }

  private async loadSideFiles(path: string) {
    if (!path || this.diff.phase !== "ready") return;
    const parentSha = this.diff.parentSha || this.fromRef;
    this.sideFiles = { phase: "loading" };
    const gen = this.generation;
    const [leftResp, rightResp] = await Promise.all([
      parentSha
        ? repoClient
            .getFile({ repoId: this.repoId, ref: parentSha, path, maxBytes: BigInt(512 * 1024) })
            .catch(() => null)
        : Promise.resolve(null),
      repoClient
        .getFile({ repoId: this.repoId, ref: this.toRef, path, maxBytes: BigInt(512 * 1024) })
        .catch(() => null),
    ]);
    if (gen !== this.generation || this.path !== path) return;
    const td = new TextDecoder();
    this.sideFiles = {
      phase: "ready",
      leftText: leftResp && !leftResp.isBinary ? td.decode(leftResp.content) : "",
      rightText: rightResp && !rightResp.isBinary ? td.decode(rightResp.content) : "",
      language: rightResp?.language || leftResp?.language || "plaintext",
    };
  }

  // Progressive enhancement: after the fast list lands, parent can flip
  // detectRenames=true to ask the server for rename-coalesced results.
  // We re-fire gc:diff-files-loaded so the parent's file-list sidebar
  // updates in place. Non-rename rows stay identical so the reshuffle
  // is bounded to actual renames.
  private async detectRenamesBackground() {
    this.renameAbort?.abort();
    const ac = new AbortController();
    this.renameAbort = ac;
    const gen = this.generation;
    try {
      const resp = await repoClient.getDiff(
        { repoId: this.repoId, fromRef: this.fromRef, toRef: this.toRef, detectRenames: true },
        { signal: ac.signal },
      );
      if (gen !== this.generation) return;
      this.dispatchEvent(
        new CustomEvent("gc:diff-files-loaded", {
          bubbles: true,
          composed: true,
          detail: { files: resp.files, parentSha: resp.fromCommit || "", toCommit: resp.toCommit },
        }),
      );
    } catch {
      // Silent — aborted or failed; initial list stays on screen.
    } finally {
      if (this.renameAbort === ac) this.renameAbort = null;
    }
  }

  private async rehighlight() {
    if (this.diff.phase !== "ready" || !this.diff.rawDiff) return;
    const raw = this.diff.rawDiff;
    const { highlight } = await loadHighlight();
    let highlighted = await highlight(raw, "diff");
    if (this.diff.phase !== "ready" || this.diff.rawDiff !== raw) return;
    highlighted = highlightWordDiffs(highlighted);
    highlighted = addLineNumbers(highlighted);
    this.diff = { ...this.diff, diffHtml: highlighted };
    if (this.path === "" && this.fullDiff) {
      this.fullDiff = { ...this.fullDiff, diffHtml: highlighted };
    }
  }

  override render() {
    switch (this.diff.phase) {
      case "empty":
        return nothing;
      case "loading":
        return html`<gc-loading-banner
          heading="loading diff…"
          detail="fetching changes from git; large diffs can take a second"
        ></gc-loading-banner>`;
      case "error":
        return html`<p class="diff-error">${this.diff.message}</p>`;
      case "ready": {
        if (this.threePane && this.path) return this.renderThreePane(this.diff);
        if (!this.diff.diffHtml) return html`<div class="diff-empty">no changes</div>`;
        if (this.path && this.diff.rawDiff.includes("@@ placeholder-diff @@")) {
          return this.renderPlaceholderDiff(this.diff.rawDiff);
        }
        return this.splitView
          ? this.renderSplitDiff()
          : html`<div class="diff-content">${unsafeHTML(this.diff.diffHtml)}</div>`;
      }
    }
  }

  private renderThreePane(ready: DiffPaneState & { phase: "ready" }) {
    switch (this.sideFiles.phase) {
      case "idle":
      case "loading":
        return html`<gc-loading-banner heading="loading 3-pane…"></gc-loading-banner>`;
      case "ready": {
        const left =
          this.leftLabel ||
          (ready.parentSha ? ready.parentSha.slice(0, 12) + " (before)" : "(no parent)");
        const right = this.rightLabel || this.toRef.slice(0, 12) + " (after)";
        return html`<gc-three-pane-view
          .leftText=${this.sideFiles.leftText}
          .rightText=${this.sideFiles.rightText}
          .rawDiff=${ready.rawDiff}
          .language=${this.sideFiles.language}
          .leftLabel=${left}
          .rightLabel=${right}
        ></gc-three-pane-view>`;
      }
    }
  }

  private renderSplitDiff() {
    const diffHtml = this.diff.phase === "ready" ? this.diff.diffHtml : "";
    const pairs = splitDiffHtml(diffHtml);
    return html`
      <div class="diff-content split-diff">
        <table class="split-table">
          <colgroup>
            <col class="split-col" />
            <col class="split-col" />
          </colgroup>
          <tbody>
            ${pairs.map(
              ({ left, right }) => html`
                <tr>
                  <td class="split-cell del-cell">${left ? unsafeHTML(left) : nothing}</td>
                  <td class="split-cell add-cell">${right ? unsafeHTML(right) : nothing}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  // Parse the backend's placeholder-diff sentinel into a user banner.
  // Triggered when the blob on either side crossed GITCHAT_MAX_DIFF_BYTES
  // or is binary — both cases where a unified patch isn't meaningful.
  private renderPlaceholderDiff(raw: string) {
    const parse = (line: string) => {
      const m = line.match(/kind="([^"]*)" size=(\d+)/);
      return m ? { kind: m[1], size: Number(m[2]) } : { kind: "unknown", size: 0 };
    };
    const lines = raw.split("\n");
    const from = parse(lines.find((l) => l.startsWith("# from:")) ?? "");
    const to = parse(lines.find((l) => l.startsWith("# to:")) ?? "");
    const reason =
      from.kind === "binary" || to.kind === "binary"
        ? "binary file"
        : from.kind === "too-large" || to.kind === "too-large"
          ? "file too large for inline diff"
          : "inline diff unavailable";
    const fmt = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
    return html`<div class="diff-placeholder">
      <div class="diff-placeholder-title">${reason}</div>
      <div class="diff-placeholder-sizes">before: ${fmt(from.size)} · after: ${fmt(to.size)}</div>
      <div class="diff-placeholder-hint">
        raise <code>GITCHAT_MAX_DIFF_BYTES</code> on the server to inline, or switch to 3-pane for
        side-by-side file bodies.
      </div>
    </div>`;
  }

  static override styles = css`
    :host {
      display: block;
      min-height: 0;
      min-width: 0;
      overflow: auto;
    }
    .diff-error {
      color: var(--danger);
      padding: var(--space-4);
    }
    .diff-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      opacity: 0.4;
      font-size: var(--text-sm);
      font-style: italic;
    }
    .diff-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: var(--space-6);
      text-align: center;
      height: 100%;
      font-size: var(--text-sm);
    }
    .diff-placeholder-title {
      font-weight: 600;
      opacity: 0.75;
    }
    .diff-placeholder-sizes {
      opacity: 0.55;
      font-size: var(--text-xs);
      letter-spacing: 0.02em;
    }
    .diff-placeholder-hint {
      opacity: 0.45;
      font-size: var(--text-xs);
      max-width: 52ch;
    }
    .diff-placeholder-hint code {
      font-family: var(--font-mono, ui-monospace, monospace);
      background: var(--surface-3);
      padding: 1px 4px;
      border-radius: var(--radius-sm);
    }
    .diff-content {
      font-size: var(--text-xs);
      line-height: 1.55;
      overflow-x: auto;
    }
    .diff-content pre {
      margin: 0;
      padding: var(--space-3) var(--space-5);
    }
    .diff-content .shiki {
      background: transparent !important;
    }
    .diff-content mark.word-del {
      background: rgba(248, 81, 73, 0.4);
      color: inherit;
      border-radius: 2px;
    }
    .diff-content mark.word-add {
      background: rgba(63, 185, 80, 0.4);
      color: inherit;
      border-radius: 2px;
    }
    /* Line-number gutters. Digits render via ::before + attr(data-n)
       so the spans stay empty at the DOM/textContent level — lets
       splitDiffHtml and highlightWordDiffs keep classifying by the
       diff prefix character ('-'/'+'/' ') that comes next. */
    .ln-old,
    .ln-new {
      display: inline-block;
      min-width: 3ch;
      padding-right: var(--space-2);
      text-align: right;
      opacity: 0.35;
      user-select: none;
      -webkit-user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .ln-old::before {
      content: attr(data-n);
    }
    .ln-new::before {
      content: attr(data-n);
    }
    /* Split view: each side only shows its own side's number. The
       opposite side's empty span still sits in place so the total
       gutter width stays consistent across rows. */
    .split-cell.del-cell .ln-new,
    .split-cell.add-cell .ln-old {
      visibility: hidden;
    }
    .split-diff {
      width: 100%;
    }
    .split-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .split-col {
      width: 50%;
    }
    .split-cell {
      vertical-align: top;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: var(--text-xs);
      line-height: 1.55;
      padding: 2px var(--space-3);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .del-cell {
      background: rgba(248, 81, 73, 0.08);
      border-right: 1px solid var(--border-default);
    }
    .add-cell {
      background: rgba(63, 185, 80, 0.08);
    }
  `;
}

// Pure diff-HTML helpers live in lib/diff-html.ts so the tests can
// reach them without pulling in Lit + the component render pipeline.
// Re-exported here for any existing external consumers.
export { splitDiffHtml, highlightWordDiffs } from "../lib/diff-html.js";

declare global {
  interface HTMLElementTagNameMap {
    "gc-diff-pane": GcDiffPane;
  }
  // Event payloads are declared centrally in web/src/lib/events.ts.
}
