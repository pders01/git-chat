import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import type { ChangedFile } from "../gen/gitchat/v1/repo_pb.js";

let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

function statusLabel(status: string): string {
  switch (status) {
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    default: return "M";
  }
}

function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

@customElement("gc-compare-view")
export class GcCompareView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) baseRef = "";
  @property({ type: String }) headRef = "";

  @state() private files: ChangedFile[] = [];
  @state() private totalAdditions = 0;
  @state() private totalDeletions = 0;
  @state() private selectedFile = "";
  @state() private diffHtml = "";
  @state() private diffLoading = false;
  @state() private diffError = "";
  @state() private compareLoading = false;
  private fullDiffHtml = "";
  private compareGeneration = 0;
  private lastCompareKey = "";

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId && this.baseRef && this.headRef) void this.compare();
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
    this.compareLoading = true;
    this.files = [];
    this.selectedFile = "";
    this.diffHtml = "";
    this.fullDiffHtml = "";
    this.diffError = "";
    this.totalAdditions = 0;
    this.totalDeletions = 0;

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
      this.files = cmp.files;
      this.totalAdditions = cmp.totalAdditions;
      this.totalDeletions = cmp.totalDeletions;

      if (diff.empty) {
        this.diffHtml = "";
        this.fullDiffHtml = "";
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(diff.unifiedDiff, "diff");
        if (gen !== this.compareGeneration) return;
        this.diffHtml = highlighted;
        this.fullDiffHtml = highlighted;
      }
    } catch (e) {
      if (gen !== this.compareGeneration) return;
      this.lastCompareKey = "";
      this.diffError = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.compareGeneration) this.compareLoading = false;
    }
  }

  private async selectFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;
    this.diffError = "";

    if (path === "") {
      this.diffHtml = this.fullDiffHtml;
      this.diffLoading = false;
      return;
    }

    const gen = this.compareGeneration;
    this.diffHtml = "";
    this.diffLoading = true;

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        fromRef: this.baseRef,
        toRef: this.headRef,
        path,
      });
      if (gen !== this.compareGeneration || this.selectedFile !== path) return;
      if (resp.empty) {
        this.diffHtml = "";
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(resp.unifiedDiff, "diff");
        if (gen !== this.compareGeneration || this.selectedFile !== path) return;
        this.diffHtml = highlighted;
      }
    } catch (e) {
      if (gen !== this.compareGeneration || this.selectedFile !== path) return;
      this.diffError = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.compareGeneration && this.selectedFile === path) this.diffLoading = false;
    }
  }

  private openInBrowse(path: string) {
    this.dispatchEvent(
      new CustomEvent("gc:open-file", { bubbles: true, composed: true, detail: { path } }),
    );
  }

  private selectedFileEntry(): ChangedFile | undefined {
    return this.files.find((f) => f.path === this.selectedFile);
  }

  override render() {
    return html`
      <div class="compare-layout">
        <!-- Left: file list -->
        <aside class="file-sidebar">
          ${this.compareLoading
            ? html`<div class="hint">comparing…</div>`
            : this.files.length === 0 && !this.diffError
              ? html`<div class="hint">no differences</div>`
              : html`
                  <div class="file-list-header">
                    <span>files</span>
                    <span class="file-count">${this.files.length}</span>
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
                          <span class="adds">+${this.totalAdditions}</span>
                          <span class="dels">-${this.totalDeletions}</span>
                        </span>
                      </button>
                    </li>
                    ${this.files.map((f) => html`
                      <li>
                        <button
                          class="file-entry ${this.selectedFile === f.path ? "selected" : ""}"
                          @click=${(e: MouseEvent) => { if (e.metaKey || e.ctrlKey) { this.openInBrowse(f.path); } else { this.selectFile(f.path); } }}
                          title="${f.path} (⌘+click to open in browse)"
                        >
                          <span class="file-status ${f.status}">${statusLabel(f.status)}</span>
                          <span class="file-path">${fileName(f.path)}</span>
                          <span class="file-stats">
                            <span class="adds">+${f.additions}</span>
                            <span class="dels">-${f.deletions}</span>
                          </span>
                        </button>
                      </li>
                    `)}
                  </ul>`}
        </aside>

        <!-- Right: diff pane -->
        <section class="diff-pane">
          <div class="diff-header">
            ${this.selectedFile
              ? html`
                  <span class="file-status ${this.selectedFileEntry()?.status ?? ""}">${statusLabel(this.selectedFileEntry()?.status ?? "")}</span>
                  <span class="diff-filepath">${this.selectedFile}</span>
                  <span class="diff-spacer"></span>
                  ${this.selectedFileEntry()
                    ? html`<span class="diff-stats">
                        <span class="adds">+${this.selectedFileEntry()!.additions}</span>
                        <span class="dels">-${this.selectedFileEntry()!.deletions}</span>
                      </span>`
                    : nothing}`
              : html`
                  <span class="diff-label">diff</span>
                  <span class="diff-spacer"></span>
                  ${this.files.length
                    ? html`<span class="diff-stats">
                        <span class="file-count">${this.files.length} file${this.files.length > 1 ? "s" : ""}</span>
                        <span class="adds">+${this.totalAdditions}</span>
                        <span class="dels">-${this.totalDeletions}</span>
                      </span>`
                    : nothing}`}
          </div>
          <div class="diff-body">
            ${this.compareLoading || this.diffLoading
              ? html`<div class="diff-loading">loading diff…</div>`
              : this.diffError
                ? html`<p class="diff-err">${this.diffError}</p>`
                : this.diffHtml
                  ? html`<div class="diff-content">${unsafeHTML(this.diffHtml)}</div>`
                  : html`<div class="diff-empty">${this.baseRef === this.headRef ? "same branch selected" : "no differences"}</div>`}
          </div>
        </section>
      </div>
    `;
  }

  static override styles = css`
    :host([hidden]) { display: none !important; }
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
    .file-entry:hover { background: var(--surface-2); }
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
    .file-status.modified { color: var(--accent-user); }
    .file-status.added { color: var(--accent-assistant); }
    .file-status.deleted { color: var(--danger); }
    .file-status.renamed { color: var(--warning, #e0a040); }
    .file-status.all { color: var(--text); opacity: 0.5; }
    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-stats {
      flex-shrink: 0;
      display: flex;
      gap: var(--space-1);
      font-size: 0.6rem;
      opacity: 0.7;
    }
    .file-count { opacity: 0.5; }
    .adds { color: var(--accent-assistant); }
    .dels { color: var(--danger); margin-left: var(--space-1); }

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
    .diff-spacer { flex: 1; }
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
      .file-entry { transition: none; }
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
