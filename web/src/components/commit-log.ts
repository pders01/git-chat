import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repoClient } from "../lib/transport.js";
import type { CommitEntry } from "../gen/gitchat/v1/repo_pb.js";
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
  @state() private state: LogState = { phase: "loading" };
  @state() private selectedSha = "";
  @state() private diffHtml = "";
  @state() private diffLoading = false;
  @state() private drawerOpen = false;
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
    if (changed.has("repoId") && this.repoId) {
      void this.load(0);
    }
  }

  private async load(offset: number) {
    try {
      const resp = await repoClient.listCommits({
        repoId: this.repoId,
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

  private async selectCommit(sha: string) {
    // Support prefix matching (e.g. 7-char short SHA from blame).
    if (this.state.phase === "ready" && sha.length < 40) {
      const match = this.state.commits.find((c) => c.sha.startsWith(sha));
      if (match) sha = match.sha;
    }
    if (this.selectedSha === sha) {
      this.selectedSha = "";
      this.diffHtml = "";
      return;
    }
    this.selectedSha = sha;
    this.drawerOpen = false;
    this.diffHtml = "";
    this.diffLoading = true;

    try {
      const resp = await repoClient.getDiff({
        repoId: this.repoId,
        toRef: sha,
        // empty fromRef = parent of sha, empty path = whole commit
      });
      if (resp.empty) {
        this.diffHtml = "<p style='opacity:0.5'>no changes</p>";
      } else {
        const { highlight } = await loadHighlight();
        this.diffHtml = await highlight(resp.unifiedDiff, "diff");
      }
    } catch (e) {
      this.diffHtml = `<p style="color:var(--danger)">${e instanceof Error ? e.message : e}</p>`;
    } finally {
      this.diffLoading = false;
    }
  }

  private selectedCommit(): CommitEntry | undefined {
    if (this.state.phase !== "ready" || !this.selectedSha) return undefined;
    return this.state.commits.find((c) => c.sha === this.selectedSha);
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
      <div class="layout ${this.drawerOpen ? "drawer-open" : ""}">
        <button class="drawer-toggle" @click=${() => (this.drawerOpen = !this.drawerOpen)} aria-label="Toggle commit list">☰</button>
        ${this.drawerOpen ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>` : nothing}
        <!-- Left: commit list sidebar -->
        <aside class="commit-list" aria-label="Commit history">
          <ul class="commits" role="list" @keydown=${this.onListKeydown}>
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
          </ul>
          ${hasMore
            ? html`<button
                class="load-more"
                @click=${() => this.load(offset + 50)}
              >
                load more
              </button>`
            : nothing}
        </aside>

        <!-- Right: diff detail panel -->
        <section class="detail-panel">
          ${sel
            ? html`
                <div class="detail-header">
                  <div class="detail-title">
                    <span
                      class="detail-sha copyable"
                      tabindex="0"
                      role="button"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        copyText(this, sel.sha, "SHA copied");
                      }}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          copyText(this, sel.sha, "SHA copied");
                        }
                      }}
                      title="Press Enter to copy full SHA"
                    >${sel.shortSha}</span>
                    <span class="detail-msg">${sel.message}</span>
                  </div>
                  <div class="detail-meta">
                    <span class="detail-author">${sel.authorName}</span>
                    <span class="detail-age">${formatAge(Number(sel.authorTime))}</span>
                    ${sel.filesChanged
                      ? html`<span class="detail-stats">
                          <span class="adds">+${sel.additions}</span>
                          <span class="dels">-${sel.deletions}</span>
                          <span class="files">${sel.filesChanged} files</span>
                        </span>`
                      : nothing}
                    <button
                      class="action-btn"
                      @click=${() => this.askAboutCommit(sel)}
                    >
                      explain in chat
                    </button>
                  </div>
                </div>
                <div class="detail-body">
                  ${this.diffLoading
                    ? html`<div class="diff-loading">loading diff…</div>`
                    : this.diffHtml
                      ? html`<div class="diff-content">${unsafeHTML(this.diffHtml)}</div>`
                      : nothing}
                </div>
              `
            : html`
                <div class="empty-detail">
                  <div class="empty-title">select a commit</div>
                  <p class="empty-sub">click a commit to view its diff</p>
                </div>
              `}
        </section>
      </div>
    `;
  }

  static override styles = css`
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
      padding: var(--space-2) var(--space-4);
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
      grid-template-columns: var(--sidebar-width) 1fr;
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

    /* ── Right: detail panel ─────────────────────────────────── */
    .detail-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    .detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-3) var(--space-5);
      border-bottom: 1px solid var(--surface-4);
      background: var(--surface-1);
      flex-shrink: 0;
    }
    .detail-title {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      overflow: hidden;
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
    .detail-meta {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      font-size: var(--text-xs);
      flex-shrink: 0;
    }
    .detail-author {
      opacity: 0.65;
    }
    .detail-age {
      opacity: 0.45;
    }
    .detail-stats {
      display: flex;
      gap: var(--space-1);
    }
    .detail-stats .files {
      opacity: 0.5;
    }
    .detail-msg {
      font-size: var(--text-sm);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-header {
      flex-wrap: wrap;
      gap: var(--space-2);
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
    .detail-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    .diff-loading {
      padding: var(--space-6);
      opacity: 0.5;
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
    .empty-title {
      font-size: 1.1rem;
      font-weight: 500;
      margin-bottom: var(--space-2);
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
    .drawer-toggle { display: none; }
    .drawer-backdrop { display: none; }
    @media (max-width: 768px) {
      .layout { grid-template-columns: 1fr; }
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
        top: 44px; left: 0; bottom: 0;
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
