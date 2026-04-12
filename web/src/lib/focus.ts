// Shared focus-mode state for chat-view and repo-browser.
//
// Both views render a "focus" toggle that collapses the left sidebar
// and lifts the max-width cap on their main pane, turning the whole
// main area into content. The preference is persisted per browser via
// localStorage and *shared* across both views — toggling it in chat
// carries over to browse and vice-versa. That was the user's expected
// behavior; keeping two independent keys felt broken.
//
// Consumers read the current value on mount via `readFocus()` and
// persist updates via `writeFocus(v)`. There is no pub/sub here: each
// view instance re-reads localStorage when Lit mounts it, so the
// tab-switch flow naturally picks up the latest value.

const FOCUS_KEY = "gc.focus";

export function readFocus(): boolean {
  try {
    return localStorage.getItem(FOCUS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeFocus(v: boolean) {
  try {
    localStorage.setItem(FOCUS_KEY, v ? "1" : "0");
  } catch {
    /* storage disabled (private mode / embedded browsers) — ignore */
  }
}
