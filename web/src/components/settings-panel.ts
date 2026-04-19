import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repoClient } from "../lib/transport.js";
import type {
  ConfigEntry,
  LLMProfile,
  CatalogProvider,
  LocalEndpoint,
} from "../gen/gitchat/v1/repo_pb.js";
import * as settings from "../lib/settings.js";
import { formatSources, providerSources } from "../lib/catalog.js";
import "./combobox.js";
import "./connection-wizard.js";
import "./loading-indicator.js";
import type { ComboboxOption } from "./combobox.js";

@customElement("gc-settings-panel")
export class GcSettingsPanel extends LitElement {
  @property({ type: Boolean }) open = false;

  @state() private configEntries: ConfigEntry[] = [];
  @state() private configLoading = false;
  @state() private settingsSection = "appearance";
  private configDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  @state() private profiles: LLMProfile[] = [];
  @state() private activeProfileId = "";
  @state() private editingProfile: Partial<LLMProfile> | null = null;
  @state() private catalog: CatalogProvider[] = [];
  @state() private catalogLoading = false;
  @state() private localEndpoints: LocalEndpoint[] = [];
  @state() private localDiscovering = false;

  // Models discovered by hitting /v1/models (or similar) on a specific
  // base URL entered in advanced-config. Keyed by URL so that switching
  // between providers re-uses cached results.
  @state() private discoveredModelsByUrl: Map<string, string[]> = new Map();
  @state() private discoveringModelsForUrl = "";
  private discoverModelsDebounce: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const t of this.configDebounceTimers.values()) clearTimeout(t);
    this.configDebounceTimers.clear();
    if (this.discoverModelsDebounce) {
      clearTimeout(this.discoverModelsDebounce);
      this.discoverModelsDebounce = null;
    }
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("open") && this.open) {
      void this.loadConfig().then(() => this.discoverModelsForCurrentBaseUrl());
      void this.loadProfiles();
      void this.loadCatalog();
    }
  }

  // Let the parent's handleOverlay focus the panel without knowing about
  // the internal modal inside our shadow root.
  override focus() {
    const modal = this.renderRoot.querySelector<HTMLElement>(".modal");
    modal?.focus();
  }

  private requestClose() {
    this.dispatchEvent(new CustomEvent("gc:close", { bubbles: true, composed: true }));
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

  private async loadConfig() {
    this.configLoading = true;
    try {
      const resp = await repoClient.getConfig({});
      this.configEntries = resp.entries ?? [];
    } catch {
      this.configEntries = [];
    } finally {
      this.configLoading = false;
    }
  }

  private async loadProfiles() {
    try {
      const resp = await repoClient.listProfiles({});
      this.profiles = resp.profiles ?? [];
      this.activeProfileId = resp.activeProfileId ?? "";
    } catch {
      this.profiles = [];
    }
  }

  private async saveProfile(profile: any) {
    try {
      const resp = await repoClient.saveProfile({ profile });
      if (!profile.id) profile.id = resp.id;
      await this.loadProfiles();
      this.editingProfile = null;
    } catch {
      // TODO: surface error
    }
  }

  private async deleteProfile(id: string) {
    try {
      await repoClient.deleteProfile({ id });
      await this.loadProfiles();
      await this.loadConfig();
      this.editingProfile = null;
    } catch {
      // TODO: surface error
    }
  }

  private async loadCatalog() {
    try {
      const resp = await repoClient.getProviderCatalog({});
      this.catalog = resp.providers ?? [];
    } catch {
      this.catalog = [];
    }
  }

  private async refreshCatalog() {
    this.catalogLoading = true;
    try {
      const resp = await repoClient.refreshProviderCatalog({});
      this.catalog = resp.providers ?? [];
    } catch {
      // TODO: surface error
    } finally {
      this.catalogLoading = false;
    }
  }

  private async discoverLocal() {
    this.localDiscovering = true;
    try {
      const resp = await repoClient.discoverLocalEndpoints({});
      this.localEndpoints = resp.endpoints ?? [];
    } catch {
      this.localEndpoints = [];
    } finally {
      this.localDiscovering = false;
    }
  }

  private async activateProfile(id: string) {
    try {
      await repoClient.activateProfile({ id });
      await this.loadProfiles();
      await this.loadConfig();
    } catch {
      // TODO: surface error
    }
  }

  private updateConfigEntry(key: string, value: string) {
    this.configEntries = this.configEntries.map((e) => (e.key === key ? { ...e, value } : e));
    const existing = this.configDebounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.configDebounceTimers.set(
      key,
      setTimeout(async () => {
        try {
          await repoClient.updateConfig({ key, value });
        } catch {
          /* toast could go here */
        }
        this.configDebounceTimers.delete(key);
      }, 300),
    );
    // Any change to LLM_BASE_URL (or the API key used with it) kicks a
    // model discovery against the new endpoint so the model combobox
    // below populates automatically — mirrors what the connection wizard
    // does for saved profiles, but works for one-off ad-hoc providers.
    if (key === "LLM_BASE_URL" || key === "LLM_API_KEY") {
      this.scheduleModelDiscovery();
    }
  }

  private scheduleModelDiscovery() {
    if (this.discoverModelsDebounce) clearTimeout(this.discoverModelsDebounce);
    this.discoverModelsDebounce = setTimeout(() => {
      void this.discoverModelsForCurrentBaseUrl();
    }, 400);
  }

  private async discoverModelsForCurrentBaseUrl() {
    const baseUrl = this.configEntries.find((e) => e.key === "LLM_BASE_URL")?.value?.trim() ?? "";
    if (!baseUrl) return;
    // Skip catalog/local — those already populate suggestions.
    const inCatalog = this.catalog.some(
      (c) => c.defaultBaseUrl && baseUrl.startsWith(c.defaultBaseUrl),
    );
    const inLocal = this.localEndpoints.some((ep) => ep.url === baseUrl);
    if (inCatalog || inLocal) return;
    if (this.discoveredModelsByUrl.has(baseUrl)) return;
    const apiKey = this.configEntries.find((e) => e.key === "LLM_API_KEY")?.value ?? "";
    this.discoveringModelsForUrl = baseUrl;
    try {
      const resp = await repoClient.discoverModels({ baseUrl, apiKey });
      if (!resp.error && resp.modelIds?.length) {
        this.discoveredModelsByUrl = new Map(this.discoveredModelsByUrl).set(
          baseUrl,
          resp.modelIds,
        );
      } else {
        // Cache the empty result so we don't retry on every keystroke —
        // user gets "no suggestions" until they change the URL or key.
        this.discoveredModelsByUrl = new Map(this.discoveredModelsByUrl).set(baseUrl, []);
      }
    } catch {
      this.discoveredModelsByUrl = new Map(this.discoveredModelsByUrl).set(baseUrl, []);
    } finally {
      if (this.discoveringModelsForUrl === baseUrl) this.discoveringModelsForUrl = "";
    }
  }

  private async resetConfigEntry(entry: ConfigEntry) {
    this.updateConfigEntry(entry.key, entry.defaultValue);
  }

  private humanizeKey(key: string): string {
    return key
      .replace(/^GITCHAT_/, "")
      .toLowerCase()
      .replace(/_/g, " ");
  }

  private isSecretEntry(entry: ConfigEntry): boolean {
    return !!entry.secret;
  }

  private static readonly STATIC_SUGGESTIONS: Record<string, ComboboxOption[]> = {
    LLM_BACKEND: [
      { value: "openai", label: "openai" },
      { value: "anthropic", label: "anthropic" },
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

  /** Pick a contextual empty-hint for the combobox. LLM_MODEL surfaces
   * the discovery state so the user knows why the dropdown is empty
   * (fetching vs genuinely no matches). */
  private comboboxEmptyHint(key: string): string {
    if (key !== "LLM_MODEL") return "type a value or fetch the catalog";
    const baseUrl = this.configEntries.find((e) => e.key === "LLM_BASE_URL")?.value ?? "";
    if (this.discoveringModelsForUrl && this.discoveringModelsForUrl === baseUrl) {
      return "discovering models…";
    }
    if (baseUrl && this.discoveredModelsByUrl.get(baseUrl)?.length === 0) {
      return "no models found at this base URL — type a model ID manually";
    }
    return "type a model ID or fetch the catalog";
  }

  /** Build combobox suggestions for a config key from catalog + local discovery. */
  private configSuggestionsFor(key: string): ComboboxOption[] {
    const s = (this.constructor as typeof GcSettingsPanel).STATIC_SUGGESTIONS[key];
    if (s) return s;

    if (key === "LLM_ACTIVE_PROFILE") {
      // Saved profiles are the only valid values — the config field
      // otherwise accepts an opaque ID string the user would have to
      // memorize. Listing them here makes the field self-documenting.
      return this.profiles.map((p) => ({
        value: p.id,
        label: p.name || p.id,
        description: [p.backend, p.model || "backend default"].filter(Boolean).join(" · "),
      }));
    }

    if (key === "LLM_BASE_URL") {
      const local: ComboboxOption[] = this.localEndpoints.map((ep) => ({
        value: ep.url,
        label: ep.name,
        description: ep.models?.length ? `${ep.models.length} models · local` : "local",
      }));
      const catalog: ComboboxOption[] = this.catalog
        .filter((c) => c.defaultBaseUrl)
        .map((c) => ({
          value: c.defaultBaseUrl,
          label: c.name,
          description: [
            c.type,
            c.models?.length ? `${c.models.length} models` : "",
            formatSources(providerSources(c)),
          ]
            .filter(Boolean)
            .join(" · "),
        }));
      const seen = new Set<string>();
      return [...local, ...catalog].filter((o) => {
        if (seen.has(o.value)) return false;
        seen.add(o.value);
        return true;
      });
    }

    if (key === "LLM_MODEL") {
      const backend = this.configEntries.find((e) => e.key === "LLM_BACKEND")?.value;
      const baseUrl = this.configEntries.find((e) => e.key === "LLM_BASE_URL")?.value;

      // 1. Local models for the currently configured base URL.
      const localEp = this.localEndpoints.find((ep) => ep.url === baseUrl);
      if (localEp?.models?.length) {
        return localEp.models.map((id: string) => ({
          value: id,
          label: id,
          description: `${localEp.name} (local)`,
        }));
      }

      // 2. Catalog provider matching by base URL — most specific.
      const byUrl = this.catalog.find(
        (c) => c.defaultBaseUrl && baseUrl?.startsWith(c.defaultBaseUrl),
      );
      if (byUrl?.models?.length) {
        return byUrl.models.map((m) => ({
          value: m.id,
          label: m.name,
          description: [
            byUrl.name,
            m.contextWindow ? `${Math.round(Number(m.contextWindow) / 1000)}K` : "",
            formatSources(m.sources),
          ]
            .filter(Boolean)
            .join(" · "),
        }));
      }

      // 3. Live-discovered models for an ad-hoc base URL (not in the
      //    catalog, not a known local endpoint). The user gets the
      //    same dynamic /v1/models-style discovery that the connection
      //    wizard does for saved profiles.
      if (baseUrl) {
        const discovered = this.discoveredModelsByUrl.get(baseUrl);
        if (discovered && discovered.length > 0) {
          return discovered.map((id) => ({
            value: id,
            label: id,
            description: "discovered",
          }));
        }
        // Base URL set but unrecognised and no discovery hits — don't
        // show misleading models from other providers.
        return [];
      }
      return this.catalog
        .filter((c) => c.type === backend)
        .flatMap((c) =>
          (c.models ?? []).map((m) => ({
            value: m.id,
            label: m.name,
            description: [
              c.name,
              m.contextWindow ? `${Math.round(Number(m.contextWindow) / 1000)}K` : "",
              formatSources(m.sources),
            ]
              .filter(Boolean)
              .join(" · "),
          })),
        );
    }

    return [];
  }

  private static readonly SETTINGS_SECTIONS = [
    { id: "appearance", label: "Appearance" },
    { id: "llm", label: "LLM" },
    { id: "chat", label: "Chat" },
    { id: "repo", label: "Repository" },
    { id: "session", label: "Session" },
    { id: "webhook", label: "Webhook" },
  ] as const;

  private configGroupEntries(group: string): ConfigEntry[] {
    return this.configEntries.filter((e) => (e.group || "other") === group);
  }

  private configGroupModifiedCount(group: string): number {
    return this.configGroupEntries(group).filter((e) => e.value !== e.defaultValue).length;
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
        ${entries.map((entry) => {
          const isSecret = this.isSecretEntry(entry);
          const modified = entry.value !== entry.defaultValue;
          const suggestions = this.configSuggestionsFor(entry.key);
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
                : suggestions.length > 0 || this.comboboxEmptyHint(entry.key)
                  ? html`<gc-combobox
                      .options=${suggestions}
                      .value=${entry.value}
                      empty-hint=${this.comboboxEmptyHint(entry.key)}
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
                        this.updateConfigEntry(entry.key, (e.target as HTMLInputElement).value);
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
    switch (this.settingsSection) {
      case "appearance":
        return this.renderAppearance();
      case "llm":
        return this.renderLLMSection();
      default:
        return this.renderConfigGroup(this.settingsSection);
    }
  }

  /** Resolve what LLM is actually in effect, tracing through: active
   * profile (with its model/backend) → config override on LLM_MODEL/
   * LLM_BACKEND → compiled defaults. A profile with an empty `model`
   * field intentionally falls back to the config override, so we note
   * that explicitly rather than just showing "(default)". */
  private effectiveLLMStatus() {
    const activeProfile = this.profiles.find((p) => p.id === this.activeProfileId);
    const modelEntry = this.configEntries.find((e) => e.key === "LLM_MODEL");
    const backendEntry = this.configEntries.find((e) => e.key === "LLM_BACKEND");
    const modelOverride = modelEntry?.value || "";
    const modelDefault = modelEntry?.defaultValue || "";
    const backendOverride = backendEntry?.value || "";
    const backendDefault = backendEntry?.defaultValue || "";

    // Model resolution: profile.model > LLM_MODEL override > LLM_MODEL compiled default.
    // Backend resolution: profile.backend > LLM_BACKEND override > LLM_BACKEND compiled default.
    const model = activeProfile?.model || modelOverride || modelDefault || "(backend default)";
    const backend = activeProfile?.backend || backendOverride || backendDefault || "(unset)";

    let source: string;
    if (activeProfile) {
      source = activeProfile.model
        ? `profile "${activeProfile.name}"`
        : `profile "${activeProfile.name}" (no model saved; falls back to config)`;
    } else if (modelOverride && modelOverride !== modelDefault) {
      source = "LLM_MODEL override (no profile active)";
    } else if (modelOverride) {
      source = "LLM_MODEL (matches compiled default)";
    } else {
      source = "compiled default";
    }

    return { model, backend, source, modelDefault };
  }

  private renderLLMSection() {
    const status = this.effectiveLLMStatus();
    return html`
      <div class="llm-status">
        <div class="llm-status-row">
          <span class="llm-status-label">Active model</span>
          <span class="llm-status-value">${status.model}</span>
        </div>
        <div class="llm-status-row">
          <span class="llm-status-label">Backend</span>
          <span class="llm-status-value">${status.backend}</span>
        </div>
        <div class="llm-status-row">
          <span class="llm-status-label">Source</span>
          <span class="llm-status-value llm-status-source">${status.source}</span>
        </div>
        ${status.modelDefault && status.modelDefault !== status.model
          ? html`<div class="llm-status-row llm-status-subtle">
              <span class="llm-status-label">Compiled default</span>
              <span class="llm-status-value">${status.modelDefault}</span>
            </div>`
          : nothing}
      </div>
      <div class="profiles-section">
        <div class="profiles-header">
          <span class="profiles-label">Profiles</span>
          <div class="profiles-header-actions">
            <button
              class="action-btn"
              ?disabled=${this.catalogLoading}
              @click=${() => this.refreshCatalog()}
              title="Fetch latest provider/model catalog. Sources: catwalk.charm.sh (curated), openrouter.ai (aggregator), models.dev (long-tail providers). Models show their source after the context window size."
            >
              ${this.catalogLoading
                ? "fetching…"
                : this.catalog.length > 0
                  ? `\u21BB ${this.catalog.length} providers`
                  : "fetch catalog"}
            </button>
            <button
              class="action-btn"
              ?disabled=${this.localDiscovering}
              @click=${() => this.discoverLocal()}
              title="Detect LM Studio, Ollama, and other local endpoints"
            >
              ${this.localDiscovering
                ? "scanning…"
                : this.localEndpoints.length > 0
                  ? `${this.localEndpoints.length} local`
                  : "detect local"}
            </button>
            <button
              class="action-btn"
              @click=${() => {
                this.editingProfile = null;
                this.editingProfile = {};
              }}
            >
              + new connection
            </button>
          </div>
        </div>
        <div class="profiles-list">
          ${this.profiles.length === 0
            ? html`<p class="config-empty">
                no profiles yet — click "+ new connection" to get started
              </p>`
            : this.profiles.map(
                (p) => html`
                  <div class="profile-item ${this.activeProfileId === p.id ? "active" : ""}">
                    <button
                      class="profile-name"
                      @click=${() => {
                        this.editingProfile = { ...p };
                      }}
                    >
                      ${p.name}
                      <span class="profile-meta"
                        >${p.backend} · ${p.model || "uses LLM_MODEL / backend default"}</span
                      >
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
                      <button
                        class="action-btn danger"
                        @click=${() => {
                          if (confirm(`Delete profile "${p.name}"?`)) this.deleteProfile(p.id);
                        }}
                      >
                        &times;
                      </button>
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

      ${this.editingProfile
        ? html`<gc-connection-wizard
            .catalog=${this.catalog}
            .localEndpoints=${this.localEndpoints}
            .profile=${this.editingProfile.id ? this.editingProfile : null}
            @gc-profile-save=${async (e: CustomEvent) => {
              const { profile, activate } = e.detail;
              await this.saveProfile(profile);
              if (activate) {
                const saved = this.profiles.find((p) => p.name === profile.name);
                if (saved) await this.activateProfile(saved.id);
              }
              this.editingProfile = null;
            }}
            @gc-profile-cancel=${() => {
              this.editingProfile = null;
            }}
          ></gc-connection-wizard>`
        : nothing}

      <details class="advanced-config">
        <summary>Advanced — raw config entries</summary>
        ${this.renderConfigGroup("llm")}
      </details>
    `;
  }

  private settingsSectionLabel(id: string): string {
    const sections = (this.constructor as typeof GcSettingsPanel).SETTINGS_SECTIONS;
    return sections.find((s) => s.id === id)?.label ?? id;
  }

  override render() {
    if (!this.open) return nothing;
    const sections = (this.constructor as typeof GcSettingsPanel).SETTINGS_SECTIONS;
    return html`
      <div class="modal-backdrop" @click=${() => this.requestClose()}>
        <div
          class="modal settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabindex="-1"
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
                  ${mod > 0 ? html`<span class="config-modified-badge">${mod}</span>` : nothing}
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
                    if (entry.value !== entry.defaultValue) {
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

  static override styles = css`
    :host {
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      color: var(--text);
    }

    /* ── Modal chrome (duplicated from gc-app since shadow DOM walls off parent CSS) ── */
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
      animation: panel-in 0.12s ease;
    }
    @keyframes panel-in {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
    }
    .modal-hint {
      margin: var(--space-4) 0 0;
      opacity: 0.4;
      font-size: var(--text-xs);
      text-align: center;
    }

    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }

    /* ── Settings modal (sidebar layout) ─────────────────────── */
    .settings-modal {
      max-width: min(1100px, 92vw);
      width: 92vw;
      top: 24px;
      max-height: calc(100vh - 48px);
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
      transition:
        opacity 0.1s ease,
        background 0.1s ease;
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
      min-height: 0;
      padding: var(--space-6) var(--space-7);
      overflow-y: auto;
    }
    .settings-section-title {
      margin: 0 0 var(--space-4);
      font-size: var(--text-base);
      font-weight: 500;
    }
    @media (max-width: 640px) {
      .settings-modal {
        flex-direction: column;
        top: 0;
        max-height: 100vh;
        height: 100vh;
        width: 100vw;
        max-width: 100vw;
        border-radius: 0;
      }
      .settings-sidebar {
        width: 100%;
        flex-direction: row;
        flex-wrap: wrap;
        border-right: none;
        border-bottom: 1px solid var(--border-default);
        gap: var(--space-1);
        padding: var(--space-3);
      }
      .settings-title {
        display: none;
      }
      .settings-sidebar-footer {
        display: none;
      }
      .settings-content {
        max-height: none;
        flex: 1;
      }
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

    /* ── Advanced config collapsible ─────────────────────────── */
    .advanced-config {
      margin-top: var(--space-4);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
    }
    .advanced-config summary {
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.5;
      font-weight: 500;
    }
    .advanced-config[open] summary {
      margin-bottom: var(--space-3);
    }

    /* ── LLM Active status ───────────────────────────────────── */
    .llm-status {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-bottom: var(--space-4);
      padding: var(--space-3);
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-left: 3px solid var(--accent-assistant);
      border-radius: var(--radius-md);
      font-size: var(--text-xs);
    }
    .llm-status-row {
      display: grid;
      grid-template-columns: 8em 1fr;
      align-items: baseline;
      column-gap: var(--space-3);
    }
    .llm-status-label {
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 0.65rem;
    }
    .llm-status-value {
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    .llm-status-source {
      opacity: 0.7;
      font-family: inherit;
    }
    .llm-status-subtle {
      opacity: 0.6;
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

    .action-btn.danger {
      color: var(--danger, #e55);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-settings-panel": GcSettingsPanel;
  }
}
