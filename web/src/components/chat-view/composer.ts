import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repoClient } from "../../lib/transport.js";
import { EntryType } from "../../gen/gitchat/v1/repo_pb.js";
import { type ClientAttachment, fmtBytes, messageOf } from "../../lib/chat-types.js";
import {
  ALLOWED_ATTACHMENT_MIMES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  readFileToAttachment,
} from "../../lib/attachments.js";

@customElement("gc-composer")
export class GcComposer extends LitElement {
  @property({ type: String }) repoId = "";
  @property({ type: Boolean }) sending = false;
  @property({ type: String }) errorMsg = "";

  @state() private input = "";
  @state() private pendingAttachments: ClientAttachment[] = [];
  @state() private dragActive = false;
  private dragDepth = 0;
  @state() private mentionResults: string[] = [];
  @state() private showMentions = false;
  @state() private mentionIdx = -1;
  private dirCache = new Map<string, string[]>();
  private checkMentionSeq = 0;

  /** Public: set input text (used by parent for prefill / insert). */
  setInput(value: string) {
    this.input = value;
  }

  /** Public: focus the textarea. */
  focusInput() {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    ta?.focus();
  }

  /** Public: insert a file mention at the current cursor position. */
  insertFileMention(path: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const after = this.input.slice(pos);
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0 && !before.slice(atIdx).includes(" ")) {
      this.input = before.slice(0, atIdx) + "@" + path + " " + after;
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = atIdx + path.length + 2;
        ta.setSelectionRange(newPos, newPos);
      });
    } else {
      this.input = before + " @" + path + " " + after;
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = pos + path.length + 3;
        ta.setSelectionRange(newPos, newPos);
      });
    }
  }

  /** Public: reset after send. */
  clearAfterSend() {
    this.input = "";
    this.pendingAttachments = [];
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (ta) ta.style.height = "auto";
  }

  private fire<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private onInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    this.input = ta.value;
    this.autoResize(ta);
    void this.checkMention();
  }

  private autoResize(ta: HTMLTextAreaElement) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
  }

  private async checkMention() {
    const seq = ++this.checkMentionSeq;
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const atMatch = before.match(/@([\w\-./]*)$/);
    if (!atMatch) {
      this.showMentions = false;
      this.mentionResults = [];
      return;
    }
    const query = atMatch[1];
    const lastSlash = query.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? query.slice(0, lastSlash) : "";
    const filterPart = (lastSlash >= 0 ? query.slice(lastSlash + 1) : query).toLowerCase();
    if (!this.dirCache.has(dirPath)) {
      this.mentionResults = [];
      this.showMentions = false;
      try {
        const resp = await repoClient.listTree({ repoId: this.repoId, path: dirPath });
        const prefix = dirPath ? dirPath + "/" : "";
        this.dirCache.set(
          dirPath,
          resp.entries.map((e) => prefix + e.name + (e.type === EntryType.DIR ? "/" : "")),
        );
      } catch {
        this.dirCache.set(dirPath, []);
      }
      if (seq !== this.checkMentionSeq) return;
    }
    this.mentionResults = (this.dirCache.get(dirPath) || [])
      .filter((p) => {
        const name = p.slice(p.lastIndexOf("/", p.length - 2) + 1).toLowerCase();
        return name.includes(filterPart);
      })
      .slice(0, 8);
    this.mentionIdx = -1;
    this.showMentions = this.mentionResults.length > 0;
  }

  private insertMention(path: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = this.input.slice(0, pos);
    const after = this.input.slice(pos);
    const atIdx = before.lastIndexOf("@");
    const isDirectory = path.endsWith("/");
    const suffix = isDirectory ? "" : " ";
    this.input = before.slice(0, atIdx) + "@" + path + suffix + after;
    if (isDirectory) {
      requestAnimationFrame(() => {
        ta.focus();
        const newPos = atIdx + path.length + 1;
        ta.setSelectionRange(newPos, newPos);
        void this.checkMention();
      });
      return;
    }
    this.showMentions = false;
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = atIdx + path.length + 2;
      ta.setSelectionRange(newPos, newPos);
    });
  }

  private onKeydown(e: KeyboardEvent) {
    if (this.showMentions && this.mentionResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.mentionIdx = (this.mentionIdx + 1) % this.mentionResults.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.mentionIdx =
          this.mentionIdx <= 0 ? this.mentionResults.length - 1 : this.mentionIdx - 1;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const idx = this.mentionIdx >= 0 ? this.mentionIdx : 0;
        this.insertMention(this.mentionResults[idx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.showMentions = false;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
  }

  private submit() {
    const text = this.input.trim();
    const attachments = this.pendingAttachments;
    if (!text && attachments.length === 0) return;
    if (this.sending) return;
    this.fire("gc:send", { text, attachments });
  }

  private async addFiles(files: FileList | File[] | null | undefined) {
    if (!files || files.length === 0) return;
    const existing = this.pendingAttachments;
    const additions: ClientAttachment[] = [];
    const rejections: string[] = [];
    let runningTotal = existing.reduce((n, a) => n + a.size, 0);
    for (const f of Array.from(files)) {
      if (existing.length + additions.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        rejections.push(`max ${MAX_ATTACHMENTS_PER_MESSAGE} attachments reached`);
        break;
      }
      if (!ALLOWED_ATTACHMENT_MIMES.has(f.type)) {
        rejections.push(`${f.name}: unsupported type ${f.type || "unknown"}`);
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        rejections.push(
          `${f.name}: too large (${fmtBytes(f.size)} > ${fmtBytes(MAX_ATTACHMENT_BYTES)})`,
        );
        continue;
      }
      if (runningTotal + f.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
        rejections.push(`${f.name}: would exceed total size cap`);
        continue;
      }
      try {
        const att = await readFileToAttachment(f);
        additions.push(att);
        runningTotal += att.size;
      } catch (e) {
        rejections.push(`${f.name}: ${messageOf(e)}`);
      }
    }
    if (additions.length > 0) {
      this.pendingAttachments = [...existing, ...additions];
      this.fire("gc:announce", {
        message: `${additions.length} attachment${additions.length === 1 ? "" : "s"} added`,
      });
    }
    if (rejections.length > 0) {
      this.fire("gc:error", { message: rejections.join("; ") });
    }
  }

  private removeAttachment(index: number) {
    const next = this.pendingAttachments.slice();
    next.splice(index, 1);
    this.pendingAttachments = next;
  }

  private async onPickFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    await this.addFiles(input.files);
    input.value = "";
  }

  private async onPasteAttach(e: ClipboardEvent) {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      e.preventDefault();
      await this.addFiles(items);
    }
  }

  private onDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    this.dragDepth++;
    this.dragActive = true;
  }

  private onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
  }

  private onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragActive = false;
  }

  private async onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    await this.addFiles(e.dataTransfer?.files);
  }

  private stop() {
    this.fire("gc:stop", {});
  }

  override render() {
    return html`
      <form
        class="composer ${this.dragActive ? "drag-active" : ""}"
        role="search"
        aria-label="Chat composer"
        @submit=${(e: Event) => {
          e.preventDefault();
          this.submit();
        }}
        @dragenter=${this.onDragEnter}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        <div class="composer-inner">
          ${this.pendingAttachments.length > 0
            ? html`<div class="attachment-strip" role="list">
                ${this.pendingAttachments.map((a, i) => this.renderAttachmentChip(a, i))}
              </div>`
            : nothing}
          <textarea
            .value=${this.input}
            @input=${this.onInput}
            @keydown=${this.onKeydown}
            @paste=${this.onPasteAttach}
            placeholder="ask about the repo — use @path/to/file to pin content"
            ?disabled=${this.sending}
            rows="1"
            aria-label="Message input — type @ for file autocomplete, Enter to send, drop files to attach"
            aria-describedby="composer-status"
            aria-autocomplete="list"
            aria-expanded=${this.showMentions ? "true" : "false"}
          ></textarea>
          ${this.showMentions
            ? html`<ul class="mention-list" role="listbox">
                ${this.mentionResults.map(
                  (p, i) => html`<li
                    role="option"
                    aria-selected=${i === this.mentionIdx ? "true" : "false"}
                  >
                    <button
                      class="mention-item ${i === this.mentionIdx ? "active" : ""}"
                      @click=${() => this.insertMention(p)}
                    >
                      ${p}
                    </button>
                  </li>`,
                )}
              </ul>`
            : nothing}
          <div class="composer-row">
            <span class="composer-hint" id="composer-status" role="status">
              ${this.errorMsg
                ? html`<span class="err">⚠ ${this.errorMsg}</span>`
                : this.sending
                  ? html`<span class="dim">streaming…</span>`
                  : html`<span class="dim"
                      >↵ send · shift+↵ newline · drag or paste to attach</span
                    >`}
            </span>
            <input
              type="file"
              class="attach-input"
              multiple
              accept=${[...ALLOWED_ATTACHMENT_MIMES].join(",")}
              @change=${(e: Event) => void this.onPickFiles(e)}
              aria-hidden="true"
              tabindex="-1"
            />
            <button
              type="button"
              class="attach-btn"
              aria-label="Attach file"
              title="Attach file"
              ?disabled=${this.sending ||
              this.pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              @click=${() => {
                const el = this.renderRoot.querySelector<HTMLInputElement>(".attach-input");
                el?.click();
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M10.5 6.5 6 11a2.5 2.5 0 0 1-3.54-3.54L7.5 2.5a1.75 1.75 0 0 1 2.47 2.47L5.5 9.44"
                />
              </svg>
            </button>
            ${this.sending
              ? html`<button
                  type="button"
                  class="stop"
                  aria-label="Stop generating"
                  @click=${() => this.stop()}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                    <rect x="2" y="2" width="10" height="10" rx="1.5" />
                  </svg>
                  stop
                </button>`
              : html`<button
                  type="submit"
                  aria-label="Send message"
                  class="send"
                  ?disabled=${!this.input.trim() && this.pendingAttachments.length === 0}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M8 12V4M4 7l4-4 4 4" />
                  </svg>
                </button>`}
          </div>
        </div>
      </form>
    `;
  }

  private renderAttachmentChip(a: ClientAttachment, index: number) {
    const isImage = a.mimeType.startsWith("image/") && a.url;
    const tooltip = `${a.filename} · ${fmtBytes(a.size)}`;
    const remove = html`<button
      type="button"
      class="attachment-remove"
      aria-label="Remove ${a.filename}"
      title="Remove"
      @click=${() => this.removeAttachment(index)}
    >
      ×
    </button>`;
    if (isImage) {
      return html`<div class="attachment-chip is-image" role="listitem" title=${tooltip}>
        <img src=${a.url!} alt=${a.filename} class="attachment-thumb" />
        ${remove}
      </div>`;
    }
    return html`<div class="attachment-chip is-file" role="listitem" title=${tooltip}>
      <span class="attachment-glyph" aria-hidden="true">📄</span>
      <span class="attachment-meta">
        <span class="attachment-name">${a.filename}</span>
        <span class="attachment-size">${fmtBytes(a.size)}</span>
      </span>
      ${remove}
    </div>`;
  }

  static override styles = css`
    :host {
      display: block;
      font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
      font-size: 0.82rem;
      color: var(--text);
    }
    .composer {
      flex-shrink: 0;
      padding: var(--space-3) var(--space-7) var(--space-5);
      background: var(--surface-1);
      position: relative;
    }
    .composer::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -24px;
      height: 24px;
      background: linear-gradient(to top, var(--surface-1), transparent);
      pointer-events: none;
    }
    .composer-inner {
      max-width: var(--content-max-width);
      margin: 0 auto;
      box-sizing: border-box;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 0.65rem 0.85rem var(--space-2);
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      transition: border-color 0.12s ease;
    }
    :host([unfocused]) .composer-inner {
      max-width: 1000px;
    }
    .composer-inner:focus-within {
      border-color: var(--border-accent);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      background: transparent;
      color: var(--text);
      border: none;
      padding: 0.15rem 0.05rem;
      font-family: inherit;
      font-size: var(--text-base);
      line-height: 1.5;
      min-height: 1.5em;
      max-height: 40vh;
      overflow-y: auto;
      field-sizing: content;
    }
    textarea:focus {
      outline: none;
    }
    textarea::placeholder {
      opacity: 0.35;
    }
    .mention-list {
      list-style: none;
      margin: 0;
      padding: var(--space-1) 0;
      border-top: 1px solid var(--surface-4);
      max-height: 160px;
      overflow-y: auto;
    }
    .mention-item {
      display: block;
      width: 100%;
      padding: var(--space-1) var(--space-2);
      background: transparent;
      color: var(--accent-user);
      border: none;
      font-family: inherit;
      font-size: var(--text-xs);
      text-align: left;
      cursor: pointer;
    }
    .mention-item:hover,
    .mention-item.active {
      background: var(--surface-3);
    }
    .composer.drag-active .composer-inner {
      border-color: var(--border-accent);
      background: color-mix(in srgb, var(--accent-user) 8%, var(--surface-2));
    }
    .attach-input {
      display: none;
    }
    .attach-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: transparent;
      color: var(--text);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      opacity: 0.4;
      flex-shrink: 0;
      margin-left: auto;
      transition:
        opacity 0.12s ease,
        background 0.12s ease;
    }
    .attach-btn:hover:not([disabled]) {
      opacity: 0.85;
      background: var(--surface-3);
    }
    .attach-btn[disabled] {
      opacity: 0.15;
      cursor: not-allowed;
    }
    .attachment-strip {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .attachment-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      background: var(--surface-3);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: var(--text-xs);
    }
    .attachment-chip.is-image {
      padding: 0;
      overflow: hidden;
      width: 56px;
      height: 56px;
    }
    .attachment-chip.is-file {
      gap: 0.4rem;
      padding: 5px 6px 5px 8px;
      max-width: 240px;
    }
    .attachment-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .attachment-glyph {
      font-size: 14px;
      opacity: 0.65;
    }
    .attachment-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.2;
    }
    .attachment-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .attachment-size {
      opacity: 0.55;
      font-size: 0.65rem;
    }
    .attachment-remove {
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .attachment-chip.is-image .attachment-remove {
      position: absolute;
      top: 3px;
      right: 3px;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .attachment-chip.is-image:hover .attachment-remove,
    .attachment-chip.is-image:focus-within .attachment-remove {
      opacity: 1;
    }
    .attachment-chip.is-file .attachment-remove {
      margin-left: 0.2rem;
      background: transparent;
      color: var(--text);
      opacity: 0.45;
      width: 16px;
      height: 16px;
    }
    .attachment-chip.is-file .attachment-remove:hover {
      opacity: 1;
    }
    .composer-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .composer-hint {
      font-size: 0.68rem;
    }
    .dim {
      opacity: 0.4;
    }
    .err {
      color: var(--danger);
    }
    .send {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: var(--accent-user);
      color: var(--surface-0);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      transition: opacity 0.12s ease;
      flex-shrink: 0;
    }
    .send:hover:not(:disabled) {
      opacity: 0.85;
    }
    .send:disabled {
      opacity: 0.25;
      cursor: not-allowed;
    }
    .stop {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.7rem;
      background: var(--surface-3);
      color: var(--text);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit;
      font-size: 0.72rem;
      cursor: pointer;
      transition: background 0.12s ease;
      flex-shrink: 0;
    }
    .stop:hover {
      background: var(--surface-4);
    }
    textarea::-webkit-scrollbar {
      width: 8px;
    }
    textarea::-webkit-scrollbar-thumb {
      background: var(--surface-4);
      border-radius: 4px;
    }
    textarea::-webkit-scrollbar-thumb:hover {
      background: var(--border-strong);
    }
    textarea::-webkit-scrollbar-track {
      background: transparent;
    }
    :focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: 2px;
    }
    button:focus-visible {
      outline: 2px solid var(--accent-assistant);
      outline-offset: -1px;
      border-radius: var(--radius-md);
    }
    textarea:focus-visible {
      outline: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .send {
        transition: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "gc-composer": GcComposer;
  }
}
