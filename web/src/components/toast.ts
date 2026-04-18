import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

type ToastKind = "info" | "success" | "warn" | "error";

type ToastItem = {
  id: number;
  message: string;
  kind: ToastKind;
};

const KIND_ICONS: Record<ToastKind, string> = {
  info: "i",
  success: "✓",
  warn: "!",
  error: "×",
};

// Auto-dismiss timing. Errors and warnings linger longer because they
// carry more consequential information.
const DISMISS_MS: Record<ToastKind, number> = {
  info: 4000,
  success: 3500,
  warn: 6000,
  error: 7000,
};

let nextId = 0;

// gc-toast is a singleton mounted at the app level. Any component can
// dispatch a gc:toast CustomEvent (bubbles + composed) and the toast
// will appear. Auto-dismisses after 4s; click to dismiss early.
//
// Usage from any child component:
//   this.dispatchEvent(new CustomEvent("gc:toast", {
//     bubbles: true, composed: true,
//     detail: { message: "Copied!", kind: "success" },
//   }));

@customElement("gc-toast")
export class GcToast extends LitElement {
  @state() private items: ToastItem[] = [];

  override connectedCallback() {
    super.connectedCallback();
    // Listen at the host level — composed events cross shadow DOM.
    this.getRootNode().addEventListener("gc:toast", this.onToast as EventListener);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.getRootNode().removeEventListener("gc:toast", this.onToast as EventListener);
  }

  private onToast = (e: CustomEvent<{ message: string; kind?: string }>) => {
    const id = nextId++;
    const kind = normalizeKind(e.detail.kind);
    const item: ToastItem = { id, message: e.detail.message, kind };
    this.items = [...this.items, item];
    setTimeout(() => this.dismiss(id), DISMISS_MS[kind]);
  };

  private dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }

  override render() {
    return html`
      <div class="stack" role="status" aria-live="polite">
        ${repeat(
          this.items,
          (t) => t.id,
          (t) => html`
            <div class="toast ${t.kind}" role="alert">
              <span class="icon" aria-hidden="true">${KIND_ICONS[t.kind]}</span>
              <span class="message">${t.message}</span>
              <button
                class="close"
                aria-label="Dismiss notification"
                @click=${() => this.dismiss(t.id)}
              >
                ×
              </button>
            </div>
          `,
        )}
      </div>
    `;
  }

  static override styles = css`
    /* Centered bottom-anchored stack — more discoverable than a
       corner, not as intrusive as screen-center. Constrained width so
       long messages don't stretch edge-to-edge. */
    :host {
      position: fixed;
      bottom: var(--space-6);
      left: 50%;
      transform: translateX(-50%);
      z-index: 200;
      pointer-events: none;
      width: min(480px, calc(100vw - 2 * var(--space-5)));
    }
    .stack {
      display: flex;
      flex-direction: column-reverse;
      gap: var(--space-2);
    }
    .toast {
      pointer-events: auto;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-lg);
      font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      font-size: var(--text-sm);
      line-height: 1.4;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 2px 4px rgba(0, 0, 0, 0.25);
      animation: slide-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      font-size: 0.78rem;
      font-weight: 700;
      flex-shrink: 0;
      font-family: var(--font-mono, ui-monospace, monospace);
    }
    .message {
      min-width: 0;
      word-wrap: break-word;
    }
    .close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: inherit;
      opacity: 0.55;
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.12s ease, background 0.12s ease;
    }
    .close:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.08);
    }
    .close:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 1px;
    }

    /* Kind variants. Each gets a stronger border and icon colour so
       the message registers pre-attentively. */
    .info {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-strong);
    }
    .info .icon {
      background: var(--surface-4);
      color: var(--text-secondary, var(--text));
    }
    .success {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-accent);
    }
    .success .icon {
      background: var(--accent-assistant);
      color: var(--surface-0);
    }
    .warn {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid color-mix(in srgb, var(--warning, #e2b93a) 70%, var(--border-strong));
    }
    .warn .icon {
      background: var(--warning, #e2b93a);
      color: var(--surface-0);
    }
    .error {
      background: var(--danger-bg);
      color: var(--danger);
      border: 1px solid var(--danger-border);
    }
    .error .icon {
      background: var(--danger);
      color: var(--danger-bg);
    }

    @keyframes slide-in {
      from {
        transform: translateY(14px);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast {
        animation: none;
      }
      .close {
        transition: none;
      }
    }
  `;
}

function normalizeKind(raw: unknown): ToastKind {
  if (raw === "success" || raw === "warn" || raw === "error" || raw === "info") return raw;
  return "info";
}

// Helper for dispatching toast from anywhere.
export function toast(el: HTMLElement, message: string, kind: ToastKind = "info") {
  el.dispatchEvent(
    new CustomEvent("gc:toast", {
      bubbles: true,
      composed: true,
      detail: { message, kind },
    }),
  );
}
