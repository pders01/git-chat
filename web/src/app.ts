import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authClient, repoClient, chatClient } from "./lib/transport.js";
import { AuthMode } from "./gen/gitchat/v1/auth_pb.js";
import type { Repo } from "./gen/gitchat/v1/repo_pb.js";
import "./components/pairing-view.js";
import "./components/repo-browser.js";
import "./components/chat-view.js";
import "./components/commit-log.js";
import "./components/toast.js";
import "./components/kb-view.js";
import "./components/loading-indicator.js";
import "./components/settings-panel.js";
import * as settings from "./lib/settings.js";
import { readFocus, writeFocus } from "./lib/focus.js";
import {
  type Tab,
  type ParsedRoute,
  type NavState,
  parseRoute,
  buildRoute,
  routesEqual,
  clearStaleState,
  normalizeBrowseState,
} from "./lib/routing.js";

type AppState =
  | { phase: "booting" }
  | { phase: "local-claiming" }
  | { phase: "unauthenticated" }
  | {
      phase: "authenticated";
      principal: string;
      mode: AuthMode;
      repos: Repo[];
      selectedRepo: string;
      tab: Tab;
    }
  | { phase: "error"; message: string };

@customElement("gc-app")
export class GcApp extends LitElement {
  @state() private state: AppState = { phase: "booting" };
  @state() private showShortcuts = false;
  @state() private showSettings = false;
  @state() private showSearch = false;
  @state() private searchQuery = "";
  @state() private searchResults: Array<{
    source: string;
    id: string;
    title: string;
    body: string;
  }> = [];
  @state() private searchSelectedIdx = -1;
  @state() private showPalette = false;
  @state() private paletteQuery = "";
  @state() private paletteSelectedIdx = 0;
  @state() private currentBranch = ""; // empty = repo default branch
  @state() private branches: Array<{ name: string }> = [];

  // Parent→child command bindings (properties-down per Lit guidance).
  // Each carries a monotonic nonce so the same payload can re-fire;
  // the child reacts in updated() when the nonce changes.
  @state() private pendingPrefill: { text: string; nonce: number } | null = null;
  @state() private pendingFileMention: { path: string; nonce: number } | null = null;
  @state() private newChatNonce = 0;
  @state() private focusNonce = 0;
  private prefillNonce = 0;
  private fileMentionNonce = 0;

  // Deep-link routing state
  private currentRoute: ParsedRoute = { repoId: "", tab: "chat" };
  private _routing = false;
  private _paletteScrollRafId: number | null = null;

  override async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHashChange);
    window.addEventListener("popstate", this.onHashChange);
    window.addEventListener("keydown", this.onGlobalKeydown);
    this.addEventListener("gc:nav", this.onNavEvent as EventListener);
    this.addEventListener("gc:ask-about", this.onAskAbout as EventListener);
    this.addEventListener("gc:view-commit", this.onViewCommit as EventListener);
    this.addEventListener("gc:open-file", this.onOpenFile as EventListener);
    this.addEventListener("gc:view-file-history", this.onViewFileHistory as EventListener);
    this.addEventListener("gc:explain-in-chat", this.onExplainInChat as EventListener);
    await this.boot();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHashChange);
    window.removeEventListener("popstate", this.onHashChange);
    window.removeEventListener("keydown", this.onGlobalKeydown);
    this.removeEventListener("gc:nav", this.onNavEvent as EventListener);
    this.removeEventListener("gc:ask-about", this.onAskAbout as EventListener);
    this.removeEventListener("gc:view-commit", this.onViewCommit as EventListener);
    this.removeEventListener("gc:open-file", this.onOpenFile as EventListener);
    this.removeEventListener("gc:view-file-history", this.onViewFileHistory as EventListener);
    this.removeEventListener("gc:explain-in-chat", this.onExplainInChat as EventListener);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    // Cancel any pending RAF to prevent memory leaks
    if (this._paletteScrollRafId !== null) {
      cancelAnimationFrame(this._paletteScrollRafId);
      this._paletteScrollRafId = null;
    }
  }

  // Bridge: any view can dispatch gc:ask-about to switch to chat
  // and pre-fill the composer with a prompt. Used by log ("explain
  // this commit") and browse ("ask about this file").
  private onAskAbout = (e: CustomEvent<{ prompt: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.switchTab("chat");
    this.prefillChat(e.detail.prompt);
  };

  // Bridge: blame tooltip "view in log" dispatches gc:view-commit
  // to switch to the log tab and select the commit.
  private onViewCommit = (e: CustomEvent<{ sha: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.navigateTo({ tab: "log", commitSha: e.detail.sha });
  };

  // Bridge: any view can dispatch gc:open-file to switch to browse
  // tab and open a specific file.
  private onOpenFile = (e: CustomEvent<{ path: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.navigateTo({ tab: "browse", filePath: e.detail.path, browseView: "file" });
  };

  // Bridge: file-view "history" button dispatches gc:view-file-history
  // to switch to log tab and filter by file path.
  private onViewFileHistory = (e: CustomEvent<{ path: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.navigateTo({ tab: "log", filterPath: e.detail.path });
  };

  // Bridge: code-city and other views dispatch gc:explain-in-chat
  // to switch to chat tab and insert a file mention.
  private onExplainInChat = (e: CustomEvent<{ path: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.navigateTo({ tab: "chat" });
    this.pendingFileMention = { path: e.detail.path, nonce: ++this.fileMentionNonce };
  };

  // Previously-focused element for each overlay, captured when opened
  // so focus returns to the trigger on close (keyboard / screen-reader
  // users rely on this to resume navigation in context).
  private _prevFocusBySource: Record<
    "settings" | "shortcuts" | "palette" | "search",
    HTMLElement | null
  > = { settings: null, shortcuts: null, palette: null, search: null };

  // ── Modal focus management ───────────────────────────────────
  override async updated(changed: Map<string, unknown>) {
    this.handleOverlay(changed, "showSettings", "settings", "gc-settings-panel");
    this.handleOverlay(changed, "showShortcuts", "shortcuts", ".modal");
    this.handleOverlay(changed, "showPalette", "palette", ".palette-input");
    this.handleOverlay(changed, "showSearch", "search", ".search-input");
  }

  private handleOverlay(
    changed: Map<string, unknown>,
    prop: "showSettings" | "showShortcuts" | "showPalette" | "showSearch",
    key: "settings" | "shortcuts" | "palette" | "search",
    focusSelector: string,
  ) {
    if (!changed.has(prop)) return;
    const open = this[prop] as boolean;
    if (open) {
      // Capture the current focus BEFORE the overlay steals it.
      this._prevFocusBySource[key] = (document.activeElement as HTMLElement | null) ?? null;
      void this.updateComplete.then(() => {
        const target =
          this.renderRoot.querySelector<HTMLElement>(focusSelector) ??
          (this.renderRoot.querySelector(".modal") as HTMLElement | null);
        target?.focus();
      });
    } else {
      const prev = this._prevFocusBySource[key];
      this._prevFocusBySource[key] = null;
      if (prev && document.contains(prev)) {
        // rAF so restore happens after the overlay is actually gone.
        requestAnimationFrame(() => prev.focus());
      }
    }
  }

  private trapFocus = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const modal = e.currentTarget as HTMLElement;
    const focusable = modal.querySelectorAll<HTMLElement>("button, input, select, [tabindex]");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = (this.renderRoot as ShadowRoot).activeElement ?? document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ── Global keyboard shortcuts ────────────────────────────────
  private onGlobalKeydown = (e: KeyboardEvent) => {
    if (this.state.phase !== "authenticated") return;
    // ? opens shortcut help (no modifier needed).
    const origin = e.composedPath()[0];
    if (
      e.key === "?" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !(origin instanceof HTMLTextAreaElement) &&
      !(origin instanceof HTMLInputElement)
    ) {
      e.preventDefault();
      this.showShortcuts = !this.showShortcuts;
      return;
    }
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      (this.showShortcuts || this.showSettings || this.showPalette || this.showSearch)
    ) {
      this.showShortcuts = false;
      this.showSettings = false;
      this.showSearch = false;
      if (this.showPalette) {
        // Cancel pending scroll RAF when closing palette
        if (this._paletteScrollRafId !== null) {
          cancelAnimationFrame(this._paletteScrollRafId);
          this._paletteScrollRafId = null;
        }
        this.showPalette = false;
        this.paletteQuery = "";
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    switch (e.key) {
      case "k":
        e.preventDefault();
        this.showPalette = !this.showPalette;
        if (!this.showPalette) this.paletteQuery = "";
        break;
      case "1":
        e.preventDefault();
        this.switchTab("chat");
        break;
      case "2":
        e.preventDefault();
        this.switchTab("browse");
        break;
      case "3":
        e.preventDefault();
        this.switchTab("log");
        break;
      case "4":
        e.preventDefault();
        this.switchTab("kb");
        break;
      case "\\":
        e.preventDefault();
        this.toggleFocus();
        break;
      case "f":
        // ⌘F → global search
        e.preventDefault();
        this.showSearch = !this.showSearch;
        if (this.showSearch) {
          requestAnimationFrame(() => {
            const input = this.renderRoot.querySelector<HTMLInputElement>(".search-input");
            input?.focus();
          });
        }
        break;
    }
  };

  // Toggle focus mode across all views that support it.
  // lib/focus.ts is the source of truth (shared across tabs via
  // localStorage and also written by an in-chat button). The nonce
  // signals focus-aware children to re-read on the next render.
  private toggleFocus() {
    writeFocus(!readFocus());
    this.focusNonce++;
  }

  // Create a new chat session.
  private newChat() {
    this.switchTab("chat");
    this.newChatNonce++;
  }

  // boot decides which auth flow applies: if the URL carries a ?t= param,
  // we're in local mode and trade it for a cookie; otherwise we ask Whoami
  // and either show the authenticated view or the pairing view.
  private async boot() {
    const url = new URL(window.location.href);
    const localToken = url.searchParams.get("t");

    if (localToken) {
      this.state = { phase: "local-claiming" };
      try {
        await authClient.localClaim({ token: localToken });
        // Strip ?t= from the URL so the token doesn't linger in history.
        url.searchParams.delete("t");
        window.history.replaceState(null, "", url.toString());
      } catch (e) {
        this.state = { phase: "error", message: messageOf(e) };
        return;
      }
    }

    try {
      const who = await authClient.whoami({});
      if (who.principal) {
        await this.enterAuthenticated(who.principal, who.mode);
      } else {
        this.state = { phase: "unauthenticated" };
      }
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  // enterAuthenticated is called from two paths (boot after Whoami, and
  // onPaired after the pairing stream completes). It fetches the repo
  // list once and lands the user on the chat tab of the first repo.
  private async enterAuthenticated(principal: string, mode: AuthMode) {
    try {
      const list = await repoClient.listRepos({});
      const repos = list.repos;
      const parsed = parseRoute(new URL(window.location.href));
      const validRepo =
        parsed.repoId && repos.some((r) => r.id === parsed.repoId)
          ? parsed.repoId
          : (repos[0]?.id ?? "");
      parsed.repoId = validRepo;
      this.state = {
        phase: "authenticated",
        principal,
        mode,
        repos,
        selectedRepo: validRepo,
        tab: parsed.tab,
      };
      // Force-write the initial URL (applyRoute guards against no-ops,
      // so set currentRoute after to avoid the equality check).
      const url = buildRoute(parsed);
      if (window.location.hash !== url) {
        window.history.pushState(null, "", url);
      }
      this.currentRoute = parsed;
      // Load branches for the selected repo.
      void this.loadBranches(validRepo);
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async logout() {
    try {
      await authClient.logout({});
    } finally {
      this.state = { phase: "unauthenticated" };
    }
  }

  private onPaired = async (e: Event) => {
    const detail = (e as CustomEvent<{ principal: string }>).detail;
    await this.enterAuthenticated(detail.principal, AuthMode.PAIRED);
  };

  private switchTab(tab: Tab) {
    if (this.state.phase !== "authenticated") return;
    this.state = { ...this.state, tab };
    this.navigateTo({ tab });
    // Move focus to newly-active tab for keyboard users.
    requestAnimationFrame(() => {
      const btn = this.renderRoot.querySelector<HTMLElement>(`#tab-${tab}`);
      btn?.focus();
    });
  }

  // WAI-ARIA tabs pattern: left/right arrow keys move between tabs.
  private onTabKeydown = (e: KeyboardEvent) => {
    const tabs: Tab[] = ["chat", "browse", "log", "kb"];
    if (this.state.phase !== "authenticated") return;
    const current = tabs.indexOf(this.state.tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next =
        e.key === "ArrowRight"
          ? tabs[(current + 1) % tabs.length]!
          : tabs[(current - 1 + tabs.length) % tabs.length]!;
      this.switchTab(next);
    }
  };

  private switchRepo(repoId: string) {
    if (this.state.phase !== "authenticated") return;
    this.state = { ...this.state, selectedRepo: repoId };
    // Clear browse view state — city/compare refs belong to the old repo.
    this.navigateTo({
      repoId,
      tab: this.state.tab,
      browseView: undefined,
      compareBase: undefined,
      compareHead: undefined,
      filePath: undefined,
      blame: undefined,
    });
    // Reset branch and reload branches for the new repo.
    this.currentBranch = "";
    void this.loadBranches(repoId);
  }

  private async loadBranches(repoId: string) {
    if (!repoId) return;
    try {
      const resp = await repoClient.listBranches({ repoId });
      this.branches = resp.branches;
      // Find the repo's default branch and select it.
      if (this.state.phase === "authenticated") {
        const repo = this.state.repos.find((r) => r.id === repoId);
        const defaultBranch = repo?.defaultBranch || this.branches[0]?.name || "";
        this.currentBranch = defaultBranch;
      }
    } catch {
      this.branches = [];
      this.currentBranch = "";
    }
  }

  // ── Deep-link routing ────────────────────────────────────────
  // Shape: #/{repoId}/{tab}[/{subPath}]?{queryParams}

  private navigateTo(partial: Partial<ParsedRoute>) {
    if (this._routing) return;
    let base = { ...this.currentRoute };
    if (partial.tab && partial.tab !== base.tab) {
      base = clearStaleState({ repoId: base.repoId, tab: partial.tab });
    }
    const next = normalizeBrowseState({ ...base, ...partial });
    this.applyRoute(next);
  }

  private applyRoute(route: ParsedRoute) {
    if (routesEqual(route, this.currentRoute) && this.currentRoute.repoId) return;
    this.currentRoute = route;
    // Keep AppState.tab in sync so the tab panel visibility updates.
    if (this.state.phase === "authenticated" && this.state.tab !== route.tab) {
      this.state = { ...this.state, tab: route.tab };
    }
    const url = buildRoute(route);
    if (window.location.hash !== url) {
      window.history.pushState(null, "", url);
    }
    this.requestUpdate();
  }

  private onHashChange = () => {
    if (this.state.phase !== "authenticated") return;
    const parsed = parseRoute(new URL(window.location.href));
    const { repos } = this.state;
    const validRepo = parsed.repoId && repos.some((r) => r.id === parsed.repoId);
    if (!validRepo) parsed.repoId = this.state.selectedRepo;
    this._routing = true;
    this.currentRoute = parsed;
    this.state = {
      ...this.state,
      selectedRepo: parsed.repoId,
      tab: parsed.tab,
    };
    this._routing = false;
  };

  private onNavEvent = (e: Event) => {
    if (this._routing || this.state.phase !== "authenticated") return;
    const detail = (e as CustomEvent<NavState>).detail;
    if (detail.tab && detail.tab !== this.state.tab) {
      this.state = { ...this.state, tab: detail.tab };
    }
    this.navigateTo(detail);
  };

  override render() {
    if (this.state.phase === "authenticated") {
      return this.renderAuthenticated();
    }
    return html`
      <div class="card">
        <header>
          <h1>git-chat</h1>
          <p class="sub">chat · browse · log · knowledge base</p>
        </header>
        ${this.renderBody()}
      </div>
    `;
  }

  private renderAuthenticated() {
    if (this.state.phase !== "authenticated") return null;
    const { principal, mode, tab, selectedRepo, repos } = this.state;
    const modeLabel = mode === AuthMode.LOCAL ? "local" : "paired";
    const multiRepo = repos.length > 1;
    return html`
      <a class="skip-link" href="#main-content">Skip to content</a>
      <div class="shell">
        <header class="shell-hd" role="banner">
          <div class="brand">
            <span class="logo">git-chat</span>
            ${multiRepo
              ? html`
                  <select
                    class="repo-select"
                    .value=${selectedRepo}
                    aria-label="Select repository"
                    @change=${(e: Event) => this.switchRepo((e.target as HTMLSelectElement).value)}
                  >
                    ${repos.map(
                      (r) =>
                        html`<option value=${r.id} ?selected=${r.id === selectedRepo}>
                          ${r.label}
                        </option>`,
                    )}
                  </select>
                `
              : nothing}
            ${this.branches.length > 0
              ? html`
                  <select
                    class="branch-select"
                    .value=${this.currentBranch}
                    aria-label="Select branch"
                    @change=${(e: Event) => {
                      this.currentBranch = (e.target as HTMLSelectElement).value;
                    }}
                  >
                    ${this.branches.map(
                      (b) =>
                        html`<option value=${b.name} ?selected=${b.name === this.currentBranch}>
                          ${b.name}
                        </option>`,
                    )}
                  </select>
                `
              : nothing}
            <nav class="tabs" role="tablist" aria-label="Views">
              <button
                role="tab"
                id="tab-chat"
                class="tab ${tab === "chat" ? "active" : ""}"
                aria-selected=${tab === "chat" ? "true" : "false"}
                aria-controls="panel-main"
                tabindex=${tab === "chat" ? "0" : "-1"}
                @click=${() => this.switchTab("chat")}
                @keydown=${this.onTabKeydown}
              >
                chat
              </button>
              <button
                role="tab"
                id="tab-browse"
                class="tab ${tab === "browse" ? "active" : ""}"
                aria-selected=${tab === "browse" ? "true" : "false"}
                aria-controls="panel-main"
                tabindex=${tab === "browse" ? "0" : "-1"}
                @click=${() => this.switchTab("browse")}
                @keydown=${this.onTabKeydown}
              >
                browse
              </button>
              <button
                role="tab"
                id="tab-log"
                class="tab ${tab === "log" ? "active" : ""}"
                aria-selected=${tab === "log" ? "true" : "false"}
                aria-controls="panel-main"
                tabindex=${tab === "log" ? "0" : "-1"}
                @click=${() => this.switchTab("log")}
                @keydown=${this.onTabKeydown}
              >
                log
              </button>
              <button
                role="tab"
                id="tab-kb"
                class="tab ${tab === "kb" ? "active" : ""}"
                aria-selected=${tab === "kb" ? "true" : "false"}
                aria-controls="panel-main"
                tabindex=${tab === "kb" ? "0" : "-1"}
                @click=${() => this.switchTab("kb")}
                @keydown=${this.onTabKeydown}
              >
                kb
              </button>
            </nav>
          </div>
          <div class="who">
            <span class="principal">${principal}</span>
            <span class="dot">·</span>
            <span class="mode">${modeLabel}</span>
            <button
              class="settings-btn"
              @click=${() => {
                this.showSettings = !this.showSettings;
              }}
              aria-label="Settings"
              title="Settings"
            >
              ⚙
            </button>
            <button class="logout" @click=${() => this.logout()} aria-label="Log out">
              logout
            </button>
          </div>
        </header>
        <main class="shell-main" id="main-content">
          <gc-chat-view
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            .initialSessionId=${this.currentRoute.sessionId ?? ""}
            .pendingPrefill=${this.pendingPrefill}
            .pendingFileMention=${this.pendingFileMention}
            .newChatNonce=${this.newChatNonce}
            .focusNonce=${this.focusNonce}
            class="tab-panel"
            ?hidden=${tab !== "chat"}
          ></gc-chat-view>
          <gc-repo-browser
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            .initialFilePath=${this.currentRoute.filePath ?? ""}
            .initialBlame=${this.currentRoute.blame ?? false}
            .initialBrowseView=${this.currentRoute.browseView ?? "file"}
            .initialCompareBase=${this.currentRoute.compareBase ?? ""}
            .initialCompareHead=${this.currentRoute.compareHead ?? ""}
            .focusNonce=${this.focusNonce}
            class="tab-panel"
            ?hidden=${tab !== "browse"}
          ></gc-repo-browser>
          <gc-commit-log
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            .initialCommitSha=${this.currentRoute.commitSha ?? ""}
            .initialLogFile=${this.currentRoute.logFile ?? ""}
            .initialSplitView=${this.currentRoute.splitView ?? false}
            .initialLogView=${this.currentRoute.logView ?? "commits"}
            .filterPath=${this.currentRoute.filterPath ?? ""}
            .focusNonce=${this.focusNonce}
            class="tab-panel"
            ?hidden=${tab !== "log"}
          ></gc-commit-log>
          <gc-kb-view
            .repoId=${selectedRepo}
            .initialCardId=${this.currentRoute.cardId ?? ""}
            class="tab-panel"
            ?hidden=${tab !== "kb"}
          ></gc-kb-view>
        </main>
      </div>
      ${this.showShortcuts ? this.renderShortcutsModal() : nothing}
      <gc-settings-panel
        .open=${this.showSettings}
        @gc:close=${() => {
          this.showSettings = false;
        }}
      ></gc-settings-panel>
      ${this.showSearch ? this.renderSearchOverlay() : nothing}
      ${this.showPalette ? this.renderCommandPalette() : nothing}
      <gc-toast></gc-toast>
    `;
  }

  private renderShortcutsModal() {
    const isMac = navigator.platform.includes("Mac");
    const mod = isMac ? "⌘" : "Ctrl+";
    const shortcuts = [
      [mod + "K", "Command palette"],
      [mod + "1", "Chat tab"],
      [mod + "2", "Browse tab"],
      [mod + "3", "Log tab"],
      [mod + "\\", "Toggle focus"],
      [mod + "F", "Global search"],
      ["/", "Focus composer"],
      ["Esc", "Blur / close modal"],
      ["↑ ↓", "Navigate sessions"],
      ["← →", "Switch tabs (when focused)"],
      [mod + "↵", "Send message"],
      ["?", "Toggle this help"],
    ];
    return html`
      <div class="modal-backdrop" @click=${() => (this.showShortcuts = false)}>
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${this.trapFocus}
        >
          <h2 class="modal-title">Keyboard shortcuts</h2>
          <dl class="shortcut-list">
            ${shortcuts.map(
              ([key, desc]) => html`
                <div class="shortcut-row">
                  <dt><kbd>${key}</kbd></dt>
                  <dd>${desc}</dd>
                </div>
              `,
            )}
          </dl>
          <p class="modal-hint">press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>
        </div>
      </div>
    `;
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private onSearchInput(e: Event) {
    const q = (e.target as HTMLInputElement).value;
    this.searchQuery = q;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!q.trim()) {
      this.searchResults = [];
      return;
    }
    // Debounce 100ms for snappy feel.
    this.searchTimer = setTimeout(() => void this.runSearch(q), 100);
  }

  private async runSearch(query: string) {
    if (this.state.phase !== "authenticated") return;
    try {
      const resp = await chatClient.search({
        query,
        repoId: this.state.selectedRepo,
        limit: 10,
      });
      this.searchSelectedIdx = 0;
      this.searchResults = resp.hits.map((h) => ({
        source: h.source,
        id: h.id,
        title: h.title,
        body: h.body,
      }));
    } catch {
      this.searchResults = [];
    }
  }

  private onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.showSearch = false;
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.searchSelectedIdx = Math.min(this.searchSelectedIdx + 1, this.searchResults.length - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.searchSelectedIdx = Math.max(this.searchSelectedIdx - 1, 0);
      return;
    }
    if (e.key === "Enter" && this.searchSelectedIdx >= 0) {
      e.preventDefault();
      this.activateSearchResult(this.searchResults[this.searchSelectedIdx]!);
    }
  }

  private activateSearchResult(r: { source: string; id: string; title: string }) {
    this.showSearch = false;
    if (this.state.phase !== "authenticated") return;

    switch (r.source) {
      case "file":
        this.navigateTo({ tab: "browse", filePath: r.id, browseView: "file" });
        break;
      case "message":
        this.navigateTo({ tab: "chat", sessionId: r.id });
        break;
      case "card":
        this.switchTab("chat");
        this.prefillChat(r.title);
        break;
    }
  }

  private prefillChat(text: string) {
    this.pendingPrefill = { text, nonce: ++this.prefillNonce };
  }

  // ── Command palette ──────────────────────────────────────────

  private paletteActions(): Array<{ id: string; label: string; hint: string; action: () => void }> {
    const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
    const base = [
      { id: "new-chat", label: "New Chat", hint: `${mod}K`, action: () => this.newChat() },
      {
        id: "goto-chat",
        label: "Go to Chat",
        hint: `${mod}1`,
        action: () => this.switchTab("chat"),
      },
      {
        id: "goto-browse",
        label: "Go to Browse",
        hint: `${mod}2`,
        action: () => this.switchTab("browse"),
      },
      { id: "goto-log", label: "Go to Log", hint: `${mod}3`, action: () => this.switchTab("log") },
      {
        id: "goto-kb",
        label: "Go to Knowledge Base",
        hint: `${mod}4`,
        action: () => this.switchTab("kb"),
      },
    ];

    base.push(
      {
        id: "toggle-focus",
        label: "Toggle Focus Mode",
        hint: `${mod}\\`,
        action: () => this.toggleFocus(),
      },
      {
        id: "open-search",
        label: "Open Search",
        hint: `${mod}F`,
        action: () => {
          this.showSearch = true;
        },
      },
      {
        id: "theme-light",
        label: "Set Theme: Light",
        hint: "",
        action: () => settings.setTheme("light"),
      },
      {
        id: "theme-dark",
        label: "Set Theme: Dark",
        hint: "",
        action: () => settings.setTheme("dark"),
      },
      {
        id: "theme-system",
        label: "Set Theme: System",
        hint: "",
        action: () => settings.setTheme("system"),
      },
      {
        id: "open-settings",
        label: "Open Settings",
        hint: "",
        action: () => {
          this.showSettings = true;
        },
      },
      {
        id: "shortcuts-help",
        label: "Show Shortcuts",
        hint: "?",
        action: () => {
          this.showShortcuts = true;
        },
      },
    );

    // Add repo switch actions at the bottom if multiple repos available
    if (this.state.phase === "authenticated" && this.state.repos?.length > 1) {
      for (const repo of this.state.repos) {
        const isCurrent = repo.id === this.state.selectedRepo;
        base.push({
          id: `switch-repo-${repo.id}`,
          label: `Switch to: ${repo.label}${isCurrent ? " (current)" : ""}`,
          hint: "",
          action: () => this.switchRepo(repo.id),
        });
      }
    }

    return base;
  }

  private onPaletteKeydown(filtered: Array<{ action: () => void }>, e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.showPalette = false;
      this.paletteQuery = "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.paletteSelectedIdx = Math.min(this.paletteSelectedIdx + 1, filtered.length - 1);
      this.scrollPaletteSelectionIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.paletteSelectedIdx = Math.max(this.paletteSelectedIdx - 1, 0);
      this.scrollPaletteSelectionIntoView();
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      filtered[this.paletteSelectedIdx].action();
      this.showPalette = false;
      this.paletteQuery = "";
    }
  }

  private scrollPaletteSelectionIntoView() {
    // Cancel any pending RAF to prevent memory leaks
    if (this._paletteScrollRafId !== null) {
      cancelAnimationFrame(this._paletteScrollRafId);
    }
    // Wait for render update then scroll selected item into view
    this._paletteScrollRafId = requestAnimationFrame(() => {
      this._paletteScrollRafId = null;
      const palette = this.renderRoot.querySelector(".palette");
      const selected = palette?.querySelector(".palette-item.selected");
      selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  private renderCommandPalette() {
    const q = this.paletteQuery.trim().toLowerCase();
    const filtered = this.paletteActions().filter((a) => !q || a.label.toLowerCase().includes(q));
    const idx = Math.min(this.paletteSelectedIdx, Math.max(0, filtered.length - 1));
    if (idx !== this.paletteSelectedIdx) this.paletteSelectedIdx = idx;

    return html`
      <div
        class="search-backdrop"
        @click=${() => {
          this.showPalette = false;
          this.paletteQuery = "";
        }}
      ></div>
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        @keydown=${this.trapFocus}
      >
        <input
          class="palette-input"
          type="text"
          placeholder="Type a command…"
          .value=${this.paletteQuery}
          @input=${(e: Event) => {
            this.paletteQuery = (e.target as HTMLInputElement).value;
            this.paletteSelectedIdx = 0;
          }}
          @keydown=${(e: KeyboardEvent) => this.onPaletteKeydown(filtered, e)}
        />
        <ul class="palette-list" role="listbox">
          ${filtered.map(
            (a, i) => html`
              <li
                class="palette-item ${i === idx ? "selected" : ""}"
                role="option"
                aria-selected=${i === idx}
                @click=${() => {
                  a.action();
                  this.showPalette = false;
                  this.paletteQuery = "";
                }}
                @mouseenter=${() => {
                  this.paletteSelectedIdx = i;
                }}
              >
                <span class="palette-label">${a.label}</span>
                ${a.hint ? html`<kbd>${a.hint}</kbd>` : nothing}
              </li>
            `,
          )}
          ${filtered.length === 0
            ? html`<li class="palette-item">no matching commands</li>`
            : nothing}
        </ul>
        <div class="search-hint">↑↓ navigate · ↵ run · esc close</div>
      </div>
    `;
  }

  private renderSearchOverlay() {
    const sourceLabels: Record<string, string> = {
      card: "knowledge base",
      message: "chat history",
      file: "files",
    };
    return html`
      <div class="search-backdrop" @click=${() => (this.showSearch = false)}></div>
      <div
        class="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        @keydown=${this.trapFocus}
      >
        <input
          class="search-input"
          type="search"
          placeholder="Search files, chats, knowledge cards…"
          .value=${this.searchQuery}
          @input=${(e: Event) => this.onSearchInput(e)}
          @keydown=${(e: KeyboardEvent) => this.onSearchKeydown(e)}
          aria-label="Global search"
          aria-controls="search-results-list"
          aria-activedescendant=${this.searchSelectedIdx >= 0
            ? `search-hit-${this.searchSelectedIdx}`
            : ""}
          role="combobox"
          aria-expanded=${this.searchResults.length > 0 ? "true" : "false"}
          autocomplete="off"
        />
        ${this.searchResults.length > 0
          ? html`<ul class="search-results" id="search-results-list" role="listbox">
              ${this.searchResults.map(
                (r, i) => html`
                  <li
                    class="search-hit ${i === this.searchSelectedIdx ? "selected" : ""}"
                    id="search-hit-${i}"
                    role="option"
                    aria-selected=${i === this.searchSelectedIdx ? "true" : "false"}
                    @click=${() => this.activateSearchResult(r)}
                    @mouseenter=${() => {
                      this.searchSelectedIdx = i;
                    }}
                  >
                    <span class="hit-source">${sourceLabels[r.source] ?? r.source}</span>
                    <span class="hit-title">${r.title}</span>
                    ${r.body
                      ? html`<span class="hit-body">${r.body.slice(0, 120)}</span>`
                      : nothing}
                  </li>
                `,
              )}
            </ul>`
          : this.searchQuery.trim()
            ? html`<p class="search-empty">no results</p>`
            : nothing}
        <div class="search-hint">↑↓ navigate · ↵ open · esc close</div>
      </div>
    `;
  }

  private renderBody() {
    switch (this.state.phase) {
      case "booting":
        return html`<p class="hint">checking session…</p>`;
      case "local-claiming":
        return html`<p class="hint">claiming local session…</p>`;
      case "unauthenticated":
        return html` <gc-pairing-view @paired=${this.onPaired}></gc-pairing-view> `;
      case "error":
        return html`<div class="err">${this.state.message}</div>`;
    }
    return null;
  }

  static override styles = css`
    :host {
      /* The app is the viewport — a flex column with a fixed-height
         header and a main area that fills the rest. min-height:0 on
         the main area is critical: without it, content taller than
         100vh would push main past the viewport and the nested chat
         scroll region would stop scrolling. This is the chain that
         the previous layout got wrong. */
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      color: var(--text);
    }

    /* ── Skip-to-content link ───────────────────────────────────── */
    .skip-link {
      position: absolute;
      top: -100%;
      left: var(--space-4);
      padding: var(--space-2) var(--space-4);
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      z-index: 100;
      font-size: var(--text-sm);
      text-decoration: none;
    }
    .skip-link:focus {
      top: var(--space-2);
    }

    /* ── Unauthenticated / booting: centered card layout ─────────── */
    .card {
      max-width: 720px;
      margin: 4rem auto;
      padding: var(--space-7);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--surface-2);
    }
    .card header {
      margin-bottom: 1.75rem;
    }
    .card h1 {
      margin: 0 0 var(--space-1);
      font-weight: 500;
      font-size: 1.25rem;
      letter-spacing: -0.01em;
    }
    .sub {
      margin: 0;
      opacity: 0.55;
      font-size: 0.8rem;
    }
    .hint {
      font-size: 0.85rem;
      opacity: 0.55;
      margin: 0;
    }
    .err {
      font-size: 0.85rem;
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--danger-border);
      border-radius: 4px;
      background: var(--danger-bg);
      color: var(--danger);
    }

    /* ── Authenticated: full-viewport shell ───────────────────────── */
    .shell {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: var(--surface-1);
    }
    .shell-hd {
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 44px;
      padding: 0 var(--space-5);
      border-bottom: 1px solid var(--surface-4);
      background: var(--surface-1);
      flex-shrink: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-6);
    }
    .logo {
      font-size: 0.82rem;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: var(--text);
    }
    .repo-select {
      font-family: inherit;
      font-size: var(--text-xs);
      padding: 0.15rem 0.45rem;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .repo-select:focus {
      outline: none;
      border-color: var(--border-strong);
    }
    .branch-select {
      font-family: inherit;
      font-size: var(--text-xs);
      min-width: 60px;
      max-width: 200px;
      height: 24px;
      padding: 0 var(--space-2);
      padding-right: 20px;
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--surface-4);
      border-radius: var(--radius-md);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 6px center;
    }
    .branch-select:focus-visible {
      outline: 2px solid var(--accent-user);
      outline-offset: 1px;
    }
    .repo-label {
      font-size: var(--text-xs);
      opacity: 0.55;
    }
    .tabs {
      display: flex;
      gap: 0.1rem;
      align-items: stretch;
      height: 44px;
    }
    .tab {
      padding: 0 0.9rem;
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px; /* overlap the shell-hd border */
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      opacity: 0.45;
      transition:
        opacity 0.12s ease,
        border-color 0.12s ease;
    }
    .tab:hover {
      opacity: 0.8;
    }
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--accent-assistant);
    }
    .who {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.72rem;
    }
    .principal {
      opacity: 0.75;
    }
    .mode {
      opacity: 0.55;
      padding: 0.1rem 0.45rem;
      border: 1px solid var(--border-default);
      border-radius: 3px;
    }
    .dot {
      opacity: 0.25;
    }
    .settings-btn {
      font-family: inherit;
      font-size: var(--text-sm);
      padding: 0.15rem 0.4rem;
      background: transparent;
      color: var(--text);
      border: none;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.12s ease;
      line-height: 1;
      vertical-align: middle;
    }
    .settings-btn:hover {
      opacity: 1;
    }
    .logout {
      font-family: inherit;
      font-size: inherit;
      padding: 0.15rem 0.55rem;
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: 3px;
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.12s ease;
    }
    .logout:hover {
      opacity: 1;
    }

    .shell-main {
      flex: 1;
      min-height: 0;
      display: flex;
      overflow: hidden;
    }
    .tab-panel {
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    /* ── Focus-visible ─────────────────────────────────────────── */
    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }
    .tab:focus-visible {
      outline-offset: -2px;
    }

    /* ── Shortcut modal ─────────────────────────────────────────── */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 50;
    }
    .modal {
      position: fixed;
      top: 60px;
      left: 0;
      right: 0;
      margin-left: auto;
      margin-right: auto;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-xl);
      padding: var(--space-6) var(--space-7);
      max-width: 720px;
      width: 90vw;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 51;
      box-shadow: var(--shadow-modal);
      animation: palette-in 0.12s ease;
    }
    .modal-title {
      margin: 0 0 var(--space-4);
      font-size: var(--text-lg);
      font-weight: 500;
    }
    .shortcut-list {
      margin: 0;
      padding: 0;
    }
    .shortcut-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-1) 0;
      border-bottom: 1px solid var(--surface-4);
    }
    .shortcut-row:last-child {
      border-bottom: none;
    }
    .shortcut-row dt {
      flex-shrink: 0;
    }
    .shortcut-row dd {
      margin: 0;
      opacity: 0.7;
      font-size: var(--text-sm);
    }
    kbd {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      background: var(--surface-0);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      min-width: 1.5em;
      text-align: center;
    }
    .modal-hint {
      margin: var(--space-4) 0 0;
      opacity: 0.4;
      font-size: var(--text-xs);
      text-align: center;
    }

    /* ── Search — command palette style (top-fixed) ─────────── */
    .search-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 50;
    }
    .search-palette {
      position: fixed;
      top: 60px;
      left: 50%;
      transform: translateX(-50%);
      width: 90vw;
      max-width: 560px;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-xl);
      z-index: 51;
      box-shadow: var(--shadow-modal);
      overflow: hidden;
      animation: palette-in 0.12s ease;
    }
    @keyframes palette-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }
    .search-input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-4);
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 1px solid var(--surface-4);
      font-family: inherit;
      font-size: var(--text-base);
      outline: none;
    }
    .search-results {
      list-style: none;
      margin: 0;
      padding: var(--space-1) 0;
      max-height: 360px;
      overflow-y: auto;
    }
    .search-hit {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      padding: var(--space-2) var(--space-4);
      cursor: pointer;
    }
    .search-hit.selected {
      background: var(--surface-3);
    }
    .hit-source {
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.5;
      color: var(--accent-assistant);
    }
    .hit-title {
      font-size: var(--text-sm);
    }
    .hit-body {
      font-size: var(--text-xs);
      opacity: 0.55;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .search-hint {
      padding: var(--space-2) var(--space-4);
      font-size: var(--text-xs);
      opacity: 0.3;
      text-align: center;
      border-top: 1px solid var(--surface-4);
    }
    .search-empty {
      padding: var(--space-4);
      opacity: 0.45;
      text-align: center;
      font-size: var(--text-sm);
    }
    @media (prefers-reduced-motion: reduce) {
      .search-palette {
        animation: none;
      }
    }

    /* ── Command palette ──────────────────────────────────────── */
    .palette {
      position: fixed;
      top: 60px;
      left: 50%;
      transform: translateX(-50%);
      width: 90vw;
      max-width: 640px;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-xl);
      z-index: 51;
      box-shadow: var(--shadow-modal);
      overflow: hidden;
      animation: palette-in 0.12s ease;
    }
    .palette-input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-4);
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 1px solid var(--surface-4);
      font-family: inherit;
      font-size: var(--text-base);
      outline: none;
    }
    .palette-list {
      list-style: none;
      margin: 0;
      padding: var(--space-1) 0;
      max-height: min(400px, calc(100vh - 200px));
      overflow-y: auto;
    }
    .palette-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-2) var(--space-4);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .palette-item.selected {
      background: var(--surface-3);
    }
    .palette-label {
      flex: 1;
    }
    @media (prefers-reduced-motion: reduce) {
      .palette {
        animation: none;
      }
    }

    /* ── Responsive ─────────────────────────────────────────── */
    @media (max-width: 768px) {
      .shell-hd {
        flex-wrap: wrap;
        height: auto;
        padding: var(--space-2) var(--space-3);
        gap: var(--space-2);
      }
      .brand {
        gap: var(--space-2);
      }
      .repo-label,
      .repo-select {
        display: none;
      }
    }

    /* ── Reduced motion ────────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      .tab,
      .logout {
        transition: none;
      }
    }
  `;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
