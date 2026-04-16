import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { parseUnifiedDiff, type ParsedDiff } from "../lib/diff-parse.js";
import "./loading-indicator.js";

// Lazy-load highlight — same lazy pattern other views use.
let highlightModule: Promise<typeof import("../lib/highlight.js")> | null = null;
function loadHighlight() {
  if (!highlightModule) highlightModule = import("../lib/highlight.js");
  return highlightModule;
}

/**
 * Three-pane diff view: old file | unified diff | new file. The three
 * columns scroll in line-matched lockstep — scrolling one projects the
 * top-visible line through the parsed diff's old↔new↔diff maps and
 * drives the other two.
 *
 * The component takes all three texts as properties so the caller can
 * fetch them however it prefers (file-view caches, getFile, etc.) and
 * doesn't need to care about the internal highlighting or parsing.
 */
@customElement("gc-three-pane-view")
export class GcThreePaneView extends LitElement {
  @property({ type: String }) leftText = "";
  @property({ type: String }) rightText = "";
  @property({ type: String }) rawDiff = "";
  /** Shiki language id; used for left and right panes. Middle is always "diff". */
  @property({ type: String }) language = "plaintext";
  /** Shown above each pane for context. Purely cosmetic. */
  @property({ type: String }) leftLabel = "before";
  @property({ type: String }) rightLabel = "after";

  @state() private leftHtml = "";
  @state() private rightHtml = "";
  @state() private middleLines: { text: string; kind: string }[] = [];
  @state() private ready = false;

  private parsed: ParsedDiff | null = null;
  // Cached pixel line-heights, measured once per render so we don't
  // read layout on every scroll event.
  private leftLineHeight = 0;
  private rightLineHeight = 0;
  private middleLineHeight = 0;

  // Guard against infinite scroll-sync loops: when we programmatically
  // scroll a pane, its own scroll handler would otherwise re-fire and
  // bounce back. `syncSource` holds the pane currently driving the
  // update; other panes' handlers bail until the next user input.
  private syncSource: "left" | "middle" | "right" | null = null;
  private syncClearHandle = 0;

  override updated(changed: Map<string, unknown>) {
    if (changed.has("rawDiff")) {
      this.parsed = parseUnifiedDiff(this.rawDiff);
      this.middleLines = this.parsed.lines.map((l) => ({ text: l.text, kind: l.kind }));
    }
    if (
      changed.has("leftText") ||
      changed.has("rightText") ||
      changed.has("rawDiff") ||
      changed.has("language")
    ) {
      void this.rebuild();
    }
  }

  private async rebuild() {
    this.ready = false;
    const { highlight } = await loadHighlight();
    const [leftHtml, rightHtml] = await Promise.all([
      this.leftText ? highlight(this.leftText, this.language) : Promise.resolve(""),
      this.rightText ? highlight(this.rightText, this.language) : Promise.resolve(""),
    ]);
    this.leftHtml = leftHtml;
    this.rightHtml = rightHtml;
    this.ready = true;
    // Measure line heights on the next frame once the new HTML is
    // painted. Assumes monospace so every line has the same height.
    requestAnimationFrame(() => this.measureLineHeights());
  }

  private measureLineHeights() {
    const left = this.renderRoot.querySelector<HTMLElement>(".pane-left .line");
    const right = this.renderRoot.querySelector<HTMLElement>(".pane-right .line");
    const middle = this.renderRoot.querySelector<HTMLElement>(".pane-middle .diff-line");
    if (left) this.leftLineHeight = left.offsetHeight || 20;
    if (right) this.rightLineHeight = right.offsetHeight || 20;
    if (middle) this.middleLineHeight = middle.offsetHeight || 20;
  }

  private onScroll(source: "left" | "middle" | "right", e: Event) {
    if (!this.parsed || !this.ready) return;
    if (this.syncSource && this.syncSource !== source) return; // programmatic, ignore
    this.syncSource = source;

    const el = e.currentTarget as HTMLElement;
    const scrollTop = el.scrollTop;
    const lh =
      source === "left"
        ? this.leftLineHeight
        : source === "middle"
          ? this.middleLineHeight
          : this.rightLineHeight;
    if (lh <= 0) {
      this.clearSyncSource();
      return;
    }
    const topLine = Math.max(0, Math.round(scrollTop / lh));

    // Project the top-visible line in the driver pane to the other two.
    let targetOld: number | null = null;
    let targetNew: number | null = null;
    let targetDiffIdx: number | null = null;

    if (source === "left") {
      targetOld = topLine + 1;
      targetNew =
        this.parsed.oldToNew.get(targetOld) ?? nearest(this.parsed.oldToNew, targetOld) ?? null;
      targetDiffIdx =
        this.parsed.oldToDiff.get(targetOld) ?? nearest(this.parsed.oldToDiff, targetOld) ?? null;
    } else if (source === "right") {
      targetNew = topLine + 1;
      targetOld =
        this.parsed.newToOld.get(targetNew) ?? nearest(this.parsed.newToOld, targetNew) ?? null;
      targetDiffIdx =
        this.parsed.newToDiff.get(targetNew) ?? nearest(this.parsed.newToDiff, targetNew) ?? null;
    } else {
      targetDiffIdx = topLine;
      const line = this.parsed.lines[topLine];
      if (line) {
        targetOld = line.oldLine ?? null;
        targetNew = line.newLine ?? null;
      }
    }

    const leftEl = this.renderRoot.querySelector<HTMLElement>(".pane-left");
    const rightEl = this.renderRoot.querySelector<HTMLElement>(".pane-right");
    const middleEl = this.renderRoot.querySelector<HTMLElement>(".pane-middle");

    if (source !== "left" && leftEl && targetOld != null && this.leftLineHeight > 0) {
      leftEl.scrollTop = Math.max(0, (targetOld - 1) * this.leftLineHeight);
    }
    if (source !== "right" && rightEl && targetNew != null && this.rightLineHeight > 0) {
      rightEl.scrollTop = Math.max(0, (targetNew - 1) * this.rightLineHeight);
    }
    if (source !== "middle" && middleEl && targetDiffIdx != null && this.middleLineHeight > 0) {
      middleEl.scrollTop = Math.max(0, targetDiffIdx * this.middleLineHeight);
    }

    this.clearSyncSource();
  }

  private clearSyncSource() {
    // Release the sync guard on the next frame so any reactive scroll
    // events from our setters (which DO fire synchronously in some
    // browsers) don't re-enter as a different source.
    cancelAnimationFrame(this.syncClearHandle);
    this.syncClearHandle = requestAnimationFrame(() => {
      this.syncSource = null;
    });
  }

  override render() {
    if (!this.ready) {
      return html`<gc-loading-banner heading="preparing 3-pane view…"></gc-loading-banner>`;
    }
    return html`
      <div class="grid">
        <header class="lbl lbl-left">${this.leftLabel}</header>
        <header class="lbl lbl-middle">changes</header>
        <header class="lbl lbl-right">${this.rightLabel}</header>

        <div class="pane pane-left" @scroll=${(e: Event) => this.onScroll("left", e)}>
          ${this.leftHtml ? unsafeHTML(this.leftHtml) : html`<pre class="empty">(empty)</pre>`}
        </div>

        <div class="pane pane-middle" @scroll=${(e: Event) => this.onScroll("middle", e)}>
          ${this.middleLines.length === 0
            ? html`<pre class="empty">(no changes)</pre>`
            : this.middleLines.map(
                (l) => html`<div class="diff-line ${l.kind}">${l.text || "\u00a0"}</div>`,
              )}
        </div>

        <div class="pane pane-right" @scroll=${(e: Event) => this.onScroll("right", e)}>
          ${this.rightHtml ? unsafeHTML(this.rightHtml) : html`<pre class="empty">(empty)</pre>`}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr 1fr;
      grid-template-rows: auto 1fr;
      height: 100%;
      gap: 1px;
      background: var(--border-default);
    }
    .lbl {
      background: var(--surface-1);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs);
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-default);
    }
    .pane {
      background: var(--surface-1);
      overflow: auto;
      min-height: 0;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.8rem;
      line-height: 1.45;
    }
    .pane-middle {
      padding: 0;
    }
    .pane-left,
    .pane-right {
      padding: var(--space-2);
    }
    .pane pre {
      margin: 0;
      padding: 0;
      background: transparent !important;
    }
    .pane .empty {
      color: var(--text-muted);
      padding: var(--space-4);
    }
    .diff-line {
      white-space: pre;
      padding: 0 var(--space-3);
      min-height: 1.45em;
    }
    .diff-line.addition {
      background: color-mix(in srgb, var(--success, #2ea043) 18%, transparent);
      color: var(--text);
    }
    .diff-line.deletion {
      background: color-mix(in srgb, var(--danger, #f85149) 18%, transparent);
      color: var(--text);
    }
    .diff-line.header {
      color: var(--text-muted);
      opacity: 0.7;
    }
  `;
}

// nearest returns the closest mapping value for a given key; useful when
// the pane we're scrolling from has a line number that doesn't exist
// in the target map (e.g. an added line has no oldLine). We pick the
// last-defined neighbour so the target pane stays "near" the driver.
function nearest(map: Map<number, number>, key: number): number | undefined {
  if (map.size === 0) return undefined;
  let bestK = -Infinity;
  let bestV: number | undefined;
  for (const [k, v] of map) {
    if (k <= key && k > bestK) {
      bestK = k;
      bestV = v;
    }
  }
  return bestV;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-three-pane-view": GcThreePaneView;
  }
}
