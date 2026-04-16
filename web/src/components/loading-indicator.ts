import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Small spinning circle, inline with text. Two sizes: "sm" (default,
 * ~10px for toolbar buttons) and "lg" (~20px for banners).
 *
 * The parent component is responsible for positioning; this element only
 * owns the spin animation and shape.
 */
@customElement("gc-spinner")
export class GcSpinner extends LitElement {
  @property({ type: String }) size: "sm" | "lg" = "sm";

  static styles = css`
    :host {
      display: inline-block;
      line-height: 0;
    }
    .dot {
      display: inline-block;
      border-radius: 50%;
      border-style: solid;
      border-color: var(--border-default);
      border-top-color: var(--text-accent, var(--text));
      animation: gc-spin 0.8s linear infinite;
    }
    .dot.sm {
      width: 10px;
      height: 10px;
      border-width: 1.5px;
    }
    .dot.lg {
      width: 20px;
      height: 20px;
      border-width: 2px;
    }
    @keyframes gc-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  override render() {
    return html`<span class="dot ${this.size}" aria-hidden="true"></span>`;
  }
}

/**
 * Full-area loading card: a large spinner beside a heading and an
 * optional detail line. Drop it in place of a content area while an
 * expensive RPC resolves.
 *
 * The `heading` prop is the primary "what's happening" line (e.g.
 * "computing blame…"). `detail` is an optional secondary line for
 * context ("this can take a while on large files"). Use the default
 * slot to pass richer content instead of the two props.
 */
@customElement("gc-loading-banner")
export class GcLoadingBanner extends LitElement {
  @property({ type: String }) heading = "loading…";
  @property({ type: String }) detail = "";

  static styles = css`
    :host {
      display: block;
    }
    .wrap {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-4);
      color: var(--text-muted);
    }
    .txt {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .heading {
      color: var(--text);
      font-size: var(--text-sm);
      font-weight: 500;
    }
    .detail {
      font-size: var(--text-xs);
      max-width: 60ch;
    }
  `;

  override render() {
    return html`
      <div class="wrap" role="status" aria-live="polite">
        <gc-spinner size="lg"></gc-spinner>
        <div class="txt">
          <div class="heading">${this.heading}</div>
          ${this.detail ? html`<div class="detail">${this.detail}</div>` : nothing}
          <slot></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-spinner": GcSpinner;
    "gc-loading-banner": GcLoadingBanner;
  }
}
