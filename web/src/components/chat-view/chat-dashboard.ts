import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { chatClient, repoClient } from "../../lib/transport.js";
import "./../../components/loading-indicator.js";

@customElement("gc-chat-dashboard")
export class GcChatDashboard extends LitElement {
  @property({ type: String }) repoId = "";

  @state() private activitySummary = "";
  @state() private summaryLoading = false;
  private cachedSummaryKey = "";
  @state() private suggestions: Array<{ label: string; prompt: string }> = [];

  override updated(changed: Map<string, unknown>) {
    if (changed.has("repoId") && this.repoId) {
      void this.loadDashboard();
    }
  }

  private async loadDashboard() {
    // 1. Suggestions from commits — instant, no LLM.
    try {
      const commits = await repoClient.listCommits({ repoId: this.repoId, limit: 5, offset: 0 });
      const sug: Array<{ label: string; prompt: string }> = [];
      sug.push({ label: "overview", prompt: "What is this project about?" });
      if (commits.commits.length > 0) {
        const latest = commits.commits[0];
        sug.push({
          label: "latest",
          prompt: `What changed in commit ${latest.shortSha} ("${latest.message}")?`,
        });
      }
      if (commits.commits.length > 2) {
        sug.push({
          label: "recent",
          prompt: "What areas of the codebase have been worked on recently?",
        });
      }
      this.suggestions = sug.slice(0, 3);
    } catch {
      this.suggestions = [{ label: "overview", prompt: "What is this project about?" }];
    }

    // 2. LLM summary — cached by HEAD SHA, only re-fetch on new commits.
    try {
      const repos = await repoClient.listRepos({});
      const repo = repos.repos.find((r) => r.id === this.repoId);
      const headSha = repo?.headCommit ?? "";
      const cacheKey = `${this.repoId}:${headSha}`;
      if (cacheKey === this.cachedSummaryKey && this.activitySummary) return;

      this.summaryLoading = true;
      const resp = await chatClient.summarizeActivity({ repoId: this.repoId });
      this.activitySummary = resp.summary || "";
      this.cachedSummaryKey = cacheKey;
    } catch {
      this.activitySummary = "";
    } finally {
      this.summaryLoading = false;
    }
  }

  private prefillExample(text: string) {
    this.dispatchEvent(
      new CustomEvent("gc:prefill-example", {
        bubbles: true,
        composed: true,
        detail: { text },
      }),
    );
  }

  override render() {
    return html`
      <div class="empty-chat">
        <div class="empty-title">ready when you are</div>
        <p class="empty-sub">
          ask about the repo — use <code>@path/to/file</code> to include file contents
        </p>

        ${this.suggestions.length > 0
          ? html`
              <div class="empty-examples">
                ${this.suggestions.map(
                  (s) => html`
                    <button class="example" @click=${() => this.prefillExample(s.prompt)}>
                      <span class="example-head">${s.label}</span>
                      <span class="example-body">${s.prompt.split("\n")[0].slice(0, 80)}</span>
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <div class="recent-activity">
          <div class="recent-title">recent activity</div>
          ${this.summaryLoading
            ? html`<p class="activity-text loading">
                <gc-spinner></gc-spinner>
                summarizing recent changes…
              </p>`
            : this.activitySummary
              ? html`<p class="activity-text">${this.activitySummary}</p>`
              : nothing}
        </div>
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.82rem;
      color: var(--text);
    }
    .empty-chat {
      max-width: var(--content-max-width);
      margin: 4rem auto 0;
      text-align: center;
    }
    .empty-title {
      font-size: 1.1rem;
      font-weight: 500;
      margin-bottom: var(--space-2);
      color: var(--text);
    }
    .empty-sub {
      margin: 0 0 var(--space-7);
      opacity: 0.55;
      font-size: 0.82rem;
      line-height: 1.6;
    }
    .empty-sub code {
      font-family: inherit;
      padding: 0.08em 0.4em;
      background: var(--surface-2);
      border: 1px solid var(--surface-4);
      border-radius: 3px;
      font-size: 0.9em;
    }
    .empty-examples {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.55rem;
      text-align: left;
    }
    .example {
      padding: var(--space-3) 0.95rem;
      background: var(--surface-1-alt);
      border: 1px solid var(--surface-4);
      border-radius: 5px;
      color: var(--text);
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      text-align: left;
      transition:
        background 0.12s ease,
        border-color 0.12s ease;
    }
    .example:hover {
      background: var(--surface-2);
      border-color: var(--border-strong);
    }
    .example-head {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.5;
      color: var(--accent-assistant);
    }
    .example-body {
      font-size: 0.78rem;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .recent-activity {
      margin-top: var(--space-4);
      text-align: left;
    }
    .recent-title {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.4;
      margin-bottom: var(--space-2);
    }
    .activity-text {
      font-size: var(--text-xs);
      line-height: 1.6;
      opacity: 0.6;
      margin: 0;
    }
    .activity-text.loading {
      opacity: 0.35;
      font-style: italic;
    }
    @media (prefers-reduced-motion: reduce) {
      .example {
        transition: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-chat-dashboard": GcChatDashboard;
  }
}
