import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { svg } from "lit";
import { repoClient } from "../lib/transport.js";
import type { CommitEntry, ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import { copyText } from "../lib/clipboard.js";

// Lazy-load highlight for diff rendering.
let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

type LogState =
  | { phase: "loading" }
  | {
      phase: "ready";
      commits: CommitEntry[];
      hasMore: boolean;
      offset: number;
    }
  | { phase: "error"; message: string };

@customElement("gc-commit-log")
export class GcCommitLog extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @state() private state: LogState = { phase: "loading" };
  @state() private selectedSha = "";
  @state() private diffHtml = "";
  @state() private diffLoading = false;
  @state() private drawerOpen = false;
  @state() private graphMode = false;
  @state() private files: ChangedFile[] = [];
  @state() private selectedFile = ""; // "" = all files
  private fullDiffHtml = ""; // cached full-commit diff
  private pendingSha = "";

  private onSelectCommit = ((e: CustomEvent<{ sha: string }>) => {
    if (this.state.phase === "ready") {
      void this.selectCommit(e.detail.sha);
    } else {
      this.pendingSha = e.detail.sha;
    }
  }) as EventListener;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("gc:select-commit", this.onSelectCommit);
    if (this.repoId) void this.load(0);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:select-commit", this.onSelectCommit);
  }

  override updated(changed: Map<string, unknown>) {
    if ((changed.has("repoId") || changed.has("branch")) && this.repoId) {
      void this.load(0);
    }
  }

  private async load(offset: number) {
    try {
      const resp = await repoClient.listCommits({
        repoId: this.repoId,
        ref: this.branch,
        limit: 50,
        offset,
      });
      this.state = {
        phase: "ready",
        commits:
          offset > 0 && this.state.phase === "ready"
            ? [...this.state.commits, ...resp.commits]
            : resp.commits,
        hasMore: resp.hasMore,
        offset,
      };
      if (this.pendingSha) {
        const sha = this.pendingSha;
        this.pendingSha = "";
        void this.selectCommit(sha);
      }
    } catch (e) {
      this.state = {
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  private askAboutCommit(c: CommitEntry) {
    this.dispatchEvent(
      new CustomEvent("gc:ask-about", {
        bubbles: true,
        composed: true,
        detail: {
          prompt: `Explain commit ${c.shortSha} ("${c.message}"). What does it change and why?\n\n[[diff to=${c.sha}]]`,
          tab: "chat" as const,
        },
      }),
    );
  }

  private onListKeydown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>(".commit-row")];
    const current = (this.renderRoot as ShadowRoot).activeElement as HTMLElement | null;
    const idx = current ? rows.indexOf(current) : -1;
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    rows[next]?.focus();
  };

  @state() private diffError = "";

  private async selectCommit(sha: string) {
    // Support prefix matching (e.g. 7-char short SHA from blame).
    if (this.state.phase === "ready" && sha.length < 40) {
      const match = this.state.commits.find((c) => c.sha.startsWith(sha));
      if (match) {
        sha = match.sha;
      } else if (this.state.hasMore) {
        // Commit not in loaded page — resolve via listCommits with ref.
        try {
          const resp = await repoClient.listCommits({
            repoId: this.repoId,
            ref: sha,
            limit: 1,
          });
          if (resp.commits.length > 0) {
            sha = resp.commits[0].sha;
            // Append to loaded commits so it's selectable.
            this.state = {
              ...this.state,
              commits: [...this.state.commits, resp.commits[0]],
            };
          }
        } catch {
          // Can't resolve — proceed with short SHA anyway.
        }
      }
    }
    if (this.selectedSha === sha) {
      this.selectedSha = "";
      this.diffHtml = "";
      this.fullDiffHtml = "";
      this.diffError = "";
      this.files = [];
      this.selectedFile = "";
      return;
    }
    const requestedSha = sha;
    this.selectedSha = sha;
    this.selectedFile = "";
    this.drawerOpen = false;
    this.diffHtml = "";
    this.fullDiffHtml = "";
    this.diffError = "";
    this.files = [];
    this.diffLoading = true;

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        toRef: sha,
      });
      if (this.selectedSha !== requestedSha) return; // stale
      this.files = resp.files;
      if (resp.empty) {
        this.diffHtml = "";
        this.fullDiffHtml = this.diffHtml;
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(resp.unifiedDiff, "diff");
        if (this.selectedSha !== requestedSha) return; // stale
        this.diffHtml = highlighted;
        this.fullDiffHtml = highlighted;
      }
    } catch (e) {
      if (this.selectedSha !== requestedSha) return;
      this.diffError = e instanceof Error ? e.message : String(e);
    } finally {
      this.diffLoading = false;
    }
  }

  private async selectFile(path: string) {
    if (this.selectedFile === path) return;
    this.selectedFile = path;
    this.diffError = "";

    // "All files" — restore cached full diff.
    if (path === "") {
      this.diffHtml = this.fullDiffHtml;
      this.diffLoading = false;
      return;
    }

    const requestedSha = this.selectedSha;
    this.diffHtml = "";
    this.diffLoading = true;

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        toRef: this.selectedSha,
        path,
      });
      if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
      if (resp.empty) {
        this.diffHtml = "";
      } else {
        const { highlight } = await loadHighlight();
        const highlighted = await highlight(resp.unifiedDiff, "diff");
        if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
        this.diffHtml = highlighted;
      }
    } catch (e) {
      if (this.selectedSha !== requestedSha || this.selectedFile !== path) return;
      this.diffError = e instanceof Error ? e.message : String(e);
    } finally {
      this.diffLoading = false;
    }
  }

  private selectedFileEntry(): ChangedFile | undefined {
    return this.files.find((f) => f.path === this.selectedFile);
  }

  private selectedCommit(): CommitEntry | undefined {
    if (this.state.phase !== "ready" || !this.selectedSha) return undefined;
    return this.state.commits.find((c) =>
      c.sha === this.selectedSha || c.sha.startsWith(this.selectedSha),
    );
  }

  private renderGraph(commits: CommitEntry[]) {
    // Assign each commit to a lane. Simple algorithm:
    // - First commit gets lane 0
    // - If a commit's parent is in a different lane, draw a merge line
    const ROW_H = 32;
    const LANE_W = 16;
    const DOT_R = 4;
    const shaToRow = new Map<string, number>();
    const lanes: string[] = []; // lane[i] = SHA currently "active" in that lane

    interface NodeInfo { row: number; lane: number; parents: string[]; }
    const nodes: NodeInfo[] = [];

    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      shaToRow.set(c.sha, i);

      // Find lane: reuse lane where this commit was expected, or take a new one
      let lane = lanes.indexOf(c.sha);
      if (lane === -1) {
        lane = lanes.indexOf("");
        if (lane === -1) { lane = lanes.length; lanes.push(""); }
      }

      // Assign first parent to this lane (continues the line)
      const parentShas = (c as any).parentShas as string[] ?? [];
      if (parentShas.length > 0) {
        lanes[lane] = parentShas[0];
      } else {
        lanes[lane] = "";
      }

      // Additional parents get new lanes
      for (let p = 1; p < parentShas.length; p++) {
        const existing = lanes.indexOf(parentShas[p]);
        if (existing === -1) {
          const free = lanes.indexOf("");
          if (free !== -1) lanes[free] = parentShas[p];
          else lanes.push(parentShas[p]);
        }
      }

      nodes.push({ row: i, lane, parents: parentShas });
    }

    const maxLane = Math.max(0, ...nodes.map(n => n.lane));
    const svgW = (maxLane + 1) * LANE_W + 8;
    const svgH = commits.length * ROW_H;

    // Build SVG elements using Lit's svg tagged template
    const svgLines: ReturnType<typeof svg>[] = [];
    const svgDots: ReturnType<typeof svg>[] = [];

    for (const node of nodes) {
      const x = node.lane * LANE_W + LANE_W / 2 + 4;
      const y = node.row * ROW_H + ROW_H / 2;

      const isSelected = commits[node.row].sha === this.selectedSha;
      svgDots.push(svg`<circle cx=${x} cy=${y} r=${DOT_R} fill=${isSelected ? "var(--accent-user)" : "var(--accent-assistant)"} />`);

      for (const pSha of node.parents) {
        const pRow = shaToRow.get(pSha);
        if (pRow === undefined) {
          svgLines.push(svg`<line x1=${x} y1=${y} x2=${x} y2=${svgH} stroke="var(--surface-4)" stroke-width="1.5" />`);
          continue;
        }
        const pNode = nodes[pRow];
        const px = pNode.lane * LANE_W + LANE_W / 2 + 4;
        const py = pRow * ROW_H + ROW_H / 2;

        if (px === x) {
          svgLines.push(svg`<line x1=${x} y1=${y} x2=${px} y2=${py} stroke="var(--surface-4)" stroke-width="1.5" />`);
        } else {
          const midY = (y + py) / 2;
          svgLines.push(svg`<path d=${"M" + x + "," + y + " C" + x + "," + midY + " " + px + "," + midY + " " + px + "," + py} fill="none" stroke="var(--accent-user)" stroke-width="1.5" opacity="0.4" />`);
        }
      }
    }

    return html`
      <div class="graph-scroll">
      <div class="graph-view" @keydown=${this.onListKeydown} style="height:${svgH}px">
        <svg class="graph-svg" width="${svgW}" height="${svgH}">
          ${svgLines}
          ${svgDots}
        </svg>
        ${commits.map((c, i) => {
          const y = i * ROW_H;
          return html`
            <button
              class="graph-row ${c.sha === this.selectedSha ? "selected" : ""}"
              style="height:${ROW_H}px; top:${y}px; padding-left:${svgW + 4}px"
              @click=${() => this.selectCommit(c.sha)}
              title="${c.message} — ${c.authorName}"
            >
              <span class="graph-msg">${c.shortSha} ${c.message}</span>
              <span class="graph-age">${formatAge(Number(c.authorTime))}</span>
            </button>`;
        })}
      </div>
      </div>
    `;
  }

  override render() {
    if (this.state.phase === "loading") {
      return html`<div class="loading">loading commits…</div>`;
    }
    if (this.state.phase === "error") {
      return html`<div class="err">
        ${this.state.message}
        <button class="retry-btn" @click=${() => void this.load(0)}>retry</button>
      </div>`;
    }
    const { commits, hasMore, offset } = this.state;
    const sel = this.selectedCommit();
    return html`
      <div class="layout ${this.drawerOpen ? "drawer-open" : ""}"
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape" && this.drawerOpen) { this.drawerOpen = false; } }}>
        <button class="drawer-toggle" @click=${() => (this.drawerOpen = !this.drawerOpen)} aria-label="Toggle commit list">☰</button>
        ${this.drawerOpen ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>` : nothing}
        <!-- Left: commit list sidebar -->
        <aside class="commit-list" aria-label="Commit history">
          <div class="list-header">
            <button
              class="graph-toggle ${this.graphMode ? "active" : ""}"
              @click=${() => { this.graphMode = !this.graphMode; }}
              aria-label="Toggle graph view"
              aria-pressed=${this.graphMode ? "true" : "false"}
              title="Toggle graph view"
            >⑂</button>
          </div>
          ${this.graphMode
            ? this.renderGraph(commits)
            : html`<ul class="commits" role="list" @keydown=${this.onListKeydown}>
            ${commits.map(
              (c) => html`
                <li>
                  <button
                    class="commit-row ${c.sha === this.selectedSha ? "selected" : ""}"
                    aria-pressed=${c.sha === this.selectedSha ? "true" : "false"}
                    @click=${() => this.selectCommit(c.sha)}
                    title="${c.message} — ${c.authorName}"
                  >
                    <div class="commit-line1">
                      <span class="sha">${c.shortSha}</span>
                      <span class="commit-msg">${c.message}</span>
                    </div>
                    <div class="commit-line2">
                      <span class="commit-author">${c.authorName}</span>
                      <span class="commit-age">${formatAge(Number(c.authorTime), true)}</span>
                      ${c.filesChanged
                        ? html`<span class="commit-stats">
                            <span class="adds">+${c.additions}</span>
                            <span class="dels">-${c.deletions}</span>
                          </span>`
                        : nothing}
                    </div>
                  </button>
                </li>
              `,
            )}
          </ul>`}
          ${hasMore
            ? html`<button
                class="load-more"
                @click=${() => this.load(offset + 50)}
              >
                load more
              </button>`
            : nothing}
        </aside>

        <!-- Middle: commit info pane -->
        <section class="info-pane">
          ${sel
            ? html`
                <div class="info-sha">
                  <span
                    class="detail-sha copyable"
                    tabindex="0"
                    role="button"
                    @click=${(e: Event) => { e.stopPropagation(); copyText(this, sel.sha, "SHA copied"); }}
                    @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyText(this, sel.sha, "SHA copied"); } }}
                    title="Press Enter to copy full SHA"
                  >${sel.shortSha}</span>
                </div>
                <div class="info-subject">${sel.message}</div>
                ${sel.body ? html`<pre class="info-body">${sel.body}</pre>` : nothing}
                <div class="info-meta">
                  <span>${sel.authorName}</span>
                  <span class="info-age">${formatAge(Number(sel.authorTime))}</span>
                </div>
                <button
                  class="action-btn"
                  @click=${() => this.askAboutCommit(sel)}
                  aria-label="Explain commit ${sel.shortSha} in chat"
                >explain in chat</button>
                ${this.files.length
                  ? html`
                    <div class="file-list-header">
                      <span>files</span>
                      <span class="info-files">${this.files.length}</span>
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
                            <span class="adds">+${sel.additions}</span>
                            <span class="dels">-${sel.deletions}</span>
                          </span>
                        </button>
                      </li>
                      ${this.files.map((f) => html`
                        <li>
                          <button
                            class="file-entry ${this.selectedFile === f.path ? "selected" : ""}"
                            @click=${() => this.selectFile(f.path)}
                            title=${f.path}
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
                    </ul>`
                  : nothing}
              `
            : html`<div class="info-empty">select a commit</div>`}
        </section>

        <!-- Right: diff pane -->
        <section class="diff-pane">
          ${sel
            ? html`
                <div class="diff-header">
                  ${this.selectedFile
                    ? html`
                        <span class="file-status ${this.selectedFileEntry()?.status ?? ""}">${statusLabel(this.selectedFileEntry()?.status ?? "")}</span>
                        <span class="diff-filepath">${this.selectedFile}</span>
                        <span class="diff-spacer"></span>
                        ${this.selectedFileEntry()
                          ? html`<span class="detail-stats">
                              <span class="adds">+${this.selectedFileEntry()!.additions}</span>
                              <span class="dels">-${this.selectedFileEntry()!.deletions}</span>
                            </span>`
                          : nothing}`
                    : html`
                        <span class="detail-sha">${sel.shortSha}</span>
                        <span class="diff-label">diff</span>
                        <span class="diff-spacer"></span>
                        ${sel.filesChanged
                          ? html`<span class="detail-stats">
                              <span class="info-files">${sel.filesChanged} file${sel.filesChanged > 1 ? "s" : ""}</span>
                              <span class="adds">+${sel.additions}</span>
                              <span class="dels">-${sel.deletions}</span>
                            </span>`
                          : nothing}`}
                </div>
                <div class="diff-body">
                  ${this.diffLoading
                    ? html`<div class="diff-loading">loading diff…</div>`
                    : this.diffError
                      ? html`<p style="color:var(--danger);padding:var(--space-4)">${this.diffError}</p>`
                      : this.diffHtml
                        ? html`<div class="diff-content">${unsafeHTML(this.diffHtml)}</div>`
                        : html`<div class="diff-empty">no changes</div>`}
                </div>`
            : html`<div class="empty-detail">
                <p class="empty-sub">click a commit to view its diff</p>
              </div>`}
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
    .loading,
    .err {
      padding: var(--space-6);
      opacity: 0.55;
    }
    .err {
      color: var(--danger);
      opacity: 1;
    }
    .retry-btn {
      margin-top: var(--space-3);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    .retry-btn:hover {
      background: var(--surface-3);
    }

    /* ── Sidebar + panel grid (matches chat/browse) ──────────── */
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 280px 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    /* ── Left: commit list ───────────────────────────────────── */
    .commit-list {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-right: 1px solid var(--surface-4);
      background: var(--surface-0);
    }
    .commits {
      list-style: none;
      padding: var(--space-1) 0;
      margin: 0;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .commits li {
      margin: 0;
    }
    .commit-row {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      width: 100%;
      padding: var(--space-2) var(--space-3);
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
    .commit-row:hover {
      background: var(--surface-2);
    }
    .commit-row.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .commit-row:focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: -2px;
    }
    .commit-line1 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      overflow: hidden;
    }
    .sha {
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .commit-msg {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-sm);
    }
    .commit-line2 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 0.65rem;
      opacity: 0.5;
    }
    .commit-author {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .commit-age {
      flex-shrink: 0;
    }
    .commit-stats {
      flex-shrink: 0;
      display: flex;
      gap: var(--space-1);
    }
    .adds {
      color: var(--accent-assistant);
    }
    .dels {
      color: var(--danger);
      margin-left: var(--space-1);
    }

    .load-more {
      margin: var(--space-2);
      padding: var(--space-1) var(--space-3);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      text-align: center;
    }
    .load-more:hover {
      background: var(--surface-3);
    }

    /* ── List header + graph toggle ─────────────────────────── */
    .list-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: var(--space-1) var(--space-2);
      border-bottom: 1px solid var(--surface-4);
      flex-shrink: 0;
      height: 36px;
      box-sizing: border-box;
    }
    .graph-toggle {
      padding: 2px var(--space-2);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
    }
    .graph-toggle:hover { opacity: 0.8; }
    .graph-toggle.active {
      opacity: 1;
      background: var(--surface-3);
      border-color: var(--accent-user);
    }

    /* ── Graph view ──────────────────────────────────────────── */
    .graph-scroll {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }
    .graph-view {
      position: relative;
    }
    .graph-svg {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1;
      pointer-events: none;
    }
    .graph-row {
      display: flex;
      align-items: center;
      position: absolute;
      left: 0;
      right: 0;
      z-index: 2;
      padding: 0 var(--space-2) 0 48px;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
      gap: var(--space-2);
    }
    .graph-row:hover { background: var(--surface-2); }
    .graph-row.selected {
      background: var(--surface-2);
      border-left-color: var(--accent-assistant);
    }
    .graph-msg {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .graph-age {
      flex-shrink: 0;
      opacity: 0.45;
      font-size: 0.65rem;
    }

    /* ── Right: diff pane ─────────────────────────────────────── */
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
    .diff-spacer { flex: 1; }
    .diff-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    /* ── Middle: commit info pane ──────────────────────────────── */
    .info-pane {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-4);
      border-right: 1px solid var(--surface-4);
      background: var(--surface-1);
      overflow-y: auto;
      min-height: 0;
    }
    .info-sha .detail-sha {
      font-size: var(--text-sm);
    }
    .info-subject {
      font-size: var(--text-sm);
      font-weight: 500;
      line-height: 1.4;
    }
    .info-body {
      margin: 0;
      padding: var(--space-2) 0 var(--space-2) var(--space-3);
      border-left: 2px solid var(--surface-4);
      font-family: inherit;
      font-size: var(--text-xs);
      white-space: pre-wrap;
      opacity: 0.75;
      line-height: 1.6;
      max-height: 200px;
      overflow-y: auto;
    }
    .info-meta {
      display: flex;
      gap: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.6;
    }
    .info-files {
      opacity: 0.5;
    }
    .info-empty {
      opacity: 0.4;
      padding: var(--space-4);
    }

    /* ── File list ──────────────────────────────────────────────── */
    .file-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: var(--space-3);
      margin-top: var(--space-2);
      border-top: 1px solid var(--surface-4);
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
      margin: var(--space-1) 0 0;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .file-entry {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-1) var(--space-2);
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
    .diff-filepath {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-xs);
    }

    .copyable {
      cursor: copy;
    }
    .copyable:hover {
      text-decoration: underline;
    }
    .detail-sha {
      color: var(--accent-user);
      font-size: var(--text-sm);
      flex-shrink: 0;
    }
    .detail-stats {
      display: flex;
      gap: var(--space-1);
      font-size: var(--text-xs);
      flex-shrink: 0;
    }
    .action-btn {
      padding: var(--space-1) var(--space-3);
      background: var(--action-bg);
      color: var(--text);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
    }
    .action-btn:focus-visible,
    .commit-row:focus-visible,
    .detail-sha:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .action-btn:hover {
      background: var(--action-bg-hover);
    }
    .diff-loading {
      padding: var(--space-6);
      opacity: 0.5;
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
    .empty-detail {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      opacity: 0.55;
    }
    .empty-sub {
      margin: 0;
      font-size: 0.82rem;
      opacity: 0.7;
    }

    @media (prefers-reduced-motion: reduce) {
      .commit-row {
        transition: none;
      }
    }
    @media (max-width: 1100px) and (min-width: 769px) {
      .layout {
        grid-template-columns: var(--sidebar-width) 1fr;
        grid-template-rows: auto 1fr;
      }
      .commit-list {
        grid-row: 1 / -1;
      }
      .info-pane {
        grid-column: 2;
        grid-row: 1;
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
      }
      .diff-pane {
        grid-column: 2;
        grid-row: 2;
      }
    }
    .drawer-toggle { display: none; }
    .drawer-backdrop { display: none; }
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .info-pane {
        border-right: none;
        border-bottom: 1px solid var(--surface-4);
        max-height: 40vh;
      }
      .drawer-toggle {
        display: block;
        position: fixed;
        bottom: var(--space-5);
        left: var(--space-4);
        z-index: 30;
        width: 44px; height: 44px;
        border-radius: 50%;
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--border-default);
        font-size: 1.1rem;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      .commit-list {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        width: 280px;
        z-index: 40;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--surface-4);
      }
      .drawer-open .commit-list { transform: translateX(0); }
      .drawer-backdrop {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 35;
      }
      .drawer-open .drawer-backdrop { display: block; }
    }
  `;
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

// Returns either a plain string or an {age, iso} object for tooltip.
function formatAge(unixSeconds: number, withTooltip: true): ReturnType<typeof html>;
function formatAge(unixSeconds: number, withTooltip?: false): string;
function formatAge(unixSeconds: number, withTooltip = false): string | ReturnType<typeof html> {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  let age: string;
  if (diff < 60) age = "now";
  else if (diff < 3600) age = Math.floor(diff / 60) + "m";
  else if (diff < 86400) age = Math.floor(diff / 3600) + "h";
  else if (diff < 604800) age = Math.floor(diff / 86400) + "d";
  else if (diff < 2592000) age = Math.floor(diff / 604800) + "w";
  else age = Math.floor(diff / 2592000) + "mo";

  if (!withTooltip) return age;
  const iso = new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
  return html`<span title=${iso}>${age}</span>`;
}
