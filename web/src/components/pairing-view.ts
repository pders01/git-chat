import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authClient } from "../lib/transport.js";

type PairingState =
  | { phase: "starting" }
  | { phase: "waiting"; sid: string; code: string; expiresAt: number }
  | { phase: "paired"; principal: string }
  | { phase: "expired"; reason: string }
  | { phase: "error"; message: string };

@customElement("gc-pairing-view")
export class GcPairingView extends LitElement {
  @state() private state: PairingState = { phase: "starting" };

  // host defaults to the current page; can be overridden via attribute for
  // documentation / demo purposes.
  private get sshHost(): string {
    return this.getAttribute("ssh-host") ?? window.location.hostname;
  }
  private get sshPort(): string {
    return this.getAttribute("ssh-port") ?? "2222";
  }

  override connectedCallback() {
    super.connectedCallback();
    void this.startPairing();
  }

  private async startPairing() {
    try {
      const resp = await authClient.startPairing({});
      this.state = {
        phase: "waiting",
        sid: resp.sid,
        code: resp.code,
        expiresAt: Number(resp.expiresAt),
      };
      void this.watchPairing(resp.sid);
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private async watchPairing(sid: string) {
    try {
      for await (const evt of authClient.watchPairing({ sid })) {
        if (evt.kind.case === "paired") {
          const paired = evt.kind.value;
          // Immediately claim — any delay here widens the race window.
          await authClient.claim({
            sid,
            claimToken: paired.claimToken,
          });
          this.state = { phase: "paired", principal: paired.principal };
          this.dispatchEvent(
            new CustomEvent("paired", {
              detail: { principal: paired.principal },
              bubbles: true,
              composed: true,
            }),
          );
          return;
        }
        if (evt.kind.case === "expired") {
          this.state = { phase: "expired", reason: evt.kind.value.reason };
          return;
        }
      }
    } catch (e) {
      this.state = { phase: "error", message: messageOf(e) };
    }
  }

  private renderWaiting(s: Extract<PairingState, { phase: "waiting" }>) {
    const cmd = `ssh -p ${this.sshPort} ${this.sshHost} pair ${s.code}`;
    return html`
      <p class="label">run this in a terminal:</p>
      <pre class="cmd" @click=${() => navigator.clipboard.writeText(cmd)} title="click to copy">
${cmd}</pre
      >
      <p class="hint">
        waiting for pairing · code expires ${new Date(s.expiresAt * 1000).toLocaleTimeString()}
      </p>
    `;
  }

  override render() {
    switch (this.state.phase) {
      case "starting":
        return html`<p class="hint">initializing pairing…</p>`;
      case "waiting":
        return this.renderWaiting(this.state);
      case "paired":
        return html`<p class="ok">paired as ${this.state.principal}</p>`;
      case "expired":
        return html`
          <p class="err">pairing expired (${this.state.reason})</p>
          <button @click=${() => this.startPairing()}>retry</button>
        `;
      case "error":
        return html`
          <p class="err">${this.state.message}</p>
          <button @click=${() => this.startPairing()}>retry</button>
        `;
      default:
        return nothing;
    }
  }

  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    .label {
      margin: 0 0 var(--space-2);
      font-size: 0.8rem;
      opacity: 0.55;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .cmd {
      margin: 0 0 var(--space-3);
      padding: 0.85rem var(--space-4);
      background: var(--surface-1);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      font-size: 0.85rem;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-all;
      cursor: copy;
      user-select: all;
    }
    .cmd:hover {
      border-color: var(--border-focus);
    }
    .hint {
      margin: 0;
      font-size: 0.8rem;
      opacity: 0.55;
    }
    .ok {
      color: var(--accent-assistant);
    }
    .err {
      color: var(--danger);
    }
    button {
      margin-top: var(--space-3);
      font-family: inherit;
      font-size: 0.85rem;
      padding: 0.4rem 0.85rem;
      background: var(--surface-4);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover {
      background: var(--surface-3);
    }
  `;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
