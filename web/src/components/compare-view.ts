import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import type { ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import { onChange as onSettingsChange } from "../lib/settings.js";
import "./loading-indicator.js";
import "./three-pane-view.js";

let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

function statusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

// CompareState models the overall comparison (file list + total stats).
// Before the diff is fetched the view sits at `loading`; once the server
// answers we land in `ready` even if the list is empty (the UI then
// shows "no differences" instead of an error).
type CompareState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      files: ChangedFile[];
      totalAdditions: number;
      totalDeletions: number;
    };

// DiffPaneState models the right-hand diff area. Same shape as in
// commit-log — single union lets render collapse to one switch.
type DiffPaneState =
  | { phase: "empty" } // no file selected and no whole-compare diff yet
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; rawDiff: string; diffHtml: string };

// SideFilesState: before/after file bodies for the 3-pane view. Mirrors
// the commit-log definition.
type SideFilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; leftText: string; rightText: string; language: string };

@customElement("gc-compare-view")
export class GcCompareView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) baseRef = "";
  @property({ type: String }) headRef = "";

  @state() private compareState: CompareState = { phase: "loading" };
  @state() private selectedFile = "";
  @state() private diff: DiffPaneState = { phase: "empty" };
  @state() private sideFiles: SideFilesState = { phase: "idle" };
  // Three-pane (before | diff | after) mode. Toggle persists for the
  // lifetime of the component; when on, selectFile also fetches the
  // left/right full-file contents for the side panes.
  @state() private threePane = false;
  // Cached whole-compare diff so switching back to "all files" after
  // looking at a single file is instant. Plain struct, not @state.
  private fullDiff: { rawDiff: string; diffHtml: string } | null = null;
  private compareGeneration = 0;
  private lastCompareKey = "";
  private unsubSettings: (() => void) | null = null;
  // Abort signal for the progressive-enhancement rename call. Rapid
  // navigation cancels the in-flight server request so the expensive
  // similarity-matrix work doesn't pile up after the user moved on.
  private renameAbort: AbortController | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubSettings = onSettingsChange(() => void this.rehighlight());
    if (this.repoId && this.baseRef && this.headRef) void this.compare();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.renameAbort?.abort();
    this.renameAbort = null;
  }

  private async rehighlight() {
    if (this.diff.phase !== "ready" || !this.diff.rawDiff) return;
    const raw = this.diff.rawDiff;
    const { highlight } = await loadHighlight();
    const highlighted = await highlight(raw, "diff");
    if (this.diff.phase !== "ready" || this.diff.rawDiff !== raw) return;
    this.diff = { ...this.diff, diffHtml: highlighted };
    if (this.selectedFile === "" && this.fullDiff) {
      this.fullDiff = { ...this.fullDiff, diffHtml: highlighted };
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") || changed.has("baseRef") || changed.has("headRef")) {
      const key = `${this.repoId}:${this.baseRef}:${this.headRef}`;
      if (key !== this.lastCompareKey && this.repoId && this.baseRef && this.headRef) {
        this.lastCompareKey = key;
        void this.compare();
      }
    }
  }

  private async compare() {
    if (!this.baseRef || !this.headRef) return;
    const gen = ++this.compareGeneration;
    // Cancel any in-flight rename request from the previous compare —
    // its result would be dropped anyway (stale-guard), but we'd like
    // the server to stop doing the work, not just the client to ignore
    // the answer.
    this.renameAbort?.abort();
    this.renameAbort = null;
    this.selectedFile = "";
    this.compareState = { phase: "loading" };
    this.diff = { phase: "loading" };
    this.sideFiles = { phase: "idle" };
    this.fullDiff = null;
    this.threePane = false;

    try {
      const [cmp, diff] = await Promise.all([
        repoClient.compareBranches({
          repoId: this.repoId,
          baseRef: this.baseRef,
          headRef: this.headRef,
        }),
        repoClient.getDiff({
          repoId: this.repoId,
          fromRef: this.baseRef,
          toRef: this.headRef,
        }),
      ]);
      if (gen !== this.compareGeneration) return;
      this.compareState = {
        phase: "ready",
        files: cmp.files,
        totalAdditions: cmp.totalAdditions,
        totalDeletions: cmp.totalDeletions,
      };

      if (diff.empty) {
        this.diff = { phase: "ready", rawDiff: "", diffHtml: "" };
        this.fullDiff = { rawDiff: "", diffHtml: "" };
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(diff.unifiedDiff, "diff");
        if (gen !== this.compareGeneration) return;
        this.diff = { phase: "ready", rawDiff: diff.unifiedDiff, diffHtml: highlighted };
        this.fullDiff = { rawDiff: diff.unifiedDiff, diffHtml: highlighted };
      }
    } catch (e) {
      if (gen !== this.compareGeneration) return;
      this.lastCompareKey = "";
      const message = e instanceof Error ? e.message : String(e);
      this.compareState = { phase: "error", message };
      this.diff = { phase: "error", message };
    }

    // Progressive enhancement: the initial fetch skipped rename detection
    // (expensive on wide diffs). If the file list contains both adds and
    // deletes, renames are plausible — fire a second request that opts
    // into detection and swap the list in when it lands. Non-rename rows
    // stay identical, so the reshuffle is bounded to actual renames.
    const files = this.compareState.phase === "ready" ? this.compareState.files : [];
    if (files.some((f) => f.status === "added") && files.some((f) => f.status === "deleted")) {
      void this.detectRenamesBackground(gen);
    }
  }

  private async detectRenamesBackground(gen: number) {
    const ac = new AbortController();
    this.renameAbort = ac;
    try {
      const cmp = await repoClient.compareBranches(
        {
          repoId: this.repoId,
          baseRef: this.baseRef,
          headRef: this.headRef,
          detectRenames: true,
        },
        { signal: ac.signal },
      );
      if (gen !== this.compareGeneration || this.compareState.phase !== "ready") return;
      this.compareState = {
        phase: "ready",
        files: cmp.files,
        totalAdditions: cmp.totalAdditions,
        totalDeletions: cmp.totalDeletions,
      };
    } catch {
      // Silent — aborted or failed; the initial (fast) list is on screen.
    } finally {
      if (this.renameAbort === ac) this.renameAbort = null;
    }
  }

  private async selectFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;

    if (path === "") {
      // Restore cached whole-compare diff.
      if (this.fullDiff) {
        this.diff = { phase: "ready", ...this.fullDiff };
      } else {
        this.diff = { phase: "empty" };
      }
      this.sideFiles = { phase: "idle" };
      return;
    }

    const gen = this.compareGeneration;
    this.diff = { phase: "loading" };
    this.sideFiles = { phase: "idle" };

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        fromRef: this.baseRef,
        toRef: this.headRef,
        path,
      });
      if (gen !== this.compareGeneration || this.selectedFile !== path) return;
      if (resp.empty) {
        this.diff = { phase: "ready", rawDiff: "", diffHtml: "" };
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(resp.unifiedDiff, "diff");
        if (gen !== this.compareGeneration || this.selectedFile !== path) return;
        this.diff = { phase: "ready", rawDiff: resp.unifiedDiff, diffHtml: highlighted };
      }
    } catch (e) {
      if (gen !== this.compareGeneration || this.selectedFile !== path) return;
      this.diff = { phase: "error", message: e instanceof Error ? e.message : String(e) };
    }

    if (this.threePane) void this.loadSideFiles(path);
  }

  // Fetch the full old- and new-file contents for the three-pane view.
  // Errors on either side are non-fatal — the pane just shows "(empty)"
  // or "(not present)" for that side, which is meaningful for adds and
  // deletes.
  private async loadSideFiles(path: string) {
    if (!path) return;
    const gen = this.compareGeneration;
    this.sideFiles = { phase: "loading" };
    const [leftResp, rightResp] = await Promise.all([
      repoClient
        .getFile({
          repoId: this.repoId,
          ref: this.baseRef,
          path,
          maxBytes: BigInt(512 * 1024),
        })
        .catch(() => null),
      repoClient
        .getFile({
          repoId: this.repoId,
          ref: this.headRef,
          path,
          maxBytes: BigInt(512 * 1024),
        })
        .catch(() => null),
    ]);
    if (gen !== this.compareGeneration || this.selectedFile !== path) return;
    const td = new TextDecoder();
    this.sideFiles = {
      phase: "ready",
      leftText: leftResp && !leftResp.isBinary ? td.decode(leftResp.content) : "",
      rightText: rightResp && !rightResp.isBinary ? td.decode(rightResp.content) : "",
      language: rightResp?.language || leftResp?.language || "plaintext",
    };
  }

  private toggleThreePane() {
    this.threePane = !this.threePane;
    if (this.threePane && this.selectedFile && this.sideFiles.phase === "idle") {
      void this.loadSideFiles(this.selectedFile);
    }
  }

  private openInBrowse(path: string) {
    this.dispatchEvent(
      new CustomEvent("gc:open-file", { bubbles: true, composed: true, detail: { path } }),
    );
  }

  private selectedFileEntry(): ChangedFile | undefined {
    const files = this.compareState.phase === "ready" ? this.compareState.files : [];
    return files.find((f) => f.path === this.selectedFile);
  }

  private renderFileSidebar() {
    switch (this.compareState.phase) {
      case "loading":
        return html`<div class="hint">
          <gc-spinner></gc-spinner>
          comparing…
        </div>`;
      case "error":
        return html`<div class="hint">${this.compareState.message}</div>`;
      case "ready": {
        const { files, totalAdditions, totalDeletions } = this.compareState;
        if (files.length === 0) return html`<div class="hint">no differences</div>`;
        return html`
          <div class="file-list-header">
            <span>files</span>
            <span class="file-count">${files.length}</span>
          </div>
          <ul class="file-list" role="list">
            <li>
              <button
                class="file-entry ${this.selectedFile === "" ? "selected" : ""}"
                @click=${() => this.selectFile("")}
              >
                <span class="file-status all">∗</span>
                <span class="file-path">all files</span>
                <span class="file-stats">
                  <span class="adds">+${totalAdditions}</span>
                  <span class="dels">-${totalDeletions}</span>
                </span>
              </button>
            </li>
            ${files.map(
              (f) => html`
                <li>
                  <button
                    class="file-entry ${this.selectedFile === f.path ? "selected" : ""}"
                    @click=${(e: MouseEvent) => {
                      if (e.metaKey || e.ctrlKey) {
                        this.openInBrowse(f.path);
                      } else {
                        this.selectFile(f.path);
                      }
                    }}
                    title="${f.fromPath
                      ? `${f.fromPath} → ${f.path} (renamed)`
                      : f.path} (⌘+click to open in browse)"
                  >
                    <span class="file-status ${f.status}">${statusLabel(f.status)}</span>
                    <span class="file-path"
                      >${fileName(f.path)}${f.fromPath
                        ? html`<span class="rename-from">← ${fileName(f.fromPath)}</span>`
                        : nothing}</span
                    >
                    <span class="file-stats">
                      <span class="adds">+${f.additions}</span>
                      <span class="dels">-${f.deletions}</span>
                    </span>
                  </button>
                </li>
              `,
            )}
          </ul>
        `;
      }
    }
  }

  override render() {
    const files = this.compareState.phase === "ready" ? this.compareState.files : [];
    const totalAdditions =
      this.compareState.phase === "ready" ? this.compareState.totalAdditions : 0;
    const totalDeletions =
      this.compareState.phase === "ready" ? this.compareState.totalDeletions : 0;
    return html`
      <div class="compare-layout">
        <!-- Left: file list -->
        <aside class="file-sidebar">${this.renderFileSidebar()}</aside>

        <!-- Right: diff pane -->
        <section class="diff-pane">
          <div class="diff-header">
            ${this.selectedFile
              ? html` <span class="file-status ${this.selectedFileEntry()?.status ?? ""}"
                    >${statusLabel(this.selectedFileEntry()?.status ?? "")}</span
                  >
                  <span class="diff-filepath">${this.selectedFile}</span>
                  <span class="diff-spacer"></span>
                  ${this.selectedFileEntry()
                    ? html`<span class="diff-stats">
                        <span class="adds">+${this.selectedFileEntry()!.additions}</span>
                        <span class="dels">-${this.selectedFileEntry()!.deletions}</span>
                      </span>`
                    : nothing}`
              : html` <span class="diff-label">diff</span>
                  <span class="diff-spacer"></span>
                  ${files.length
                    ? html`<span class="diff-stats">
                        <span class="file-count"
                          >${files.length} file${files.length > 1 ? "s" : ""}</span
                        >
                        <span class="adds">+${totalAdditions}</span>
                        <span class="dels">-${totalDeletions}</span>
                      </span>`
                    : nothing}`}
            ${this.selectedFile
              ? html`<button
                  class="pane-toggle ${this.threePane ? "active" : ""}"
                  @click=${() => this.toggleThreePane()}
                  aria-pressed=${this.threePane ? "true" : "false"}
                  title="Toggle 3-pane view (before | diff | after)"
                >
                  3-pane
                </button>`
              : nothing}
          </div>
          <div class="diff-body">${this.renderDiffPane()}</div>
        </section>
      </div>
    `;
  }

  private renderDiffPane() {
    switch (this.diff.phase) {
      case "empty":
        return nothing;
      case "loading":
        return html`<gc-loading-banner
          heading="loading diff…"
          detail="fetching the changed-file patch from git; large ranges or big files can take a few seconds"
        ></gc-loading-banner>`;
      case "error":
        return html`<p class="diff-err">${this.diff.message}</p>`;
      case "ready": {
        if (this.threePane && this.selectedFile) return this.renderThreePane(this.diff);
        if (!this.diff.diffHtml) {
          return html`<div class="diff-empty">
            ${this.baseRef === this.headRef ? "same branch selected" : "no differences"}
          </div>`;
        }
        return html`<div class="diff-content">${unsafeHTML(this.diff.diffHtml)}</div>`;
      }
    }
  }

  private renderThreePane(ready: DiffPaneState & { phase: "ready" }) {
    switch (this.sideFiles.phase) {
      case "idle":
      case "loading":
        return html`<gc-loading-banner heading="loading 3-pane…"></gc-loading-banner>`;
      case "ready":
        return html`<gc-three-pane-view
          .leftText=${this.sideFiles.leftText}
          .rightText=${this.sideFiles.rightText}
          .rawDiff=${ready.rawDiff}
          .language=${this.sideFiles.language}
          .leftLabel=${this.baseRef}
          .rightLabel=${this.headRef}
        ></gc-three-pane-view>`;
    }
  }

  static override styles = css`
    :host([hidden]) {
      display: none !important;
    }
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: var(--text-base);
      color: var(--text);
      background: var(--surface-1);
    }
    .hint {
      padding: var(--space-4);
      opacity: 0.5;
      font-size: var(--text-sm);
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }

    /* ── Layout ──────────────────────────────────────────────── */
    .compare-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    /* ── Left: file sidebar ──────────────────────────────────── */
    .file-sidebar {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    /* ── File list ──────────────────────────────────────────── */
    .file-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-xs);
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      height: 28px;
      box-sizing: border-box;
    }
    .file-list {
      list-style: none;
      padding: 0;
      margin: 0;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .file-entry {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-1) var(--space-3);
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
      transition: background 0.08s ease;
    }
    .file-entry:hover {
      background: var(--surface-2);
    }
    .file-entry.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .file-entry:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: -2px;
    }
    .file-status {
      flex-shrink: 0;
      width: 1.2em;
      text-align: center;
      font-weight: 600;
      font-size: 0.65rem;
    }
    .file-status.modified {
      color: var(--accent-user);
    }
    .file-status.added {
      color: var(--accent-assistant);
    }
    .file-status.deleted {
      color: var(--danger);
    }
    .file-status.renamed {
      color: var(--warning, #e0a040);
    }
    .file-status.all {
      color: var(--text);
      opacity: 0.5;
    }
    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rename-from {
      margin-left: var(--space-2);
      font-size: 0.9em;
      opacity: 0.6;
    }
    .file-stats {
      flex-shrink: 0;
      display: flex;
      gap: var(--space-1);
      font-size: 0.6rem;
      opacity: 0.7;
    }
    .file-count {
      opacity: 0.5;
    }
    .adds {
      color: var(--accent-assistant);
    }
    .dels {
      color: var(--danger);
      margin-left: var(--space-1);
    }

    /* ── Right: diff pane ────────────────────────────────────── */
    .diff-pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    .diff-header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: 0 var(--space-4);
      height: 36px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--surface-4);
      background: var(--surface-1);
      flex-shrink: 0;
      font-size: var(--text-sm);
    }
    .diff-label {
      opacity: 0.4;
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .diff-filepath {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-xs);
    }
    .diff-spacer {
      flex: 1;
    }
    .diff-stats {
      display: flex;
      gap: var(--space-1);
      font-size: var(--text-xs);
      flex-shrink: 0;
    }
    .diff-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .diff-body > gc-three-pane-view {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .pane-toggle {
      margin-left: auto;
      padding: var(--space-1) var(--space-3);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .pane-toggle:hover {
      opacity: 0.9;
    }
    .pane-toggle.active {
      background: var(--surface-2);
    }
    .pane-toggle[disabled] {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .diff-loading {
      padding: var(--space-6);
      opacity: 0.5;
    }
    .diff-err {
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

    @media (prefers-reduced-motion: reduce) {
      .file-entry {
        transition: none;
      }
    }
    @media (max-width: 768px) {
      .compare-layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .file-sidebar {
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
        max-height: 40vh;
      }
    }
  `;
}
