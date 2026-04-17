import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repoClient } from "../lib/transport.js";
import { readFocus, writeFocus } from "../lib/focus.js";
import { EntryType, type Repo } from "../gen/gitchat/v1/repo_pb.js";
import type { BrowseView } from "../lib/routing.js";
import "./loading-indicator.js";
import "./file-view.js";
import "./compare-view.js";
import "./changes-view.js";
import "./code-city.js";

/** A node in the expandable file tree. */
interface TreeNode {
  name: string;
  fullPath: string;
  type: EntryType;
  children: TreeNode[] | null; // null = not loaded yet
  open: boolean;
  loading: boolean;
}

type BrowserState =
  | { phase: "loading" }
  | { phase: "no-repos" }
  | { phase: "ready"; repo: Repo; roots: TreeNode[] }
  | { phase: "error"; message: string };

@customElement("gc-repo-browser")
export class GcRepoBrowser extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: String }) branch = "";
  @property({ type: String }) initialFilePath = "";
  @property({ type: Boolean }) initialBlame = false;
  @property({ type: String }) initialBrowseView: BrowseView = "file";
  @property({ type: String }) initialCompareBase = "";
  @property({ type: String }) initialCompareHead = "";

  @state() private state: BrowserState = { phase: "loading" };
  @state() private selectedFile = "";
  // Focus mode collapses the tree sidebar so the file view takes the
  // full main area — useful for reading large files or using git-chat
  // as a source browser.
  @state() private focused = readFocus();
  @state() private drawerOpen = false;
  @state() private comparing = false;
  @state() private showChanges = false;
  @state() private showCity = false;
  @state() private branches: Array<{ name: string }> = [];
  @state() private baseRef = "";
  @state() private headRef = "";
  private pendingFile = "";

  private onToggleFocus = () => {
    this.focused = !this.focused;
    writeFocus(this.focused);
  };

  private onSyncFocus = () => {
    this.focused = readFocus();
  };

  private toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    if (this.drawerOpen) {
      void this.updateComplete.then(() => {
        this.renderRoot.querySelector<HTMLElement>("aside")?.focus();
      });
    }
  }

  private compareFetching = false;

  private async toggleCompare() {
    if (this.compareFetching) return;
    const next = !this.comparing;
    if (!next) {
      // Turning off — clear compare from URL.
      this.comparing = false;
      this.emitNav({ compareBase: undefined, compareHead: undefined, browseView: "file" });
      return;
    }
    // Turning on — need branch list first.
    this.comparing = true;
    this.showChanges = false;
    this.showCity = false;
    if (this.branches.length === 0) {
      await this.fetchBranches();
      if (!this.comparing) return; // toggled off while fetching
      if (this.state.phase === "ready") {
        this.baseRef = this.state.repo.defaultBranch || this.branches[0]?.name || "";
        const other = this.branches.find((b) => b.name !== this.baseRef);
        this.headRef = other ? other.name : this.baseRef;
      }
    }
    this.emitNav({ compareBase: this.baseRef, compareHead: this.headRef, browseView: undefined });
  }

  private toggleChanges() {
    const next = !this.showChanges;
    // Set local state immediately so the toggleCompare async guard fires.
    this.comparing = false;
    this.emitNav({
      browseView: next ? "changes" : "file",
      compareBase: undefined,
      compareHead: undefined,
    });
  }

  private toggleCity() {
    const next = !this.showCity;
    this.comparing = false;
    this.emitNav({
      browseView: next ? "city" : "file",
      compareBase: undefined,
      compareHead: undefined,
    });
  }

  /** Fetch branch list for the compare dropdowns. */
  private async fetchBranches() {
    this.compareFetching = true;
    try {
      const resp = await repoClient.listBranches({ repoId: this.repoId });
      this.branches = resp.branches;
    } catch {
      // Silently fail — dropdowns will remain empty.
    } finally {
      this.compareFetching = false;
    }
  }

  /** Dispatch a gc:nav event with partial route state. */
  private emitNav(detail: Record<string, unknown>) {
    this.dispatchEvent(
      new CustomEvent("gc:nav", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private swapRefs() {
    [this.baseRef, this.headRef] = [this.headRef, this.baseRef];
    this.emitNav({ compareBase: this.baseRef, compareHead: this.headRef });
  }

  // renderRefOptions emits <option> elements for the compare dropdowns.
  // Non-branch refs supplied via URL (HEAD~N, tag names, commit SHAs — as
  // produced by `git chat . HEAD~8..`) get a synthetic leading option so
  // the dropdown reflects the active selection instead of silently
  // falling back to the first branch.
  private renderRefOptions(selected: string) {
    const inBranches = !!selected && this.branches.some((b) => b.name === selected);
    return html`
      ${selected && !inBranches
        ? html`<option value=${selected} selected>${selected}</option>`
        : nothing}
      ${this.branches.map(
        (b) => html`<option value=${b.name} ?selected=${b.name === selected}>${b.name}</option>`,
      )}
    `;
  }

  private onOpenFile = ((e: CustomEvent<{ path: string }>) => {
    // If the event came from code-city, let it bubble to app.ts which
    // will navigate to browse/file (clearing browseView via onOpenFile).
    const target = e.target as HTMLElement;
    const fromCodeCity = target?.tagName?.toLowerCase() === "gc-code-city";
    if (this.state.phase === "ready") {
      this.selectedFile = e.detail.path;
      this.requestUpdate();
    } else {
      this.pendingFile = e.detail.path;
    }
    if (fromCodeCity) {
      return; // Don't stop propagation, let app.ts handle navigation
    }
  }) as EventListener;

  override connectedCallback() {
    super.connectedCallback();
    if (this.repoId) void this.boot();
    this.addEventListener("gc:toggle-focus", this.onSyncFocus);
    this.addEventListener("gc:open-file", this.onOpenFile);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("gc:toggle-focus", this.onSyncFocus);
    this.removeEventListener("gc:open-file", this.onOpenFile);
  }

  private _lastRestoredFile = "";

  override updated(changed: Map<string, unknown>) {
    if ((changed.has("repoId") || changed.has("branch")) && this.repoId) {
      this._lastRestoredFile = "";
      void this.boot();
    }
    if (
      changed.has("initialFilePath") &&
      this.initialFilePath &&
      this.initialFilePath !== this._lastRestoredFile
    ) {
      this._lastRestoredFile = this.initialFilePath;
      if (this.state.phase === "ready") {
        void this.revealAndSelect(this.initialFilePath);
      } else {
        this.pendingFile = this.initialFilePath;
      }
    }
    // Sync view mode from URL (enables back/forward navigation).
    if (changed.has("initialBrowseView")) {
      const v = this.initialBrowseView;
      this.showCity = v === "city";
      this.showChanges = v === "changes";
      // Compare is controlled by its own URL param, not browseView.
      if (v === "city" || v === "changes") this.comparing = false;
    }
    // Sync compare state from URL.
    if (changed.has("initialCompareBase") || changed.has("initialCompareHead")) {
      if (this.initialCompareBase && this.initialCompareHead) {
        this.comparing = true;
        this.showCity = false;
        this.showChanges = false;
        this.baseRef = this.initialCompareBase;
        this.headRef = this.initialCompareHead;
        // Lazy-fetch branch list for the dropdowns if not loaded yet.
        if (this.branches.length === 0 && !this.compareFetching) {
          void this.fetchBranches();
        }
      } else if (!this.initialCompareBase && !this.initialCompareHead && this.comparing) {
        // Compare params cleared (e.g. back from compare to file view).
        this.comparing = false;
      }
    }
  }

  private async revealAndSelect(path: string) {
    await this.revealPath(path);
    this.selectedFile = path;
  }

  private async boot() {
    if (!this.repoId) {
      this.state = { phase: "no-repos" };
      return;
    }
    try {
      const { repos } = await repoClient.listRepos({});
      const repo = repos.find((r) => r.id === this.repoId);
      if (!repo) {
        this.state = { phase: "no-repos" };
        return;
      }
      this.selectedFile = "";
      const roots = await this.fetchChildren(repo.id, "");
      this.state = { phase: "ready", repo, roots };
      // Apply pending file from search navigation.
      if (this.pendingFile) {
        // Expand parent dirs to reveal the file.
        await this.revealPath(this.pendingFile);
        this.selectedFile = this.pendingFile;
        this.pendingFile = "";
      }
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async fetchChildren(repoId: string, path: string): Promise<TreeNode[]> {
    const { entries } = await repoClient.listTree({ repoId, ref: this.branch, path });
    return entries
      .map((e) => ({
        name: e.name,
        fullPath: path ? `${path}/${e.name}` : e.name,
        type: e.type,
        children: e.type === EntryType.DIR ? null : (undefined as never),
        open: false,
        loading: false,
      }))
      .filter((n) => n.type === EntryType.DIR || n.type === EntryType.FILE);
  }

  private async toggleDir(node: TreeNode) {
    if (this.state.phase !== "ready") return;
    if (node.open) {
      node.open = false;
      this.requestUpdate();
      return;
    }
    // Lazy-load children on first expand.
    if (node.children === null) {
      node.loading = true;
      this.requestUpdate();
      try {
        node.children = await this.fetchChildren(this.state.repo.id, node.fullPath);
      } catch {
        node.children = [];
      }
      node.loading = false;
    }
    node.open = true;
    this.requestUpdate();
  }

  private selectFile(node: TreeNode) {
    this.selectedFile = node.fullPath;
    this._lastRestoredFile = node.fullPath;
    this.requestUpdate();
    // Clear all view mode state — selecting a file returns to file view.
    this.emitNav({
      filePath: node.fullPath,
      browseView: "file",
      compareBase: undefined,
      compareHead: undefined,
    });
  }

  /** Expand all ancestor directories for a given file path. */
  private async revealPath(filePath: string) {
    if (this.state.phase !== "ready") return;
    const parts = filePath.split("/");
    let nodes = this.state.roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = nodes.find((n) => n.name === parts[i] && n.type === EntryType.DIR);
      if (!dir) return;
      if (dir.children === null) {
        dir.children = await this.fetchChildren(this.state.repo.id, dir.fullPath);
      }
      dir.open = true;
      nodes = dir.children;
    }
    this.requestUpdate();
  }

  override render() {
    switch (this.state.phase) {
      case "loading":
        return html`<gc-loading-banner heading="loading repositories…"></gc-loading-banner>`;
      case "no-repos":
        return html`<p class="hint">no repositories configured</p>`;
      case "error":
        return html`<p class="err">${this.state.message}</p>`;
      case "ready":
        return this.renderReady(this.state);
    }
  }

  private renderReady(s: Extract<BrowserState, { phase: "ready" }>) {
    return html`
      <div
        class="layout ${this.focused ? "focused" : ""} ${this.drawerOpen
          ? "drawer-open"
          : ""} ${this.comparing || this.showChanges || this.showCity ? "comparing" : ""}"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape" && this.drawerOpen) {
            this.drawerOpen = false;
          }
        }}
      >
        <button
          class="drawer-toggle"
          @click=${() => this.toggleDrawer()}
          aria-label="Toggle file tree"
          aria-expanded=${this.drawerOpen ? "true" : "false"}
        >
          ☰
        </button>
        ${this.drawerOpen
          ? html`<div class="drawer-backdrop" @click=${() => (this.drawerOpen = false)}></div>`
          : nothing}
        <aside aria-label="File tree" tabindex="-1">
          <div class="repo-hd">
            ${this.comparing
              ? html` <select
                    class="ref-select"
                    .value=${this.baseRef}
                    @change=${(e: Event) => {
                      this.baseRef = (e.target as HTMLSelectElement).value;
                      this.emitNav({ compareBase: this.baseRef, compareHead: this.headRef });
                    }}
                    aria-label="Base branch"
                  >
                    ${this.renderRefOptions(this.baseRef)}
                  </select>
                  <button
                    class="hd-btn swap-btn"
                    @click=${() => this.swapRefs()}
                    aria-label="Swap branches"
                    title="Swap base and head"
                  >
                    ⇄
                  </button>
                  <select
                    class="ref-select"
                    .value=${this.headRef}
                    @change=${(e: Event) => {
                      this.headRef = (e.target as HTMLSelectElement).value;
                      this.emitNav({ compareBase: this.baseRef, compareHead: this.headRef });
                    }}
                    aria-label="Head branch"
                  >
                    ${this.renderRefOptions(this.headRef)}
                  </select>`
              : html` <span class="branch"
                  >${this.branch || s.repo.defaultBranch}@${s.repo.headCommit}</span
                >`}
            <button
              class="hd-btn"
              @click=${() => this.toggleCity()}
              aria-label="Code city"
              aria-pressed=${this.showCity ? "true" : "false"}
              title="Activity visualization"
            >
              &#x25C9;
            </button>
            <button
              class="hd-btn"
              @click=${() => this.toggleChanges()}
              aria-label="Working tree changes"
              aria-pressed=${this.showChanges ? "true" : "false"}
              title="Working tree changes"
            >
              Δ
            </button>
            <button
              class="hd-btn"
              @click=${() => this.toggleCompare()}
              aria-label="Compare branches"
              aria-pressed=${this.comparing ? "true" : "false"}
              title="Compare branches"
            >
              ⇄
            </button>
            ${this.comparing || this.showChanges
              ? nothing
              : html` <button
                  class="focus-btn"
                  @click=${this.onToggleFocus}
                  aria-label=${this.focused ? "Show file tree" : "Hide file tree"}
                  aria-pressed=${this.focused ? "true" : "false"}
                >
                  ${this.focused ? "◀" : "▶"}
                </button>`}
          </div>

          <ul class="entries" @keydown=${this.onTreeKeydown}>
            ${this.renderNodes(s.roots, 0)}
          </ul>
        </aside>

        <section>
          ${this.showCity
            ? html`<gc-code-city .repoId=${s.repo.id} .branch=${this.branch}></gc-code-city>`
            : this.showChanges
              ? html`<gc-changes-view .repoId=${s.repo.id}></gc-changes-view>`
              : this.comparing
                ? html`<gc-compare-view
                    .repoId=${s.repo.id}
                    .baseRef=${this.baseRef}
                    .headRef=${this.headRef}
                  ></gc-compare-view>`
                : html`<gc-file-view
                    .repoId=${s.repo.id}
                    .path=${this.selectedFile}
                    .branch=${this.branch}
                    .initialBlame=${this.initialBlame}
                  ></gc-file-view>`}
        </section>
      </div>
    `;
  }

  private onTreeKeydown = (e: KeyboardEvent) => {
    const btn = (e.target as HTMLElement).closest?.(".entry") as HTMLElement | null;
    if (!btn) return;
    const all = [...this.renderRoot.querySelectorAll<HTMLElement>(".entry")];
    const idx = all.indexOf(btn);
    if (idx < 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[idx + 1]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      all[idx - 1]?.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (btn.classList.contains("dir")) {
        // If next visible entry is a child (inside nested ul), dir is open → move into it.
        // Otherwise dir is closed → expand it.
        const next = all[idx + 1];
        const isChild = btn
          .closest("li")
          ?.querySelector("ul.nested")
          ?.contains(next ?? null);
        if (next && isChild) {
          next.focus();
        } else {
          btn.click();
        }
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      // Dir that's open → collapse. Otherwise → move to parent dir.
      const isOpenDir =
        btn.classList.contains("dir") && btn.closest("li")?.querySelector("ul.nested");
      if (isOpenDir) {
        btn.click();
      } else {
        const parentUl = btn.closest("ul.nested");
        if (parentUl) {
          const parent = parentUl.parentElement?.querySelector(
            ":scope > .entry",
          ) as HTMLElement | null;
          parent?.focus();
        }
      }
    }
  };

  private renderNodes(nodes: TreeNode[], depth: number): unknown {
    return nodes.map((node) => {
      const indent = `padding-left: ${0.95 + depth * 0.85}rem`;
      if (node.type === EntryType.DIR) {
        return html`
          <li>
            <button class="entry dir" style=${indent} @click=${() => this.toggleDir(node)}>
              <span class="icon">${node.open ? "▾" : "▸"}</span>
              ${node.name} ${node.loading ? html`<gc-spinner></gc-spinner>` : nothing}
            </button>
            ${node.open && node.children
              ? html`<ul class="entries nested">
                  ${this.renderNodes(node.children, depth + 1)}
                </ul>`
              : nothing}
          </li>
        `;
      }
      const isSelected = node.fullPath === this.selectedFile;
      return html`
        <li>
          <button
            class="entry file ${isSelected ? "selected" : ""}"
            style=${indent}
            @click=${() => this.selectFile(node)}
          >
            <span class="icon">·</span>
            ${node.name}
          </button>
        </li>
      `;
    });
  }

  static override styles = css`
    :host([hidden]) {
      display: none !important;
    }
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
    .layout.comparing {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    .layout.comparing aside {
      border-right: none;
      border-bottom: none;
    }
    .layout.comparing aside .entries {
      display: none;
    }
    .layout.comparing section {
      min-height: 0;
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
    section > gc-file-view,
    section > gc-compare-view,
    section > gc-changes-view,
    section > gc-code-city {
      flex: 1;
      min-height: 0;
    }
    .focus-btn {
      margin-left: auto;
      padding: var(--space-1);
      background: transparent;
      color: var(--text);
      border: none;
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.35;
    }
    .focus-btn:hover {
      opacity: 0.9;
    }
    .focus-btn:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .hd-btn {
      padding: var(--space-1);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.5;
      line-height: 1;
    }
    .hd-btn:hover {
      opacity: 1;
      background: var(--surface-2);
    }
    .hd-btn:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .hd-btn[aria-pressed="true"] {
      opacity: 1;
      background: var(--surface-3);
      border-color: var(--accent-user);
    }
    .ref-select {
      min-width: 60px;
      max-width: 200px;
      height: 24px;
      padding: 0 var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 6px center;
      padding-right: 20px;
    }
    .ref-select:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .swap-btn {
      border: none;
      opacity: 0.35;
      font-size: 0.7rem;
      padding: 0 2px;
    }
    .swap-btn:hover {
      opacity: 0.7;
      background: transparent;
    }
    .repo-hd {
      padding: 0 0.95rem;
      height: 36px;
      border-bottom: 1px solid var(--border-default);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      background: var(--surface-1);
      box-sizing: border-box;
      overflow: hidden;
    }
    .label {
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .branch {
      opacity: 0.55;
      font-size: 0.72rem;
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
    .entry:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: -2px;
    }
    .entry.dir {
      color: var(--accent-user);
    }
    .entry.selected {
      background: var(--surface-3);
    }
    .entries.nested {
      padding: 0;
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
    .drawer-toggle {
      display: none;
    }
    .drawer-backdrop {
      display: none;
    }
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .drawer-toggle {
        display: block;
        position: fixed;
        bottom: var(--space-5);
        left: var(--space-4);
        z-index: 30;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--border-default);
        font-size: 1.1rem;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }
      aside {
        position: fixed;
        top: 44px;
        left: 0;
        bottom: 0;
        width: 280px;
        z-index: 40;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        border-right: 1px solid var(--surface-4);
      }
      .drawer-open aside {
        transform: translateX(0);
      }
      .drawer-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 35;
      }
      .drawer-open .drawer-backdrop {
        display: block;
      }
    }
  `;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
