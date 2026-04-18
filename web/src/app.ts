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
import "./components/combobox.js";
import type { ComboboxOption } from "./components/combobox.js";
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

  // Deep-link routing state
  private currentRoute: ParsedRoute = { repoId: "", tab: "chat" };
  private _routing = false;
  private _paletteScrollRafId: number | null = null;

  // Server config state
  @state() private configEntries: any[] = [];
  @state() private configLoading = false;
  @state() private settingsSection = "appearance";
  private configDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // LLM profiles state
  @state() private profiles: any[] = [];
  @state() private activeProfileId = "";
  @state() private editingProfile: any | null = null;
  @state() private catalog: any[] = []; // CatalogProvider[]
  @state() private catalogLoading = false;

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
    for (const t of this.configDebounceTimers.values()) clearTimeout(t);
    this.configDebounceTimers.clear();
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
    const chatView = this.renderRoot.querySelector("gc-chat-view");
    chatView?.dispatchEvent(
      new CustomEvent("gc:prefill", {
        detail: { text: e.detail.prompt },
      }),
    );
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
    // Wait for Lit's render cycle to complete so gc-chat-view exists,
    // then wait one frame for the child component to be ready.
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        const chatView =
          this.renderRoot.querySelector<import("./components/chat-view").GcChatView>(
            "gc-chat-view",
          );
        if (chatView) {
          chatView.insertFileMention(e.detail.path);
        }
      });
    });
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
    this.handleOverlay(changed, "showSettings", "settings", ".modal");
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
  private toggleFocus() {
    const next = !readFocus();
    writeFocus(next);
    // Notify all focus-aware components to re-read the shared state.
    // gc-compare-view lives inside gc-repo-browser's shadow root and
    // is handled by repo-browser itself forwarding the event.
    for (const sel of ["gc-chat-view", "gc-repo-browser", "gc-commit-log"] as const) {
      const el = this.renderRoot.querySelector(sel);
      el?.dispatchEvent(new CustomEvent("gc:toggle-focus", { bubbles: false }));
    }
  }

  // Create a new chat session.
  private newChat() {
    this.switchTab("chat");
    requestAnimationFrame(() => {
      const chat = this.renderRoot.querySelector("gc-chat-view");
      chat?.dispatchEvent(new CustomEvent("gc:new-chat", { bubbles: false }));
    });
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
                if (this.showSettings) {
                  this.loadConfig();
                  this.loadProfiles();
                  this.loadCatalog();
                }
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
            class="tab-panel"
            ?hidden=${tab !== "browse"}
          ></gc-repo-browser>
          <gc-commit-log
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            .initialCommitSha=${this.currentRoute.commitSha ?? ""}
            .initialLogFile=${this.currentRoute.logFile ?? ""}
            .initialSplitView=${this.currentRoute.splitView ?? false}
            .filterPath=${this.currentRoute.filterPath ?? ""}
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
      ${this.showSettings ? this.renderSettingsModal() : nothing}
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

  // ── Server config helpers ────────────────────────────────────
  private async loadConfig() {
    this.configLoading = true;
    try {
      const resp = await (repoClient as any).getConfig({});
      this.configEntries = resp.entries ?? [];
    } catch {
      this.configEntries = [];
    } finally {
      this.configLoading = false;
    }
  }

  private async loadProfiles() {
    try {
      const resp = await (repoClient as any).listProfiles({});
      this.profiles = resp.profiles ?? [];
      this.activeProfileId = resp.activeProfileId ?? "";
    } catch {
      this.profiles = [];
    }
  }

  private async saveProfile(profile: any) {
    try {
      const resp = await (repoClient as any).saveProfile({ profile });
      if (!profile.id) profile.id = resp.id;
      await this.loadProfiles();
      this.editingProfile = null;
    } catch (e) {
      // TODO: surface error
    }
  }

  private async deleteProfile(id: string) {
    try {
      await (repoClient as any).deleteProfile({ id });
      await this.loadProfiles();
      await this.loadConfig();
      this.editingProfile = null;
    } catch {
      // TODO: surface error
    }
  }

  private async loadCatalog() {
    try {
      const resp = await (repoClient as any).getProviderCatalog({});
      this.catalog = resp.providers ?? [];
    } catch {
      this.catalog = [];
    }
  }

  private async refreshCatalog() {
    this.catalogLoading = true;
    try {
      const resp = await (repoClient as any).refreshProviderCatalog({});
      this.catalog = resp.providers ?? [];
    } catch {
      // TODO: surface error
    } finally {
      this.catalogLoading = false;
    }
  }

  /** Models for a given provider ID from the catalog. */
  private catalogModelsFor(providerId: string): any[] {
    const p = this.catalog.find((c: any) => c.id === providerId);
    return p?.models ?? [];
  }

  /** Sorted combobox options for providers. */
  private get providerOptions(): ComboboxOption[] {
    if (this.catalog.length === 0) {
      return [
        { value: "openai", label: "openai" },
        { value: "anthropic", label: "anthropic" },
      ];
    }
    return [...this.catalog]
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((c: any) => ({
        value: c.id,
        label: c.name,
        description: `${c.type} · ${c.models?.length ?? 0} models`,
      }));
  }

  /** Sorted combobox options for models of a given provider. */
  private modelOptionsFor(providerId: string): ComboboxOption[] {
    return this.catalogModelsFor(providerId)
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((m: any) => ({
        value: m.id,
        label: m.name,
        description: [
          m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K ctx` : "",
          m.costPer1MIn ? `$${m.costPer1MIn}/$${m.costPer1MOut} per 1M` : "",
          m.canReason ? "reasoning" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
  }

  /** Combobox options for base URLs. */
  private get baseUrlOptions(): ComboboxOption[] {
    const urls = new Set([
      "http://localhost:1234/v1",
      "http://localhost:11434/v1",
      ...this.catalog
        .filter((c: any) => c.defaultBaseUrl)
        .map((c: any) => c.defaultBaseUrl as string),
    ]);
    return [...urls].sort().map((u) => ({ value: u, label: u }));
  }

  private async activateProfile(id: string) {
    try {
      await (repoClient as any).activateProfile({ id });
      await this.loadProfiles();
      await this.loadConfig();
    } catch {
      // TODO: surface error
    }
  }

  private updateConfigEntry(key: string, value: string) {
    // Update local state immediately
    this.configEntries = this.configEntries.map((e: any) => (e.key === key ? { ...e, value } : e));
    // Debounce the RPC call
    const existing = this.configDebounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.configDebounceTimers.set(
      key,
      setTimeout(async () => {
        try {
          await (repoClient as any).updateConfig({ key, value });
        } catch {
          /* toast could go here */
        }
        this.configDebounceTimers.delete(key);
      }, 300),
    );
  }

  private async resetConfigEntry(entry: any) {
    this.updateConfigEntry(entry.key, entry.defaultValue);
  }

  private humanizeKey(key: string): string {
    return key
      .replace(/^GITCHAT_/, "")
      .toLowerCase()
      .replace(/_/g, " ");
  }

  private isSecretEntry(entry: any): boolean {
    return !!entry.secret;
  }

  // Combobox suggestions for config entries. Keys listed here get a
  // <gc-combobox> with suggestions; all others get a plain <input>.
  private static readonly CONFIG_SUGGESTIONS: Record<string, ComboboxOption[]> = {
    LLM_BACKEND: [
      { value: "openai", label: "openai" },
      { value: "anthropic", label: "anthropic" },
    ],
    LLM_BASE_URL: [
      { value: "http://localhost:1234/v1", label: "LM Studio (localhost:1234)" },
      { value: "http://localhost:11434/v1", label: "Ollama (localhost:11434)" },
      { value: "https://api.openai.com/v1", label: "OpenAI" },
      { value: "https://api.fireworks.ai/inference/v1", label: "Fireworks AI" },
      { value: "https://openrouter.ai/api/v1", label: "OpenRouter" },
      { value: "https://api.groq.com/openai/v1", label: "Groq" },
    ],
    LLM_MODEL: [
      { value: "gemma-4-e4b-it", label: "Gemma 4 e4b", description: "local" },
      { value: "gpt-4o", label: "GPT-4o", description: "OpenAI" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "Anthropic" },
    ],
    LLM_TEMPERATURE: [
      { value: "0", label: "0 (deterministic)" },
      { value: "0.3", label: "0.3 (focused)" },
      { value: "0.7", label: "0.7 (balanced)" },
      { value: "1.0", label: "1.0 (creative)" },
    ],
    LLM_MAX_TOKENS: [
      { value: "0", label: "0 (provider default)" },
      { value: "2048", label: "2048" },
      { value: "4096", label: "4096" },
      { value: "8192", label: "8192" },
    ],
  };

  private static readonly SETTINGS_SECTIONS = [
    { id: "appearance", label: "Appearance" },
    { id: "llm", label: "LLM" },
    { id: "chat", label: "Chat" },
    { id: "repo", label: "Repository" },
    { id: "session", label: "Session" },
    { id: "webhook", label: "Webhook" },
  ] as const;

  private configGroupEntries(group: string): any[] {
    return this.configEntries.filter((e: any) => (e.group || "other") === group);
  }

  private configGroupModifiedCount(group: string): number {
    return this.configGroupEntries(group).filter((e: any) => e.value !== e.defaultValue).length;
  }

  private renderConfigGroup(group: string) {
    const entries = this.configGroupEntries(group);
    if (this.configLoading) {
      return html`<gc-spinner></gc-spinner><span>loading…</span>`;
    }
    if (entries.length === 0) {
      return html`<p class="config-empty">no entries</p>`;
    }
    return html`
      <div class="config-group-body">
        ${entries.map((entry: any) => {
          const isSecret = this.isSecretEntry(entry);
          const modified = entry.value !== entry.defaultValue;
          const suggestions = (this.constructor as typeof GcApp).CONFIG_SUGGESTIONS[entry.key];
          return html`
            <div class="config-entry">
              <div class="config-entry-header">
                <label
                  class="config-key ${modified ? "config-modified" : ""}"
                  for="cfg-${entry.key}"
                  >${this.humanizeKey(entry.key)}</label
                >
                ${modified
                  ? html`<button
                      class="config-reset-btn"
                      @click=${() => this.resetConfigEntry(entry)}
                      title="Reset to default"
                      aria-label="Reset ${this.humanizeKey(entry.key)} to default"
                    >
                      reset
                    </button>`
                  : nothing}
              </div>
              ${isSecret
                ? html`<input
                    id="cfg-${entry.key}"
                    class="config-input"
                    type="password"
                    autocomplete="off"
                    placeholder=${entry.value || "not set"}
                    .value=${""}
                    @change=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      if (v) this.updateConfigEntry(entry.key, v);
                    }}
                  />`
                : suggestions
                  ? html`<gc-combobox
                      .options=${suggestions}
                      .value=${entry.value}
                      @gc-select=${(e: CustomEvent) => {
                        this.updateConfigEntry(entry.key, e.detail.value);
                      }}
                      @gc-input=${(e: CustomEvent) => {
                        this.updateConfigEntry(entry.key, e.detail);
                      }}
                    ></gc-combobox>`
                  : html`<input
                      id="cfg-${entry.key}"
                      class="config-input"
                      type="text"
                      autocomplete="off"
                      .value=${entry.value}
                      @input=${(e: Event) => {
                        this.updateConfigEntry(
                          entry.key,
                          (e.target as HTMLInputElement).value,
                        );
                      }}
                    />`}
              ${entry.description
                ? html`<span id="cfg-desc-${entry.key}" class="config-desc"
                    >${entry.description}</span
                  >`
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderAppearance() {
    const sidebarW = parseInt(settings.get("sidebar-width"));
    const contentW = parseInt(settings.get("content-max-width"));
    const fontSize = parseFloat(settings.get("font-size")) * 100;
    const theme = settings.getTheme();
    return html`
      <div class="setting-row">
        <span class="setting-label">Theme</span>
        <div class="theme-picker">
          ${(["system", "light", "dark"] as const).map(
            (t) => html`
              <button
                class="theme-btn ${theme === t ? "active" : ""}"
                @click=${() => {
                  settings.setTheme(t);
                  this.requestUpdate();
                }}
              >
                ${t}
              </button>
            `,
          )}
        </div>
      </div>

      <label class="setting-row">
        <span class="setting-label">Sidebar width</span>
        <div class="setting-control">
          <input
            type="range"
            min="180"
            max="450"
            .value=${String(sidebarW)}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              settings.set("sidebar-width", v + "px");
              this.requestUpdate();
            }}
          />
          <span class="setting-value">${sidebarW}px</span>
        </div>
      </label>

      <label class="setting-row">
        <span class="setting-label">Content max width</span>
        <div class="setting-control">
          <input
            type="range"
            min="600"
            max="1400"
            step="20"
            .value=${String(contentW)}
            @input=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value;
              settings.set("content-max-width", v + "px");
              this.requestUpdate();
            }}
          />
          <span class="setting-value">${contentW}px</span>
        </div>
      </label>

      <label class="setting-row">
        <span class="setting-label">Font size</span>
        <div class="setting-control">
          <input
            type="range"
            min="60"
            max="120"
            .value=${String(Math.round(fontSize))}
            @input=${(e: Event) => {
              const v = parseInt((e.target as HTMLInputElement).value);
              settings.set("font-size", (v / 100).toFixed(2) + "rem");
              this.requestUpdate();
            }}
          />
          <span class="setting-value">${Math.round(fontSize)}%</span>
        </div>
      </label>
    `;
  }

  private renderSettingsSection() {
    const section = this.settingsSection;
    if (section === "appearance") return this.renderAppearance();
    if (section === "llm") return this.renderLLMSection();
    return this.renderConfigGroup(section);
  }

  private renderLLMSection() {
    return html`
      <div class="profiles-section">
        <div class="profiles-header">
          <span class="profiles-label">Profiles</span>
          <div class="profiles-header-actions">
            <button
              class="action-btn"
              ?disabled=${this.catalogLoading}
              @click=${() => this.refreshCatalog()}
              title="Fetch latest provider/model catalog from catwalk.charm.sh"
            >
              ${this.catalogLoading
                ? "fetching…"
                : this.catalog.length > 0
                  ? `\u21BB ${this.catalog.length} providers`
                  : "fetch catalog"}
            </button>
            <button
              class="action-btn"
              @click=${() => {
              this.editingProfile = {
                id: "",
                name: "",
                backend: "openai",
                baseUrl: "http://localhost:1234/v1",
                model: "",
                apiKey: "",
                temperature: "",
                maxTokens: "",
              };
            }}
          >
            + new
          </button>
          </div>
        </div>
        <div class="profiles-list">
          ${this.profiles.length === 0
            ? html`<p class="config-empty">no profiles yet</p>`
            : this.profiles.map(
                (p: any) => html`
                  <div class="profile-item ${this.activeProfileId === p.id ? "active" : ""}">
                    <button
                      class="profile-name"
                      @click=${() => {
                        // Resolve _providerId from catalog so the model
                        // dropdown populates correctly on edit.
                        const prov = this.catalog.find(
                          (c: any) => c.type === p.backend && c.id === p.backend,
                        ) || this.catalog.find((c: any) => c.type === p.backend);
                        this.editingProfile = { ...p, _providerId: prov?.id ?? "" };
                      }}
                    >
                      ${p.name}
                      <span class="profile-meta">${p.backend} · ${p.model || "(default)"}</span>
                    </button>
                    <div class="profile-actions">
                      ${this.activeProfileId === p.id
                        ? html`<span class="profile-active-badge">active</span>`
                        : html`<button
                            class="action-btn"
                            @click=${() => this.activateProfile(p.id)}
                          >
                            activate
                          </button>`}
                    </div>
                  </div>
                `,
              )}
        </div>
        ${this.activeProfileId
          ? html`<button
              class="action-btn profile-deactivate"
              @click=${() => this.activateProfile("")}
            >
              use manual settings
            </button>`
          : nothing}
      </div>
      ${this.editingProfile ? this.renderProfileEditor() : nothing}
      ${!this.editingProfile ? this.renderConfigGroup("llm") : nothing}
    `;
  }

  private renderProfileEditor() {
    const p = this.editingProfile;
    if (!p) return nothing;
    const isNew = !p.id;
    return html`
      <div class="profile-editor">
        <h4 class="profile-editor-title">${isNew ? "New Profile" : p.name}</h4>
        <div class="profile-fields">
          <label class="profile-field">
            <span>Name</span>
            <input
              type="text"
              class="config-input"
              .value=${p.name}
              @input=${(e: Event) => {
                p.name = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="profile-field">
            <span>Provider</span>
            <gc-combobox
              .options=${this.providerOptions}
              .value=${p._providerId || p.backend || ""}
              placeholder="e.g. openai, anthropic"
              @gc-select=${(e: CustomEvent) => {
                const opt = e.detail;
                p._providerId = opt.value;
                const prov = this.catalog.find((c: any) => c.id === opt.value);
                if (prov) {
                  p.backend = prov.type;
                  p.baseUrl = prov.defaultBaseUrl || p.baseUrl || "";
                  p.model = prov.defaultModelId || "";
                } else {
                  p.backend = opt.value;
                }
                this.requestUpdate();
              }}
              @gc-input=${(e: CustomEvent) => {
                const val = e.detail;
                if (val === "openai" || val === "anthropic") {
                  p.backend = val;
                  p._providerId = "";
                }
              }}
            ></gc-combobox>
          </label>
          ${p.backend !== "anthropic"
            ? html`<label class="profile-field">
                <span>Base URL</span>
                <gc-combobox
                  .options=${this.baseUrlOptions}
                  .value=${p.baseUrl}
                  placeholder="http://localhost:1234/v1"
                  @gc-select=${(e: CustomEvent) => {
                    p.baseUrl = e.detail.value;
                  }}
                  @gc-input=${(e: CustomEvent) => {
                    p.baseUrl = e.detail;
                  }}
                ></gc-combobox>
              </label>`
            : nothing}
          <label class="profile-field">
            <span>Model</span>
            <gc-combobox
              .options=${this.modelOptionsFor(p._providerId || "")}
              .value=${p.model}
              placeholder="(backend default)"
              @gc-select=${(e: CustomEvent) => {
                p.model = e.detail.value;
              }}
              @gc-input=${(e: CustomEvent) => {
                p.model = e.detail;
              }}
            ></gc-combobox>
          </label>
          <label class="profile-field">
            <span>API Key</span>
            <input
              type="password"
              class="config-input"
              autocomplete="off"
              placeholder=${p.apiKey || "not set"}
              .value=${p.apiKey === "••••••••" ? "" : p.apiKey}
              @change=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                if (v) p.apiKey = v;
              }}
            />
          </label>
          <label class="profile-field">
            <span>Temperature</span>
            <input
              type="text"
              class="config-input"
              placeholder="0"
              .value=${p.temperature}
              @input=${(e: Event) => {
                p.temperature = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="profile-field">
            <span>Max Tokens</span>
            <input
              type="text"
              class="config-input"
              placeholder="0"
              .value=${p.maxTokens}
              @input=${(e: Event) => {
                p.maxTokens = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
        </div>
        <div class="profile-editor-actions">
          <button class="action-btn" @click=${() => this.saveProfile(p)}>
            ${isNew ? "create" : "save"}
          </button>
          ${!isNew
            ? html`<button
                class="action-btn danger"
                @click=${() => {
                  if (confirm(`Delete profile "${p.name}"? This cannot be undone.`)) {
                    this.deleteProfile(p.id);
                  }
                }}
              >
                delete
              </button>`
            : nothing}
          <button class="action-btn" @click=${() => (this.editingProfile = null)}>
            cancel
          </button>
        </div>
      </div>
    `;
  }

  private settingsSectionLabel(id: string): string {
    const sections = (this.constructor as typeof GcApp).SETTINGS_SECTIONS;
    return sections.find((s) => s.id === id)?.label ?? id;
  }

  private renderSettingsModal() {
    const sections = (this.constructor as typeof GcApp).SETTINGS_SECTIONS;
    return html`
      <div class="modal-backdrop" @click=${() => (this.showSettings = false)}>
        <div
          class="modal settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${this.trapFocus}
        >
          <nav class="settings-sidebar">
            <h2 class="settings-title">Settings</h2>
            ${sections.map((s) => {
              const mod = s.id !== "appearance" ? this.configGroupModifiedCount(s.id) : 0;
              return html`
                <button
                  class="settings-nav-item ${this.settingsSection === s.id ? "active" : ""}"
                  @click=${() => {
                    this.settingsSection = s.id;
                  }}
                >
                  ${s.label}
                  ${mod > 0
                    ? html`<span class="config-modified-badge">${mod}</span>`
                    : nothing}
                </button>
              `;
            })}
            <div class="settings-sidebar-footer">
              <button
                class="action-btn"
                @click=${async () => {
                  if (!confirm("Reset all settings to defaults? This cannot be undone.")) return;
                  for (const k of settings.allKeys()) settings.reset(k);
                  settings.setTheme("system");
                  for (const entry of this.configEntries) {
                    if ((entry as any).value !== (entry as any).defaultValue) {
                      await this.resetConfigEntry(entry);
                    }
                  }
                  this.requestUpdate();
                }}
              >
                reset defaults
              </button>
            </div>
          </nav>
          <div class="settings-content">
            <h3 class="settings-section-title">
              ${this.settingsSectionLabel(this.settingsSection)}
            </h3>
            ${this.renderSettingsSection()}
            <p class="modal-hint">changes apply immediately and persist across sessions</p>
          </div>
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

    if (r.source === "file") {
      this.switchTab("browse");
      requestAnimationFrame(() => {
        const browser = this.renderRoot.querySelector("gc-repo-browser");
        browser?.dispatchEvent(
          new CustomEvent("gc:open-file", {
            detail: { path: r.id },
          }),
        );
      });
    } else if (r.source === "message") {
      this.switchTab("chat");
      requestAnimationFrame(() => {
        const chatView = this.renderRoot.querySelector("gc-chat-view");
        chatView?.dispatchEvent(
          new CustomEvent("gc:select-session", {
            detail: { sessionId: r.id },
          }),
        );
      });
    } else if (r.source === "card") {
      // Show card answer in chat via prefill.
      this.switchTab("chat");
      requestAnimationFrame(() => {
        const chatView = this.renderRoot.querySelector("gc-chat-view");
        chatView?.dispatchEvent(
          new CustomEvent("gc:prefill", {
            detail: { text: r.title },
          }),
        );
      });
    }
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
          void this.loadConfig();
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
      left: 50%;
      transform: translateX(-50%);
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
        transform: translateX(-50%) translateY(-8px);
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

    /* ── Settings modal (sidebar layout) ───────────────────────── */
    .settings-modal {
      max-width: 900px;
      display: flex;
      padding: 0;
      overflow: hidden;
    }
    .settings-sidebar {
      width: 200px;
      flex-shrink: 0;
      border-right: 1px solid var(--border-default);
      padding: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .settings-title {
      margin: 0 0 var(--space-3);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-lg);
      font-weight: 500;
    }
    .settings-nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      text-align: left;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      background: none;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      opacity: 0.65;
      transition: opacity 0.1s ease, background 0.1s ease;
    }
    .settings-nav-item:hover {
      opacity: 1;
      background: var(--surface-3);
    }
    .settings-nav-item.active {
      opacity: 1;
      background: var(--surface-3);
    }
    .settings-sidebar-footer {
      margin-top: auto;
      padding-top: var(--space-3);
    }
    .settings-content {
      flex: 1;
      min-width: 0;
      padding: var(--space-6) var(--space-7);
      overflow-y: auto;
      max-height: calc(100vh - 120px);
    }
    .settings-section-title {
      margin: 0 0 var(--space-4);
      font-size: var(--text-base);
      font-weight: 500;
    }
    @media (max-width: 640px) {
      .settings-modal { flex-direction: column; }
      .settings-sidebar {
        width: 100%;
        flex-direction: row;
        flex-wrap: wrap;
        border-right: none;
        border-bottom: 1px solid var(--border-default);
        gap: var(--space-1);
        padding: var(--space-3);
      }
      .settings-title { display: none; }
      .settings-sidebar-footer { display: none; }
      .settings-content { max-height: calc(100vh - 220px); }
    }

    /* ── Appearance settings ──────────────────────────────────── */
    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--surface-4);
    }
    .setting-row:last-of-type {
      border-bottom: none;
    }
    .setting-label {
      font-size: var(--text-sm);
    }
    .setting-control {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .setting-control input[type="range"] {
      width: 140px;
      accent-color: var(--accent-assistant);
    }
    .setting-value {
      font-size: var(--text-xs);
      opacity: 0.6;
      min-width: 4.5em;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .theme-picker {
      display: flex;
      gap: var(--space-1);
    }
    .theme-btn {
      padding: var(--space-1) var(--space-3);
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.6;
    }
    .theme-btn:hover {
      opacity: 1;
      border-color: var(--border-strong);
    }
    .theme-btn.active {
      opacity: 1;
      background: var(--surface-3);
      border-color: var(--accent-assistant);
    }

    /* ── Config entries (shared across groups) ────────────────── */
    .config-modified-badge {
      font-size: 0.6rem;
      color: var(--accent-user);
      font-variant-numeric: tabular-nums;
    }
    .config-group-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2) var(--space-4);
    }
    @media (max-width: 640px) {
      .config-group-body {
        grid-template-columns: 1fr;
      }
    }
    .config-empty {
      opacity: 0.4;
      font-size: var(--text-sm);
      font-style: italic;
    }
    .config-entry {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--space-2) 0;
    }
    .config-entry-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .config-key {
      font-size: var(--text-xs);
      font-weight: 500;
    }
    .config-modified {
      color: var(--accent-user);
    }
    .config-reset-btn {
      font-family: inherit;
      font-size: 0.6rem;
      padding: 0.05rem 0.35rem;
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.12s ease;
    }
    .config-reset-btn:hover {
      opacity: 1;
    }
    .config-input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-1) var(--space-2);
      background: var(--surface-0);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      outline: none;
      transition: border-color 0.12s ease;
    }
    .config-input:focus {
      border-color: var(--accent-assistant);
    }
    select.config-input {
      cursor: pointer;
    }
    .config-desc {
      font-size: 0.65rem;
      opacity: 0.4;
      line-height: 1.3;
    }

    /* ── LLM Profiles ────────────────────────────────────────── */
    .profiles-section {
      margin-bottom: var(--space-4);
      padding-bottom: var(--space-4);
      border-bottom: 1px solid var(--surface-4);
    }
    .profiles-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
    }
    .profiles-header-actions {
      display: flex;
      gap: var(--space-2);
    }
    .profiles-label {
      font-size: var(--text-xs);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.5;
    }
    .profiles-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .profile-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      transition: border-color 0.1s ease;
    }
    .profile-item.active {
      border-color: var(--accent-assistant);
    }
    .profile-name {
      background: none;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      text-align: left;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .profile-name:hover {
      opacity: 0.8;
    }
    .profile-meta {
      font-size: var(--text-xs);
      opacity: 0.5;
    }
    .profile-active-badge {
      font-size: var(--text-xs);
      color: var(--accent-assistant);
      font-weight: 500;
    }
    .profile-deactivate {
      margin-top: var(--space-2);
      opacity: 0.5;
      font-size: var(--text-xs);
    }
    .profile-editor {
      margin-bottom: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--surface-0);
    }
    .profile-editor-title {
      margin: 0 0 var(--space-3);
      font-size: var(--text-sm);
      font-weight: 500;
    }
    .profile-fields {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .profile-field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: var(--text-xs);
    }
    .profile-field select {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-1) var(--space-2);
      background: var(--surface-1);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
    }
    .profile-editor-actions {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .action-btn.danger {
      color: var(--danger, #e55);
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
