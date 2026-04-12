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
import * as settings from "./lib/settings.js";

type Tab = "chat" | "browse" | "log" | "kb";

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
  @state() private currentBranch = ""; // empty = repo default branch
  @state() private branches: Array<{ name: string }> = [];

  // Server config state
  @state() private configEntries: any[] = [];
  @state() private configLoading = false;
  @state() private expandedGroups: Set<string> = new Set();
  private configDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  override async connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHashChange);
    window.addEventListener("keydown", this.onGlobalKeydown);
    // Cross-view bridge: any child can dispatch gc:ask-about to
    // switch to chat and pre-fill the composer.
    this.addEventListener("gc:ask-about", this.onAskAbout as EventListener);
    this.addEventListener("gc:view-commit", this.onViewCommit as EventListener);
    this.addEventListener("gc:open-file", this.onOpenFile as EventListener);
    this.addEventListener("gc:view-file-history", this.onViewFileHistory as EventListener);
    await this.boot();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHashChange);
    window.removeEventListener("keydown", this.onGlobalKeydown);
    this.removeEventListener("gc:ask-about", this.onAskAbout as EventListener);
    this.removeEventListener("gc:view-commit", this.onViewCommit as EventListener);
    this.removeEventListener("gc:open-file", this.onOpenFile as EventListener);
    this.removeEventListener("gc:view-file-history", this.onViewFileHistory as EventListener);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const t of this.configDebounceTimers.values()) clearTimeout(t);
    this.configDebounceTimers.clear();
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
    this.switchTab("log");
    const log = this.renderRoot.querySelector("gc-commit-log");
    log?.dispatchEvent(
      new CustomEvent("gc:select-commit", {
        detail: { sha: e.detail.sha },
      }),
    );
  };

  // Bridge: any view can dispatch gc:open-file to switch to browse
  // tab and open a specific file.
  private onOpenFile = (e: CustomEvent<{ path: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.switchTab("browse");
    requestAnimationFrame(() => {
      const browser = this.renderRoot.querySelector("gc-repo-browser");
      browser?.dispatchEvent(new CustomEvent("gc:open-file", { detail: { path: e.detail.path } }));
    });
  };

  // Bridge: file-view "history" button dispatches gc:view-file-history
  // to switch to log tab and filter by file path.
  private onViewFileHistory = (e: CustomEvent<{ path: string }>) => {
    if (this.state.phase !== "authenticated") return;
    this.switchTab("log");
    requestAnimationFrame(() => {
      const log = this.renderRoot.querySelector("gc-commit-log");
      log?.dispatchEvent(
        new CustomEvent("gc:set-filter-path", { detail: { path: e.detail.path } }),
      );
    });
  };

  // ── Modal focus management ───────────────────────────────────
  override async updated(changed: Map<string, unknown>) {
    if (changed.has("showSettings") || changed.has("showShortcuts")) {
      if (this.showSettings || this.showShortcuts) {
        await this.updateComplete;
        const modal = this.renderRoot.querySelector(".modal") as HTMLElement | null;
        const first = modal?.querySelector("button, input, [tabindex]") as HTMLElement | null;
        (first ?? modal)?.focus();
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
    if (
      e.key === "?" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !(e.target instanceof HTMLInputElement)
    ) {
      e.preventDefault();
      this.showShortcuts = !this.showShortcuts;
      return;
    }
    if (e.key === "Escape" && (this.showShortcuts || this.showSettings)) {
      this.showShortcuts = false;
      this.showSettings = false;
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    switch (e.key) {
      case "k":
        // ⌘K → new chat (dispatch to chat-view)
        e.preventDefault();
        this.dispatchShortcut("gc:new-chat");
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
        // ⌘\ → toggle focus mode
        e.preventDefault();
        this.dispatchShortcut("gc:toggle-focus");
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

  // Broadcast a shortcut event so child components can react.
  private dispatchShortcut(name: string) {
    const target = this.renderRoot.querySelector("gc-chat-view, gc-repo-browser");
    target?.dispatchEvent(new CustomEvent(name, { bubbles: false }));
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
      // Restore repo + tab from hash if available.
      const { repoId, tab } = this.readHash();
      const validRepo =
        repoId && repos.some((r) => r.id === repoId) ? repoId : (repos[0]?.id ?? "");
      this.state = {
        phase: "authenticated",
        principal,
        mode,
        repos,
        selectedRepo: validRepo,
        tab: tab ?? "chat",
      };
      this.pushHash();
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
    this.pushHash();
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
    this.pushHash();
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

  // ── Hash routing ─────────────────────────────────────────────
  // Shape: #/:repoId/:tab  (e.g. #/git-chat/chat)
  // Defaults: first repo, "chat" tab.
  private pushHash() {
    if (this.state.phase !== "authenticated") return;
    const { selectedRepo, tab } = this.state;
    const hash = `#/${selectedRepo}/${tab}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }

  private readHash(): { repoId?: string; tab?: Tab } {
    const hash = window.location.hash;
    const m = hash.match(/^#\/([^/]+)(?:\/(chat|browse|log|kb))?$/);
    if (!m) return {};
    return { repoId: m[1], tab: (m[2] as Tab) || "chat" };
  }

  private onHashChange = () => {
    if (this.state.phase !== "authenticated") return;
    const { repoId, tab } = this.readHash();
    const { repos } = this.state;
    const validRepo = repoId && repos.some((r) => r.id === repoId);
    this.state = {
      ...this.state,
      selectedRepo: validRepo ? repoId! : this.state.selectedRepo,
      tab: tab ?? this.state.tab,
    };
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
            class="tab-panel"
            ?hidden=${tab !== "chat"}
          ></gc-chat-view>
          <gc-repo-browser
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            class="tab-panel"
            ?hidden=${tab !== "browse"}
          ></gc-repo-browser>
          <gc-commit-log
            .repoId=${selectedRepo}
            .branch=${this.currentBranch}
            class="tab-panel"
            ?hidden=${tab !== "log"}
          ></gc-commit-log>
          <gc-kb-view
            .repoId=${selectedRepo}
            class="tab-panel"
            ?hidden=${tab !== "kb"}
          ></gc-kb-view>
        </main>
      </div>
      ${this.showShortcuts ? this.renderShortcutsModal() : nothing}
      ${this.showSettings ? this.renderSettingsModal() : nothing}
      ${this.showSearch ? this.renderSearchOverlay() : nothing}
      <gc-toast></gc-toast>
    `;
  }

  private renderShortcutsModal() {
    const isMac = navigator.platform.includes("Mac");
    const mod = isMac ? "⌘" : "Ctrl+";
    const shortcuts = [
      [mod + "K", "New chat"],
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

  private toggleGroup(group: string) {
    const next = new Set(this.expandedGroups);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    this.expandedGroups = next;
  }

  private humanizeKey(key: string): string {
    return key
      .replace(/^GITCHAT_/, "")
      .toLowerCase()
      .replace(/_/g, " ");
  }

  private isApiKeyEntry(key: string): boolean {
    const k = key.toUpperCase();
    return k.includes("API_KEY") || k.includes("SECRET") || k.includes("TOKEN");
  }

  private renderServerConfig() {
    const GROUP_ORDER = ["llm", "chat", "repo", "session"];
    const GROUP_LABELS: Record<string, string> = {
      llm: "LLM",
      chat: "Chat",
      repo: "Repository",
      session: "Session",
    };

    if (this.configLoading) {
      return html`<div class="config-section">
        <span class="config-loading">loading server config…</span>
      </div>`;
    }
    if (this.configEntries.length === 0) {
      return nothing;
    }

    // Group entries
    const grouped = new Map<string, any[]>();
    for (const entry of this.configEntries) {
      const g = entry.group || "other";
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g)!.push(entry);
    }

    // Sort groups by defined order, unknown groups last
    const sortedGroups = [...grouped.keys()].sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    return html`
      <div class="config-section">
        <h3 class="config-title">Server Config</h3>
        ${sortedGroups.map((group) => {
          const entries = grouped.get(group)!;
          const expanded = this.expandedGroups.has(group);
          const label = GROUP_LABELS[group] ?? group;
          const modifiedCount = entries.filter((e: any) => e.value !== e.defaultValue).length;
          return html`
            <div class="config-group">
              <button
                class="config-group-header"
                @click=${() => this.toggleGroup(group)}
                aria-expanded=${expanded ? "true" : "false"}
              >
                <span class="config-chevron">${expanded ? "\u25BE" : "\u25B8"}</span>
                <span>${label}</span>
                ${modifiedCount > 0
                  ? html`<span class="config-modified-badge">${modifiedCount} modified</span>`
                  : nothing}
              </button>
              ${expanded
                ? html`
                    <div class="config-group-body">
                      ${entries.map((entry: any) => {
                        const isSecret = this.isApiKeyEntry(entry.key);
                        const modified = entry.value !== entry.defaultValue;
                        return html`
                          <div class="config-entry">
                            <div class="config-entry-header">
                              <span class="config-key ${modified ? "config-modified" : ""}"
                                >${this.humanizeKey(entry.key)}</span
                              >
                              ${modified
                                ? html`<button
                                    class="config-reset-btn"
                                    @click=${() => this.resetConfigEntry(entry)}
                                    title="Reset to default: ${entry.defaultValue}"
                                  >
                                    reset
                                  </button>`
                                : nothing}
                            </div>
                            <input
                              class="config-input"
                              type=${isSecret ? "password" : "text"}
                              .value=${entry.value}
                              ?readonly=${isSecret}
                              @input=${(e: Event) => {
                                if (isSecret) return;
                                this.updateConfigEntry(
                                  entry.key,
                                  (e.target as HTMLInputElement).value,
                                );
                              }}
                            />
                            ${entry.description
                              ? html`<span class="config-desc">${entry.description}</span>`
                              : nothing}
                          </div>
                        `;
                      })}
                    </div>
                  `
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderSettingsModal() {
    const sidebarW = parseInt(settings.get("sidebar-width"));
    const contentW = parseInt(settings.get("content-max-width"));
    const fontSize = parseFloat(settings.get("font-size")) * 100;
    const theme = settings.getTheme();
    return html`
      <div class="modal-backdrop" @click=${() => (this.showSettings = false)}>
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${this.trapFocus}
        >
          <h2 class="modal-title">Settings</h2>

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

          ${this.renderServerConfig()}

          <div class="setting-actions">
            <button
              class="action-btn"
              @click=${async () => {
                for (const k of settings.allKeys()) settings.reset(k);
                settings.setTheme("system");
                // Reset modified server config entries to defaults
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

          <p class="modal-hint">changes apply immediately and persist across sessions</p>
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
      // r.title is the session_id for message hits.
      this.switchTab("chat");
      // Defer so chat-view mounts, then select the session.
      requestAnimationFrame(() => {
        const chatView = this.renderRoot.querySelector("gc-chat-view");
        chatView?.dispatchEvent(
          new CustomEvent("gc:select-session", {
            detail: { sessionId: r.title },
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

  private renderSearchOverlay() {
    const sourceLabels: Record<string, string> = {
      card: "knowledge base",
      message: "chat history",
      file: "files",
    };
    return html`
      <div class="search-backdrop" @click=${() => (this.showSearch = false)}></div>
      <div class="search-palette" role="dialog" aria-label="Search">
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
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 50;
    }
    .modal {
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-xl);
      padding: var(--space-6) var(--space-7);
      max-width: 720px;
      width: 90vw;
      max-height: 85vh;
      overflow-y: auto;
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
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
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

    /* ── Settings modal ───────────────────────────────────────── */
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
    .setting-actions {
      margin-top: var(--space-4);
      display: flex;
      justify-content: flex-end;
    }

    /* ── Server config section ────────────────────────────────── */
    .config-section {
      margin-top: var(--space-4);
      padding-top: var(--space-4);
      border-top: 1px solid var(--surface-4);
    }
    .config-title {
      margin: 0 0 var(--space-3);
      font-size: var(--text-sm);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.5;
    }
    .config-loading {
      font-size: var(--text-xs);
      opacity: 0.45;
    }
    .config-group {
      margin-bottom: var(--space-2);
    }
    .config-group-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      width: 100%;
      padding: var(--space-2) 0;
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 1px solid var(--surface-4);
      font-family: inherit;
      font-size: var(--text-xs);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.55;
      cursor: pointer;
      transition: opacity 0.12s ease;
    }
    .config-group-header:hover {
      opacity: 0.85;
    }
    .config-chevron {
      font-size: 0.7rem;
      line-height: 1;
    }
    .config-modified-badge {
      margin-left: auto;
      font-size: 0.6rem;
      color: var(--accent-user);
      text-transform: none;
      letter-spacing: normal;
      opacity: 1;
    }
    .config-group-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2) var(--space-4);
      padding: var(--space-2) 0 var(--space-2) var(--space-3);
    }
    @media (max-width: 560px) {
      .config-group-body {
        grid-template-columns: 1fr;
      }
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
    .config-input[readonly] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .config-desc {
      font-size: 0.65rem;
      opacity: 0.4;
      line-height: 1.3;
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
