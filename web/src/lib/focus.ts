// Shared focus-mode state for chat-view and repo-browser.
//
// Three stages, cycled by the focus toggle button (or Cmd+.):
//
//   - "off"   — normal layout, sidebar visible.
//   - "focus" — sidebar collapsed; main pane gets more width. Chrome
//               (headers, buttons, toggles) stays visible.
//   - "zen"   — focus PLUS the pane header is hidden, content is
//               centered tighter, and anything non-essential fades
//               away. For deep reading / writing sessions.
//
// The preference is persisted per browser via localStorage and is
// *shared* across chat-view and repo-browser — toggling in one carries
// over to the other, matching user expectation.
//
// There is no pub/sub here: consumers re-read localStorage when Lit
// mounts them. The tab-switch flow naturally picks up the latest
// value, and the focusNonce property bumps a reload when the global
// keybinding cycles the state.

const FOCUS_KEY = "gc.focus";

export type FocusMode = "off" | "focus" | "zen";

export function readFocus(): FocusMode {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    // Legacy values: "0" = off, "1" = focus (pre-zen). New values:
    // the string literal. Anything else falls back to off.
    if (raw === "1") return "focus";
    if (raw === "focus") return "focus";
    if (raw === "zen") return "zen";
    return "off";
  } catch {
    return "off";
  }
}

export function writeFocus(v: FocusMode) {
  try {
    localStorage.setItem(FOCUS_KEY, v);
  } catch {
    /* storage disabled (private mode / embedded browsers) — ignore */
  }
}

/** Advance the focus state one step in the off → focus → zen → off
 * cycle. Pure helper so components don't re-encode the ring. */
export function cycleFocus(current: FocusMode): FocusMode {
  switch (current) {
    case "off":
      return "focus";
    case "focus":
      return "zen";
    case "zen":
      return "off";
  }
}

/** Short inline label for the toggle button — describes the CURRENT
 * state, not what the next click does. */
export function focusButtonLabel(mode: FocusMode): string {
  switch (mode) {
    case "off":
      return "focus";
    case "focus":
      return "zen";
    case "zen":
      return "exit zen";
  }
}

/** Unicode glyph for the toggle button — progress indicator across
 * the three stages. */
export function focusGlyph(mode: FocusMode): string {
  switch (mode) {
    case "off":
      return "▶";
    case "focus":
      return "◀";
    case "zen":
      return "●";
  }
}

/** aria-label + tooltip: describes what the NEXT click does so the
 * assistive text matches the user's mental model (action-oriented,
 * not state-oriented). */
export function focusNextLabel(mode: FocusMode): string {
  switch (mode) {
    case "off":
      return "Enter focus mode (hide sidebar)";
    case "focus":
      return "Enter zen mode (hide chrome)";
    case "zen":
      return "Exit zen mode";
  }
}
