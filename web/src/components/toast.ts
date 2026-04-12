import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";

type ToastItem = {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
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
    const item: ToastItem = {
      id,
      message: e.detail.message,
      kind: (e.detail.kind as ToastItem["kind"]) || "info",
    };
    this.items = [...this.items, item];
    setTimeout(() => this.dismiss(id), 4000);
  };

  private dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }

  override render() {
    return html`
      <div class="stack" role="alert" aria-live="polite">
        ${this.items.map(
          (t) => html`
            <div class="toast ${t.kind}" @click=${() => this.dismiss(t.id)}>${t.message}</div>
          `,
        )}
      </div>
    `;
  }

  static override styles = css`
    :host {
      position: fixed;
      bottom: var(--space-5);
      right: var(--space-5);
      z-index: 200;
      pointer-events: none;
    }
    .stack {
      display: flex;
      flex-direction: column-reverse;
      gap: var(--space-2);
    }
    .toast {
      pointer-events: auto;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-lg);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      cursor: pointer;
      animation: slide-in 0.2s ease;
      max-width: 360px;
    }
    .info {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border-default);
    }
    .error {
      background: var(--danger-bg);
      color: var(--danger);
      border: 1px solid var(--danger-border);
    }
    .success {
      background: var(--action-bg);
      color: var(--accent-assistant);
      border: 1px solid var(--border-accent);
    }
    @keyframes slide-in {
      from {
        transform: translateY(10px);
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast {
        animation: none;
      }
    }
  `;
}

// Helper for dispatching toast from anywhere.
export function toast(
  el: HTMLElement,
  message: string,
  kind: "info" | "error" | "success" = "info",
) {
  el.dispatchEvent(
    new CustomEvent("gc:toast", {
      bubbles: true,
      composed: true,
      detail: { message, kind },
    }),
  );
}
