import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import {
  EntryType,
  type Repo,
  type TreeEntry,
} from "../gen/gitchat/v1/repo_pb.js";
import "./file-view.js";

type BrowserState =
  | { phase: "loading" }
  | { phase: "no-repos" }
  | { phase: "ready"; repo: Repo; entries: TreeEntry[]; path: string }
  | { phase: "error"; message: string };

@customElement("gc-repo-browser")
export class GcRepoBrowser extends LitElement {
  @property({ type: String }) repoId = "";

  @state() private state: BrowserState = { phase: "loading" };
  @state() private selectedFile = "";
  // Focus mode collapses the tree sidebar so the file view takes the
  // full main area — useful for reading large files or using git-chat
  // as a source browser.
  @state() private focused = readFocus();
  @state() private drawerOpen = false;

  private toggleFocus = () => {
    this.focused = !this.focused;
    writeFocus(this.focused);
  };

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) void this.boot();
    this.addEventListener("gc:toggle-focus", () => this.toggleFocus());
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      void this.boot();
    }
  }

  private async boot() {
    if (!this.repoId) {
      this.state = { phase: "no-repos" };
      return;
    }
    try {
      // Fetch repo metadata so we have label + branch info.
      const { repos } = await repoClient.listRepos({});
      const repo = repos.find((r) => r.id === this.repoId);
      if (!repo) {
        this.state = { phase: "no-repos" };
        return;
      }
      this.selectedFile = "";
      await this.loadPath(repo, "");
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async loadPath(repo: Repo, path: string) {
    try {
      const { entries } = await repoClient.listTree({
        repoId: repo.id,
        ref: "",
        path,
      });
      this.state = { phase: "ready", repo, entries, path };
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async navigate(name: string, type: EntryType) {
    if (this.state.phase !== "ready") return;
    const { repo, path } = this.state;
    const nextPath = path ? `${path}/${name}` : name;
    if (type === EntryType.DIR) {
      this.selectedFile = "";
      await this.loadPath(repo, nextPath);
    } else if (type === EntryType.FILE) {
      this.selectedFile = nextPath;
      this.requestUpdate();
    }
  }

  private async up() {
    if (this.state.phase !== "ready") return;
    const { repo, path } = this.state;
    if (!path) return;
    const idx = path.lastIndexOf("/");
    const nextPath = idx < 0 ? "" : path.slice(0, idx);
    this.selectedFile = "";
    await this.loadPath(repo, nextPath);
  }

  override render() {
    switch (this.state.phase) {
      case "loading":
        return html`<p class="hint">loading repositories…</p>`;
      case "no-repos":
        return html`<p class="hint">no repositories configured</p>`;
      case "error":
        return html`<p class="err">${this.state.message}</p>`;
      case "ready":
        return this.renderReady(this.state);
    }
  }

  private renderReady(s: Extract<BrowserState, { phase: "ready" }>) {
    const crumbs = s.path ? s.path.split("/") : [];
    return html`
      <div class="layout ${this.focused ? "focused" : ""} ${this.drawerOpen ? "drawer-open" : ""}">
        <button class="drawer-toggle" @click=${() => (this.drawerOpen = !this.drawerOpen)} aria-label="Toggle file tree">☰</button>
        ${this.drawerOpen ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>` : nothing}
        <aside>
          <div class="repo-hd">
            <span class="label">${s.repo.label}</span>
            <span class="branch">${s.repo.defaultBranch}@${s.repo.headCommit}</span>
          </div>

          <nav class="crumbs">
            <button class="crumb" @click=${() => this.jumpTo(s.repo, "")}>
              /
            </button>
            ${crumbs.map(
              (part, i) => html`
                <span class="sep">/</span>
                <button
                  class="crumb"
                  @click=${() =>
                    this.jumpTo(s.repo, crumbs.slice(0, i + 1).join("/"))}
                >
                  ${part}
                </button>
              `,
            )}
          </nav>

          <ul class="entries">
            ${s.path
              ? html`
                  <li>
                    <button class="entry up" @click=${() => this.up()}>
                      <span class="icon">↑</span> ..
                    </button>
                  </li>
                `
              : nothing}
            ${s.entries.map(
              (entry) => html`
                <li>
                  <button
                    class="entry ${this.entryClass(entry)}"
                    @click=${() => this.navigate(entry.name, entry.type)}
                    ?disabled=${entry.type !== EntryType.DIR &&
                    entry.type !== EntryType.FILE}
                  >
                    <span class="icon">${this.entryIcon(entry.type)}</span>
                    ${entry.name}
                  </button>
                </li>
              `,
            )}
          </ul>
        </aside>

        <section>
          <div class="pane-hd">
            <button
              class="focus-btn"
              @click=${this.toggleFocus}
              title=${this.focused ? "show tree" : "hide tree"}
            >
              ${this.focused ? "◀" : "▶"}
              <span class="focus-label">
                ${this.focused ? "exit focus" : "focus"}
              </span>
            </button>
          </div>
          <gc-file-view
            .repoId=${s.repo.id}
            .path=${this.selectedFile}
            .branch=${""}
          ></gc-file-view>
        </section>
      </div>
    `;
  }

  private async jumpTo(repo: Repo, path: string) {
    this.selectedFile = "";
    await this.loadPath(repo, path);
  }

  private entryClass(e: TreeEntry): string {
    return e.type === EntryType.DIR
      ? "dir"
      : e.type === EntryType.FILE
        ? "file"
        : "other";
  }

  private entryIcon(t: EntryType): string {
    switch (t) {
      case EntryType.DIR:
        return "▸";
      case EntryType.FILE:
        return "·";
      case EntryType.SYMLINK:
        return "→";
      case EntryType.SUBMODULE:
        return "+";
      default:
        return "?";
    }
  }

  static override styles = css`
    :host {
      /* Full-viewport mode: same scroll-chain discipline as chat-view —
         every ancestor in the flex/grid chain has min-height: 0 so the
         nested scroll regions (file list, file content) clamp to the
         available space instead of pushing content past the shell. */
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      color: var(--text);
      font-size: 0.82rem;
      background: var(--surface-1);
    }
    .layout {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      flex: 1;
      min-height: 0;
      min-width: 0;
      transition: grid-template-columns 0.2s ease;
    }
    /* Focus mode: collapse the tree column so the file view expands
       to the full main area. localStorage persists the preference. */
    .layout.focused {
      grid-template-columns: 0 1fr;
    }
    .layout.focused aside {
      overflow: hidden;
      border-right-width: 0;
    }
    aside {
      border-right: 1px solid var(--surface-4);
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      background: var(--surface-0);
    }
    section {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    section > gc-file-view {
      flex: 1;
      min-height: 0;
    }
    .pane-hd {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 0.4rem var(--space-3) 0;
      flex-shrink: 0;
    }
    .focus-btn {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: var(--space-1) 0.55rem;
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      border-radius: 3px;
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.4;
      transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
    }
    .focus-btn:hover {
      opacity: 0.9;
      background: var(--surface-2);
      border-color: var(--border-default);
    }
    .focus-label {
      letter-spacing: 0.05em;
    }
    .repo-hd {
      padding: 0.85rem 0.95rem;
      border-bottom: 1px solid var(--border-default);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      background: var(--surface-1);
    }
    .label {
      font-weight: 500;
    }
    .branch {
      opacity: 0.55;
      font-size: 0.72rem;
    }
    .crumbs {
      padding: var(--space-2) var(--space-3);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.1rem;
      border-bottom: 1px solid var(--border-default);
      font-size: 0.72rem;
    }
    .sep {
      opacity: 0.35;
      margin: 0 0.1rem;
    }
    .crumb {
      background: transparent;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: inherit;
      padding: 0.1rem var(--space-1);
      cursor: pointer;
      opacity: 0.75;
    }
    .crumb:hover {
      opacity: 1;
    }
    .entries {
      list-style: none;
      margin: 0;
      padding: 0.35rem 0;
      overflow-y: auto;
      flex: 1;
    }
    li {
      margin: 0;
    }
    .entry {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-1) 0.95rem;
      background: transparent;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: inherit;
      text-align: left;
      cursor: pointer;
    }
    .entry:hover:not(:disabled) {
      background: var(--surface-3);
    }
    .entry:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .icon {
      display: inline-block;
      width: 1ch;
      text-align: center;
      opacity: 0.55;
    }
    .entry.dir {
      color: var(--accent-user);
    }
    .entry.up {
      opacity: 0.6;
    }
    .hint,
    .err {
      padding: var(--space-5);
      opacity: 0.55;
      margin: 0;
    }
    .err {
      color: var(--danger);
      opacity: 1;
    }
    section {
      overflow: hidden;
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
      aside {
        position: fixed;
        top: 44px; left: 0; bottom: 0;
        width: 280px;
        z-index: 40;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--surface-4);
      }
      .drawer-open aside { transform: translateX(0); }
      .drawer-backdrop {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.5);
        z-index: 35;
      }
      .drawer-open .drawer-backdrop { display: block; }
      .pane-hd { display: none; }
    }
  `;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
