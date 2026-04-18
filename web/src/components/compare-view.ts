import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import "./loading-indicator.js";
import "./diff-pane.js";

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

// CompareState models the file-list sidebar. Totals sum the per-file
// stats the pane hands back in gc:diff-files-loaded — no separate
// compareBranches RPC needed since getDiff already returns the list.
type CompareState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      files: ChangedFile[];
      totalAdditions: number;
      totalDeletions: number;
    };

@customElement("gc-compare-view")
export class GcCompareView extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) baseRef = "";
  @property({ type: String }) headRef = "";

  @state() private compareState: CompareState = { phase: "loading" };
  @state() private selectedFile = "";
  // 3-pane (before | diff | after) toggle. Parent-owned because the
  // button lives in the compare-view header; the pane reads it as a prop.
  @state() private threePane = false;
  // Progressive rename-detection trigger. Flipped after the fast first
  // load when both adds and deletes are present, making <gc-diff-pane>
  // re-fetch with detectRenames=true.
  @state() private wantRenameDetection = false;
  // Reset each time (repoId, baseRef, headRef) changes — lets us ignore
  // late gc:diff-files-loaded events from a superseded pane identity.
  private lastCompareKey = "";

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") || changed.has("baseRef") || changed.has("headRef")) {
      const key = `${this.repoId}:${this.baseRef}:${this.headRef}`;
      if (key !== this.lastCompareKey && this.repoId && this.baseRef && this.headRef) {
        this.lastCompareKey = key;
        // Reset state — the pane will refetch on its own when its props
        // change, firing gc:diff-files-loaded which rehydrates the list.
        this.compareState = { phase: "loading" };
        this.selectedFile = "";
        this.threePane = false;
        this.wantRenameDetection = false;
      }
    }
  }

  private onDiffFilesLoaded = (
    e: CustomEvent<{ files: ChangedFile[]; parentSha: string; toCommit: string }>,
  ) => {
    const files = e.detail.files;
    const totalAdditions = files.reduce((a, f) => a + (f.additions || 0), 0);
    const totalDeletions = files.reduce((a, f) => a + (f.deletions || 0), 0);
    this.compareState = { phase: "ready", files, totalAdditions, totalDeletions };
    if (
      !this.wantRenameDetection &&
      files.some((f) => f.status === "added") &&
      files.some((f) => f.status === "deleted")
    ) {
      this.wantRenameDetection = true;
    }
  };

  private setSelectedFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;
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
                @click=${() => this.setSelectedFile("")}
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
                        this.setSelectedFile(f.path);
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
                  @click=${() => {
                    this.threePane = !this.threePane;
                  }}
                  aria-label="Toggle 3-pane diff view (before | diff | after)"
                  aria-pressed=${this.threePane ? "true" : "false"}
                  title="Toggle 3-pane view (before | diff | after)"
                >
                  3-pane
                </button>`
              : nothing}
          </div>
          <gc-diff-pane
            class="diff-body"
            .repoId=${this.repoId}
            .fromRef=${this.baseRef}
            .toRef=${this.headRef}
            .path=${this.selectedFile}
            .threePane=${this.threePane}
            .leftLabel=${this.baseRef}
            .rightLabel=${this.headRef}
            .detectRenames=${this.wantRenameDetection}
            @gc:diff-files-loaded=${this.onDiffFilesLoaded}
          ></gc-diff-pane>
        </section>
      </div>
    `;
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
      color: var(--warning);
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

    /* ── Right: diff pane wrapper ───────────────────────────── */
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
    gc-diff-pane.diff-body {
      flex: 1;
      min-height: 0;
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
