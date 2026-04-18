import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * A combobox option with a value and display label.
 * Optionally includes a secondary description line.
 */
export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * <gc-combobox> — an accessible combobox (autocomplete) component.
 *
 * Follows the WAI-ARIA Combobox pattern:
 *   - role="combobox" on the input
 *   - role="listbox" on the dropdown
 *   - role="option" on each item
 *   - aria-activedescendant for keyboard focus
 *   - aria-expanded to signal dropdown state
 *
 * Features:
 *   - Filters options as the user types (case-insensitive substring)
 *   - Keyboard: ArrowDown/Up to navigate, Enter to select, Escape to close
 *   - Free-form input: typing a value not in the list is allowed
 *   - Fires "gc-select" CustomEvent when an option is picked
 *   - Fires "gc-input" CustomEvent on every keystroke
 *
 * @example
 * ```html
 * <gc-combobox
 *   .options=${[{ value: "openai", label: "OpenAI", description: "GPT models" }]}
 *   .value=${"openai"}
 *   placeholder="Select provider"
 *   @gc-select=${(e) => console.log(e.detail)}
 *   @gc-input=${(e) => console.log(e.detail)}
 * ></gc-combobox>
 * ```
 */
@customElement("gc-combobox")
export class GcCombobox extends LitElement {
  @property({ type: Array }) options: ComboboxOption[] = [];
  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "";
  @property({ type: String, attribute: "empty-hint" }) emptyHint = "";

  @state() private open = false;
  @state() private activeIndex = -1;
  @state() private filter = "";

  private _id = `gcb-${Math.random().toString(36).slice(2, 8)}`;

  private get filtered(): ComboboxOption[] {
    const q = this.filter.toLowerCase();
    if (!q) return this.options;
    return this.options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description?.toLowerCase().includes(q) ?? false),
    );
  }

  private _scrollListener = () => this.positionListbox();

  private show() {
    this.open = true;
    this.activeIndex = -1;
    // Track scroll on any ancestor to keep the dropdown aligned.
    window.addEventListener("scroll", this._scrollListener, { capture: true });
  }

  private hide() {
    this.open = false;
    this.activeIndex = -1;
    window.removeEventListener("scroll", this._scrollListener, {
      capture: true,
    } as EventListenerOptions);
  }

  private select(opt: ComboboxOption) {
    this.value = opt.value;
    this.filter = opt.label;
    this.hide();
    this.dispatchEvent(
      new CustomEvent("gc-select", { detail: opt, bubbles: true, composed: true }),
    );
    // Return focus to input after selection.
    const input = this.renderRoot.querySelector("input");
    input?.focus();
  }

  private onInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    this.filter = val;
    this.value = val;
    this.show();
    this.dispatchEvent(new CustomEvent("gc-input", { detail: val, bubbles: true, composed: true }));
  }

  private onKeydown(e: KeyboardEvent) {
    const items = this.filtered;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this.open) {
          this.show();
          this.activeIndex = 0;
        } else {
          this.activeIndex = Math.min(this.activeIndex + 1, items.length - 1);
        }
        this.scrollActiveIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!this.open) {
          this.show();
          this.activeIndex = items.length - 1;
        } else {
          this.activeIndex = Math.max(this.activeIndex - 1, 0);
        }
        this.scrollActiveIntoView();
        break;
      case "Home":
        if (this.open) {
          e.preventDefault();
          this.activeIndex = 0;
          this.scrollActiveIntoView();
        }
        break;
      case "End":
        if (this.open) {
          e.preventDefault();
          this.activeIndex = items.length - 1;
          this.scrollActiveIntoView();
        }
        break;
      case "Enter":
        e.preventDefault();
        if (this.open && this.activeIndex >= 0 && this.activeIndex < items.length) {
          this.select(items[this.activeIndex]);
        } else {
          this.hide();
        }
        break;
      case "Escape":
        if (this.open) {
          e.preventDefault();
          e.stopPropagation();
          this.hide();
        }
        break;
      case "Tab":
        this.hide();
        break;
    }
  }

  /** Scroll the active option into view within the listbox. */
  private scrollActiveIntoView() {
    this.updateComplete.then(() => {
      const opt = this.renderRoot.querySelector(".option.active") as HTMLElement | null;
      opt?.scrollIntoView({ block: "nearest" });
    });
  }

  private onFocus() {
    this.filter = this.displayValue();
    this.show();
  }

  /** Position the listbox using fixed coordinates to escape overflow
   * clipping. Opens downward by default; flips above when the viewport
   * has more room above the input than below (typical when the input
   * sits near the bottom of a modal or page).
   *
   * The listbox's natural height is capped at 240px by CSS, so we
   * compare "space below" against the min of (desired, natural) — no
   * point flipping if the dropdown already fits comfortably below. */
  private positionListbox() {
    const input = this.renderRoot.querySelector("input");
    const listbox = this.renderRoot.querySelector(".listbox") as HTMLElement | null;
    if (!input || !listbox) return;
    const rect = input.getBoundingClientRect();
    const gap = 2;
    const naturalHeight = listbox.scrollHeight;
    const desired = Math.min(naturalHeight, 240);
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    // Prefer downward unless below clips the dropdown AND above has more room.
    const flipUp = below < desired && above > below;
    if (flipUp) {
      const maxH = Math.min(desired, above);
      listbox.style.top = "auto";
      listbox.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      listbox.style.maxHeight = `${maxH}px`;
    } else {
      const maxH = Math.min(desired, below);
      listbox.style.bottom = "auto";
      listbox.style.top = `${rect.bottom + gap}px`;
      listbox.style.maxHeight = `${maxH}px`;
    }
    listbox.style.left = `${rect.left}px`;
    listbox.style.width = `${rect.width}px`;
  }

  private onBlur() {
    // Delay to allow click events on the listbox to fire first.
    setTimeout(() => this.hide(), 150);
  }

  /** Resolve the display label for the current value. */
  private displayValue(): string {
    const match = this.options.find((o) => o.value === this.value);
    return match ? match.label : this.value;
  }

  override updated(changed: Map<string, unknown>) {
    // Sync the input display when value changes externally.
    if (changed.has("value") && !this.open) {
      this.filter = this.displayValue();
    }
    // Position the listbox after Lit has rendered it into the DOM.
    if (this.open) {
      this.positionListbox();
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.filter = this.displayValue();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("scroll", this._scrollListener, {
      capture: true,
    } as EventListenerOptions);
  }

  override render() {
    const items = this.filtered;
    const listId = `${this._id}-list`;
    return html`
      <div class="combobox-wrap">
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded=${this.open && items.length > 0 ? "true" : "false"}
          aria-controls=${listId}
          aria-activedescendant=${this.activeIndex >= 0
            ? `${this._id}-opt-${this.activeIndex}`
            : ""}
          autocomplete="off"
          .value=${this.filter}
          placeholder=${this.placeholder}
          @input=${this.onInput}
          @keydown=${this.onKeydown}
          @focus=${this.onFocus}
          @blur=${this.onBlur}
        />
        ${this.open && items.length === 0 && this.emptyHint && this.filter
          ? html`<div class="listbox empty-hint">${this.emptyHint}</div>`
          : nothing}
        ${this.open && items.length > 0
          ? html`
              <ul id=${listId} role="listbox" class="listbox" aria-label="Suggestions">
                ${items.map(
                  (opt, i) => html`
                    <li
                      id="${this._id}-opt-${i}"
                      role="option"
                      class="option ${i === this.activeIndex ? "active" : ""}"
                      aria-selected=${i === this.activeIndex ? "true" : "false"}
                      @mousedown=${(e: Event) => {
                        e.preventDefault(); // prevent blur
                        this.select(opt);
                      }}
                      @mouseenter=${() => {
                        this.activeIndex = i;
                      }}
                    >
                      <span class="option-label">${opt.label}</span>
                      ${opt.description
                        ? html`<span class="option-desc">${opt.description}</span>`
                        : nothing}
                    </li>
                  `,
                )}
              </ul>
            `
          : nothing}
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
      position: relative;
    }
    .combobox-wrap {
      position: relative;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-1, 4px) var(--space-2, 8px);
      background: var(--surface-0, #1a1a1a);
      color: var(--text, #e0e0e0);
      border: 1px solid var(--border-default, #333);
      border-radius: var(--radius-sm, 4px);
      font-family: inherit;
      font-size: var(--text-xs, 0.75rem);
      outline: none;
      transition: border-color 0.12s ease;
    }
    input:focus {
      border-color: var(--accent-assistant, #6b8aff);
    }
    .listbox {
      position: fixed;
      z-index: 9999;
      margin: 0;
      padding: var(--space-1, 4px) 0;
      background: var(--surface-2, #252525);
      border: 1px solid var(--border-strong, #444);
      border-radius: var(--radius-sm, 4px);
      box-shadow: var(--shadow-dropdown);
      max-height: 240px;
      overflow-y: auto;
      list-style: none;
    }
    .empty-hint {
      padding: var(--space-2, 8px);
      font-size: var(--text-xs, 0.75rem);
      /* Muted via color, not opacity — opacity would fade the .listbox
         background too, making the dropdown see-through. */
      color: var(--text-muted, #888);
      font-style: italic;
    }
    .option {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: var(--space-1, 4px) var(--space-2, 8px);
      cursor: pointer;
      font-size: var(--text-xs, 0.75rem);
      border-radius: var(--radius-sm, 4px);
      margin: 0 var(--space-1, 4px);
    }
    .option:hover,
    .option.active {
      background: var(--surface-3, #333);
    }
    .option-label {
      color: var(--text, #e0e0e0);
    }
    .option-desc {
      color: var(--text, #e0e0e0);
      opacity: 0.5;
      font-size: 0.65rem;
    }
  `;
}
