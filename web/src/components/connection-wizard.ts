import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repoClient } from "../lib/transport.js";
import type {
  CatalogModel,
  CatalogProvider,
  LLMProfile,
  LocalEndpoint,
} from "../gen/gitchat/v1/repo_pb.js";
import { formatSources, providerSources, isLocalhostURL } from "../lib/catalog.js";
import "./combobox.js";
import type { ComboboxOption } from "./combobox.js";

type Step = "provider" | "auth" | "model" | "save";

/**
 * <gc-connection-wizard> — stepped form for creating/editing LLM profiles.
 *
 * Flow: provider → auth → model → save
 * Also supports a "manual" mode that shows all fields at once.
 *
 * Events:
 *   gc-profile-save: { profile: {...} }   — user clicked save/save & activate
 *   gc-profile-cancel                     — user clicked cancel
 */
@customElement("gc-connection-wizard")
export class GcConnectionWizard extends LitElement {
  /** Catalog providers for the combobox. */
  @property({ type: Array }) catalog: CatalogProvider[] = [];

  /** Local discovered endpoints. */
  @property({ type: Array }) localEndpoints: LocalEndpoint[] = [];

  /** Existing profile for editing (null = new). */
  @property({ type: Object }) profile: LLMProfile | null = null;

  @state() private step: Step = "provider";
  @state() private manual = false;

  // Form state
  @state() private name = "";
  @state() private backend = "openai";
  @state() private baseUrl = "";
  @state() private model = "";
  @state() private apiKey = "";
  @state() private temperature = "";
  @state() private maxTokens = "";
  @state() private systemPrompt = "";

  // Discovery state
  @state() private discovering = false;
  @state() private discoveredModels: string[] = [];
  @state() private discoverError = "";
  @state() private providerName = "";
  // Richer model metadata from the catalog, used in preference to the
  // bare discoveredModels when the user picks a catalog-known provider.
  // Carries pricing/context/source data so the model step can render
  // without a live /v1/models probe.
  @state() private catalogModels: CatalogModel[] = [];

  override connectedCallback() {
    super.connectedCallback();
    if (this.profile) {
      this.name = this.profile.name ?? "";
      this.backend = this.profile.backend ?? "openai";
      this.baseUrl = this.profile.baseUrl ?? "";
      this.model = this.profile.model ?? "";
      this.apiKey = "";
      this.temperature = this.profile.temperature ?? "";
      this.maxTokens = this.profile.maxTokens ?? "";
      this.systemPrompt = this.profile.systemPrompt ?? "";
      // For editing, start at provider step but pre-fill.
      this.step = "provider";
      // Seed the model dropdown from the catalog when the edited
      // profile's base URL matches a known provider — same UX as the
      // new-connection flow, no live probe required.
      const prov = this.catalog.find(
        (c) => c.defaultBaseUrl && this.baseUrl.startsWith(c.defaultBaseUrl),
      );
      if (prov?.models?.length) {
        this.catalogModels = prov.models;
        this.providerName = prov.name;
      }
      // Silent remote probes are banned (see PATTERNS.md §7). For
      // localhost the auto-probe is fine (no cost, no leak). For a
      // remote profile we leave the dropdown seeded from the catalog
      // above; the user hits "test connection" to force a live probe
      // that exercises the stored key.
      if (this.baseUrl && isLocalhostURL(this.baseUrl)) {
        this.discoverModelsForEdit();
      }
    }
  }

  /**
   * Silently discover models for an existing profile's base URL.
   * Uses the saved API key (masked or not) — the server still holds
   * the real key for profiles that were previously saved.
   */
  private async discoverModelsForEdit() {
    try {
      const resp = await repoClient.discoverModels({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
      });
      if (!resp.error) {
        this.discoveredModels = resp.modelIds ?? [];
        if (resp.providerName) this.providerName = resp.providerName;
        // Fresh live results override the catalog seed — same rule as
        // testConnection, so edit and new-connection flows stay aligned.
        if (this.discoveredModels.length > 0) {
          this.catalogModels = [];
        }
      }
    } catch {
      // Silent — editing can proceed without pre-populated models.
    }
  }

  // ── Provider options ────────────────────────────────────────

  private get providerOptions(): ComboboxOption[] {
    const local: ComboboxOption[] = this.localEndpoints.map((ep) => ({
      value: `local:${ep.url}`,
      label: ep.name,
      description: `local · ${ep.models?.length ?? 0} models`,
    }));
    const cat: ComboboxOption[] = [...this.catalog]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const sourceTag = formatSources(providerSources(c));
        return {
          value: c.id,
          label: c.name,
          description: [c.type, `${c.models?.length ?? 0} models`, sourceTag]
            .filter(Boolean)
            .join(" · "),
        };
      });
    return [
      ...local,
      ...cat,
      { value: "openai", label: "openai (custom)", description: "OpenAI-compatible endpoint" },
      { value: "anthropic", label: "anthropic (custom)", description: "Anthropic API" },
    ];
  }

  /**
   * True when the current page is served over plain HTTP to a non-loopback
   * host. In that case the API key would travel in clear-text between
   * browser and git-chat server and the user deserves a warning before
   * entering one.
   */
  private get uiIsPlaintext(): boolean {
    if (typeof window === "undefined") return false;
    if (window.location.protocol !== "http:") return false;
    const host = window.location.hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  }

  private get modelOptions(): ComboboxOption[] {
    // Prefer catalog entries when we have them — they carry source,
    // context window, and pricing metadata that a bare /v1/models
    // response can't. Live-discovered IDs are the fallback when the
    // user picked a custom or local provider outside the catalog.
    if (this.catalogModels.length > 0) {
      return this.catalogModels.map((m) => {
        const sourceTag = formatSources(m.sources);
        const ctx = m.contextWindow
          ? `${Math.round(Number(m.contextWindow) / 1000)}K`
          : "";
        return {
          value: m.id,
          label: m.name || m.id,
          description: [this.providerName, ctx, sourceTag]
            .filter(Boolean)
            .join(" · "),
        };
      });
    }
    return this.discoveredModels.map((id) => ({
      value: id,
      label: id,
      description: this.providerName || "discovered",
    }));
  }

  // ── Actions ─────────────────────────────────────────────────

  private selectProvider(opt: ComboboxOption) {
    // Reset catalog-derived state on every provider change so stale
    // models from a previous selection don't leak into the model step.
    this.catalogModels = [];
    this.discoveredModels = [];

    if (opt.value.startsWith("local:")) {
      const url = opt.value.slice(6);
      this.backend = "openai";
      this.baseUrl = url;
      this.providerName = opt.label;
      const ep = this.localEndpoints.find((e) => e.url === url);
      if (ep?.models?.length) {
        this.discoveredModels = ep.models;
        this.step = "model";
        return;
      }
    } else {
      const prov = this.catalog.find((c) => c.id === opt.value);
      if (prov) {
        this.backend = prov.type;
        this.baseUrl = prov.defaultBaseUrl ?? "";
        this.providerName = prov.name;
        this.model = prov.defaultModelId ?? "";
        // Catalog already carries the model list — no /v1/models probe
        // needed to populate the dropdown. The user can still advance
        // through auth to validate their key; the model step renders
        // from this immediately.
        if (prov.models?.length) {
          this.catalogModels = prov.models;
        }
      } else {
        this.backend = opt.value;
        this.providerName = opt.label;
      }
    }
    // Local endpoints without auth → go straight to model discovery.
    if (this.baseUrl.startsWith("http://localhost") || this.baseUrl.startsWith("http://127.")) {
      this.testConnection();
      this.step = "auth";
    } else {
      this.step = "auth";
    }
  }

  private async testConnection() {
    this.discovering = true;
    this.discoverError = "";
    this.discoveredModels = [];
    try {
      const resp = await repoClient.discoverModels({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
      });
      if (resp.error) {
        this.discoverError = resp.error;
      } else {
        this.discoveredModels = resp.modelIds ?? [];
        if (resp.providerName) this.providerName = resp.providerName;
        if (this.discoveredModels.length > 0) {
          // Live discovery succeeded — prefer it over the catalog snapshot,
          // which may be stale (new models released since last refresh).
          this.catalogModels = [];
          this.step = "model";
        }
      }
    } catch (e: any) {
      this.discoverError = e.message ?? "Connection failed";
    } finally {
      this.discovering = false;
    }
  }

  private goToSave() {
    if (!this.name) {
      // Auto-generate name from provider + model.
      const modelShort = this.model.split("/").pop() ?? this.model;
      this.name = `${this.providerName || this.backend} — ${modelShort}`;
    }
    this.step = "save";
  }

  private save(andActivate: boolean) {
    this.dispatchEvent(
      new CustomEvent("gc-profile-save", {
        detail: {
          profile: {
            id: this.profile?.id ?? "",
            name: this.name,
            backend: this.backend,
            baseUrl: this.baseUrl,
            model: this.model,
            apiKey: this.apiKey || this.profile?.apiKey || "",
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            systemPrompt: this.systemPrompt,
          },
          activate: andActivate,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private cancel() {
    this.dispatchEvent(new CustomEvent("gc-profile-cancel", { bubbles: true, composed: true }));
  }

  // ── Render ──────────────────────────────────────────────────

  override render() {
    if (this.manual) return this.renderManual();
    return html`
      <div class="wizard">
        <div class="wizard-header">
          <h4 class="wizard-title">${this.profile ? "Edit Profile" : "New Connection"}</h4>
          <button class="mode-toggle" @click=${() => (this.manual = true)}>manual entry</button>
        </div>
        <div class="steps">${this.renderStepIndicator()}</div>
        <div class="step-content">
          ${this.step === "provider" ? this.renderProviderStep() : nothing}
          ${this.step === "auth" ? this.renderAuthStep() : nothing}
          ${this.step === "model" ? this.renderModelStep() : nothing}
          ${this.step === "save" ? this.renderSaveStep() : nothing}
        </div>
        <div class="wizard-footer">
          ${this.step !== "provider"
            ? html`<button class="btn" @click=${() => this.goBack()}>back</button>`
            : nothing}
          <span class="spacer"></span>
          <button class="btn" @click=${() => this.cancel()}>cancel</button>
        </div>
      </div>
    `;
  }

  private renderStepIndicator() {
    const steps: { id: Step; label: string }[] = [
      { id: "provider", label: "Provider" },
      { id: "auth", label: "Connect" },
      { id: "model", label: "Model" },
      { id: "save", label: "Save" },
    ];
    const order: Step[] = ["provider", "auth", "model", "save"];
    const current = order.indexOf(this.step);
    return html`
      ${steps.map(
        (s, i) => html`
          <button
            class=${classMap({ "step-dot": true, done: i <= current, active: this.step === s.id })}
            @click=${() => {
              if (i <= current) this.step = s.id;
            }}
            ?disabled=${i > current}
          >
            ${s.label}
          </button>
          ${i < steps.length - 1
            ? html`<span class="step-line ${i < current ? "done" : ""}"></span>`
            : nothing}
        `,
      )}
    `;
  }

  private renderProviderStep() {
    return html`
      <div class="step-body">
        <p class="step-desc">Where do you want to connect?</p>
        ${this.localEndpoints.length > 0
          ? html`
              <div class="quick-connect">
                <span class="quick-label">Local</span>
                ${this.localEndpoints.map(
                  (ep) => html`
                    <button
                      class="quick-btn"
                      @click=${() =>
                        this.selectProvider({
                          value: `local:${ep.url}`,
                          label: ep.name,
                          description: "",
                        })}
                    >
                      ${ep.name}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}
        <label class="field">
          <span>Search providers</span>
          <gc-combobox
            .options=${this.providerOptions}
            .value=${""}
            placeholder="Type to search or paste a base URL…"
            @gc-select=${(e: CustomEvent) => this.selectProvider(e.detail)}
          ></gc-combobox>
        </label>
        <label class="field">
          <span>Or paste a base URL directly</span>
          <input
            type="text"
            class="input"
            placeholder="https://api.example.com/v1"
            .value=${this.baseUrl}
            @input=${(e: Event) => {
              this.baseUrl = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && this.baseUrl) {
                this.providerName = "";
                this.step = "auth";
              }
            }}
          />
        </label>
        ${this.baseUrl
          ? html`<button
              class="btn primary"
              @click=${() => {
                this.providerName = "";
                this.step = "auth";
              }}
            >
              next
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderAuthStep() {
    const isLocal =
      this.baseUrl.startsWith("http://localhost") || this.baseUrl.startsWith("http://127.");
    return html`
      <div class="step-body">
        <p class="step-desc">
          ${this.providerName ? `Connect to ${this.providerName}` : `Connect to ${this.baseUrl}`}
        </p>
        <div class="connection-info">
          <span class="info-label">Endpoint:</span>
          <code>${this.baseUrl}</code>
        </div>
        ${!isLocal
          ? html`
              ${this.uiIsPlaintext
                ? html`<p class="warn">
                    This page is served over plain HTTP. Your API key will be sent to the server in
                    the clear — use HTTPS or a localhost deployment before entering a real key.
                  </p>`
                : nothing}
              <label class="field">
                <span>API Key</span>
                <input
                  type="password"
                  class="input"
                  autocomplete="off"
                  placeholder=${this.profile?.apiKey === "••••••••"
                    ? "current key preserved"
                    : "sk-..."}
                  .value=${this.apiKey}
                  @input=${(e: Event) => {
                    this.apiKey = (e.target as HTMLInputElement).value;
                  }}
                />
              </label>
            `
          : nothing}
        <div class="auth-actions">
          <button
            class="btn primary"
            ?disabled=${this.discovering}
            @click=${() => this.testConnection()}
          >
            ${this.discovering ? "connecting…" : "test connection"}
          </button>
          ${this.catalogModels.length > 0
            ? html`<button
                class="btn secondary"
                type="button"
                @click=${() => {
                  this.step = "model";
                }}
                title="Skip validation — pick from the ${this.catalogModels.length} catalog models"
              >
                use catalog models (${this.catalogModels.length})
              </button>`
            : nothing}
        </div>
        ${this.discoverError ? html`<p class="error">${this.discoverError}</p>` : nothing}
        ${this.discoveredModels.length > 0
          ? html`<p class="success">
              Connected · ${this.discoveredModels.length} models available
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderModelStep() {
    return html`
      <div class="step-body">
        <p class="step-desc">Choose a model</p>
        <label class="field">
          <span>Model</span>
          <gc-combobox
            .options=${this.modelOptions}
            .value=${this.model}
            placeholder="Search models…"
            @gc-select=${(e: CustomEvent) => {
              this.model = e.detail.value;
            }}
            @gc-input=${(e: CustomEvent) => {
              this.model = e.detail;
            }}
          ></gc-combobox>
        </label>
        <details class="advanced">
          <summary>Advanced</summary>
          <label class="field">
            <span>Temperature</span>
            <input
              type="text"
              class="input"
              placeholder="0"
              .value=${this.temperature}
              @input=${(e: Event) => {
                this.temperature = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field">
            <span>Max Tokens</span>
            <input
              type="text"
              class="input"
              placeholder="0 (default)"
              .value=${this.maxTokens}
              @input=${(e: Event) => {
                this.maxTokens = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
        </details>
        ${this.model
          ? html`<button class="btn primary" @click=${() => this.goToSave()}>next</button>`
          : nothing}
      </div>
    `;
  }

  private renderSaveStep() {
    return html`
      <div class="step-body">
        <p class="step-desc">Save this configuration</p>
        <label class="field">
          <span>Profile name</span>
          <input
            type="text"
            class="input"
            .value=${this.name}
            @input=${(e: Event) => {
              this.name = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <label class="field">
          <span>System prompt (optional)</span>
          <textarea
            class="input textarea"
            rows="3"
            placeholder="Additional instructions appended to the base prompt…"
            .value=${this.systemPrompt}
            @input=${(e: Event) => {
              this.systemPrompt = (e.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
          <span class="field-hint"
            >e.g. "respond concisely", "use German", model-specific instructions</span
          >
        </label>
        <div class="save-actions">
          <button class="btn primary" @click=${() => this.save(true)}>save & activate</button>
          <button class="btn" @click=${() => this.save(false)}>save</button>
        </div>
      </div>
    `;
  }

  private renderManual() {
    return html`
      <div class="wizard">
        <div class="wizard-header">
          <h4 class="wizard-title">${this.profile ? "Edit Profile" : "Manual Entry"}</h4>
          <button class="mode-toggle" @click=${() => (this.manual = false)}>guided setup</button>
        </div>
        <div class="step-body">
          <label class="field"
            ><span>Name</span>
            <input
              type="text"
              class="input"
              .value=${this.name}
              @input=${(e: Event) => {
                this.name = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>Backend</span>
            <gc-combobox
              .options=${[
                { value: "openai", label: "openai" },
                { value: "anthropic", label: "anthropic" },
              ]}
              .value=${this.backend}
              @gc-select=${(e: CustomEvent) => {
                this.backend = e.detail.value;
                this.requestUpdate();
              }}
              @gc-input=${(e: CustomEvent) => {
                this.backend = e.detail;
              }}
            ></gc-combobox>
          </label>
          <label class="field"
            ><span>Base URL</span>
            <input
              type="text"
              class="input"
              .value=${this.baseUrl}
              @input=${(e: Event) => {
                this.baseUrl = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>Model</span>
            <input
              type="text"
              class="input"
              .value=${this.model}
              @input=${(e: Event) => {
                this.model = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>API Key</span>
            <input
              type="password"
              class="input"
              autocomplete="off"
              placeholder=${this.profile?.apiKey === "••••••••" ? "current key preserved" : ""}
              .value=${this.apiKey}
              @input=${(e: Event) => {
                this.apiKey = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>Temperature</span>
            <input
              type="text"
              class="input"
              placeholder="0"
              .value=${this.temperature}
              @input=${(e: Event) => {
                this.temperature = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>Max Tokens</span>
            <input
              type="text"
              class="input"
              placeholder="0"
              .value=${this.maxTokens}
              @input=${(e: Event) => {
                this.maxTokens = (e.target as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field"
            ><span>System Prompt</span>
            <textarea
              class="input textarea"
              rows="3"
              placeholder="Optional additional instructions…"
              .value=${this.systemPrompt}
              @input=${(e: Event) => {
                this.systemPrompt = (e.target as HTMLTextAreaElement).value;
              }}
            ></textarea>
          </label>
        </div>
        <div class="save-actions">
          <button class="btn primary" @click=${() => this.save(true)}>save & activate</button>
          <button class="btn" @click=${() => this.save(false)}>save</button>
          <button class="btn" @click=${() => this.cancel()}>cancel</button>
        </div>
      </div>
    `;
  }

  private goBack() {
    const order: Step[] = ["provider", "auth", "model", "save"];
    const i = order.indexOf(this.step);
    if (i > 0) this.step = order[i - 1];
  }

  static override styles = css`
    :host {
      display: block;
    }
    .wizard {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--surface-0);
      padding: var(--space-4);
    }
    .wizard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
    }
    .wizard-title {
      margin: 0;
      font-size: var(--text-sm);
      font-weight: 500;
    }
    .mode-toggle {
      background: none;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      padding: 2px 8px;
      cursor: pointer;
      opacity: 0.6;
    }
    .mode-toggle:hover {
      opacity: 1;
    }

    /* Step indicator */
    .steps {
      display: flex;
      align-items: center;
      gap: 0;
      margin-bottom: var(--space-4);
    }
    .step-dot {
      background: none;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      padding: var(--space-1) var(--space-2);
      cursor: pointer;
      opacity: 0.35;
      border-radius: var(--radius-sm);
      transition: opacity 0.1s;
    }
    .step-dot.done {
      opacity: 0.6;
    }
    .step-dot.active {
      opacity: 1;
      background: var(--surface-3);
      font-weight: 500;
    }
    .step-dot:disabled {
      cursor: default;
    }
    .step-line {
      flex: 1;
      height: 1px;
      background: var(--border-default);
      min-width: 12px;
    }
    .step-line.done {
      background: var(--accent-assistant);
    }

    /* Step content */
    .step-body {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .step-desc {
      margin: 0;
      font-size: var(--text-sm);
      opacity: 0.7;
    }

    /* Fields */
    .field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: var(--text-xs);
    }
    .field > span {
      font-weight: 500;
    }
    .field-hint {
      font-size: 0.65rem;
      opacity: 0.4;
    }
    .input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-1) var(--space-2);
      background: var(--surface-1);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--text-xs);
      outline: none;
    }
    .input:focus {
      border-color: var(--accent-assistant);
    }
    .textarea {
      resize: vertical;
      min-height: 3em;
    }

    /* Quick connect */
    .quick-connect {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .quick-label {
      font-size: var(--text-xs);
      opacity: 0.5;
      font-weight: 500;
    }
    .quick-btn {
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      padding: var(--space-1) var(--space-3);
      cursor: pointer;
    }
    .quick-btn:hover {
      border-color: var(--accent-assistant);
    }

    /* Connection info */
    .connection-info {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-xs);
      opacity: 0.7;
    }
    .info-label {
      font-weight: 500;
    }
    code {
      background: var(--surface-2);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
    }

    /* Feedback */
    .error {
      color: var(--danger);
      font-size: var(--text-xs);
      margin: 0;
    }
    .success {
      color: var(--success, #16a34a);
      font-size: var(--text-xs);
      margin: 0;
    }
    .warn {
      color: var(--warning, #b45309);
      background: var(--surface-2);
      border-left: 2px solid var(--warning, #b45309);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      margin: 0;
      padding: var(--space-1) var(--space-2);
      line-height: 1.4;
    }

    /* Advanced */
    details.advanced {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
    }
    details.advanced summary {
      font-size: var(--text-xs);
      cursor: pointer;
      opacity: 0.6;
    }
    details.advanced[open] summary {
      margin-bottom: var(--space-2);
    }

    /* Buttons */
    .btn {
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: inherit;
      font-size: var(--text-xs);
      padding: var(--space-1) var(--space-3);
      cursor: pointer;
    }
    .btn:hover {
      border-color: var(--border-strong);
    }
    .btn.primary {
      background: var(--accent-assistant);
      color: #fff;
      border-color: var(--accent-assistant);
    }
    .btn.secondary {
      background: transparent;
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .auth-actions {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
    }

    /* Footer */
    .wizard-footer {
      display: flex;
      align-items: center;
      margin-top: var(--space-3);
      padding-top: var(--space-3);
      border-top: 1px solid var(--border-default);
    }
    .spacer {
      flex: 1;
    }

    .save-actions {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
  `;
}
