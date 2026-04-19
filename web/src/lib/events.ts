// Central registry of custom events bubbled up through the app.
//
// Lit components dispatch `CustomEvent` instances with `bubbles: true`
// and `composed: true` so parents + the app shell can listen. Without
// this file, every consumer has to re-type `e.detail` inline with its
// own shape guess — which has drifted in three places during this
// codebase's history and is the root cause of a handful of runtime-only
// bugs the compiler couldn't catch.
//
// The pattern here is the standard TypeScript interface-merge: any file
// that declares `interface HTMLElementEventMap` extends the global type.
// We centralize here so there's a single source of truth; consumers
// using `addEventListener("gc:foo", handler)` get full payload typing
// automatically without importing anything from this file.
//
// Naming convention: `gc:<noun-or-verb-phrase>`. Dispatchers use
// `bubbles: true, composed: true` so events cross shadow roots.

import type { ChangedFile } from "../gen/gitchat/v1/repo_pb.js";
import type { ClientAttachment } from "./chat-types.js";
import type { NavState } from "./routing.js";

// ── Cross-cutting events (fired by multiple components) ──────────

export interface ToastDetail {
  kind: "info" | "success" | "warn" | "error";
  message: string;
}

export interface AnnounceDetail {
  message: string;
}

export interface ErrorDetail {
  message: string;
}

export interface OpenFileDetail {
  path: string;
  /** Optional tab hint for cross-view navigation. */
  tab?: string;
  /** Optional ref — defaults to the current branch. */
  ref?: string;
}

export interface ViewCommitDetail {
  sha: string;
  tab?: string;
}

export interface AskAboutDetail {
  prompt: string;
  tab?: string;
}

export interface ViewFileHistoryDetail {
  path: string;
}

export interface ExplainInChatDetail {
  path: string;
}

// ── Chat view events ─────────────────────────────────────────────

export interface SendDetail {
  text: string;
  attachments: ClientAttachment[];
}

export interface SlashActionDetail {
  command: string;
  args: string[];
}

export interface InputChangedDetail {
  textLength: number;
  attachmentBytes: number;
}

export interface EditTurnDetail {
  text: string;
  replaceFromMessageId: string;
  sliceAt: number;
}

export interface UpdateTurnsDetail {
  // message-list owns the turn list locally for retry/regenerate/edit
  // and notifies chat-view with the new array so the shared state stays
  // consistent. Using `unknown` here keeps the event map import-light;
  // the chat-view handler narrows via its Turn type.
  turns: unknown[];
}

// ── Session sidebar events ───────────────────────────────────────

export interface SelectSessionDetail {
  sessionId: string;
}

export interface DeleteSessionDetail {
  sessionId: string;
}

// ── Commit log / calendar ───────────────────────────────────────

export interface SelectCommitDetail {
  sha: string;
}

export interface ArmCommitDetail {
  sha: string;
}

// ── Diff pane ────────────────────────────────────────────────────

export interface DiffFilesLoadedDetail {
  files: ChangedFile[];
  parentSha: string;
  toCommit: string;
}

// ── Dashboard ────────────────────────────────────────────────────

export interface PrefillExampleDetail {
  text: string;
}

// ── KB view ──────────────────────────────────────────────────────

export interface NavigateBrowseDetail {
  path: string;
}

// Global augmentation — adds strict typing to
// addEventListener("gc:foo", handler) across the app.
declare global {
  interface HTMLElementEventMap {
    // cross-cutting
    "gc:toast": CustomEvent<ToastDetail>;
    "gc:announce": CustomEvent<AnnounceDetail>;
    "gc:error": CustomEvent<ErrorDetail>;
    "gc:open-file": CustomEvent<OpenFileDetail>;
    "gc:view-commit": CustomEvent<ViewCommitDetail>;
    "gc:ask-about": CustomEvent<AskAboutDetail>;
    "gc:view-file-history": CustomEvent<ViewFileHistoryDetail>;
    "gc:explain-in-chat": CustomEvent<ExplainInChatDetail>;
    "gc:nav": CustomEvent<NavState>;
    // Emitted by any component that cycles focus mode via its own
    // button. Gc-app catches it to bump focusNonce so the change
    // cascades to tabs not currently visible (they'll re-read focus
    // from localStorage the next time they render).
    "gc:focus-changed": CustomEvent<Record<string, never>>;

    // chat composer
    "gc:send": CustomEvent<SendDetail>;
    "gc:stop": CustomEvent<Record<string, never>>;
    "gc:slash-action": CustomEvent<SlashActionDetail>;
    "gc:input-changed": CustomEvent<InputChangedDetail>;

    // chat message list
    "gc:retry": CustomEvent<Record<string, never>>;
    "gc:regenerate": CustomEvent<Record<string, never>>;
    "gc:edit-turn": CustomEvent<EditTurnDetail>;
    "gc:update-turns": CustomEvent<UpdateTurnsDetail>;

    // session sidebar
    "gc:new-chat": CustomEvent<Record<string, never>>;
    "gc:select-session": CustomEvent<SelectSessionDetail>;
    "gc:delete-session": CustomEvent<DeleteSessionDetail>;
    "gc:sessions-changed": CustomEvent<Record<string, never>>;

    // settings panel
    "gc:close": CustomEvent<Record<string, never>>;

    // commit log / calendar
    "gc:select-commit": CustomEvent<SelectCommitDetail>;
    "gc:arm-commit": CustomEvent<ArmCommitDetail>;

    // diff pane
    "gc:diff-files-loaded": CustomEvent<DiffFilesLoadedDetail>;

    // dashboard
    "gc:prefill-example": CustomEvent<PrefillExampleDetail>;

    // kb view
    "gc:navigate-browse": CustomEvent<NavigateBrowseDetail>;
  }
}

// The module has real exports (payload types above), so TypeScript
// treats it as a module and picks up the `declare global` augmentation
// automatically when any consumer imports from lib/events.
