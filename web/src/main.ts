import { applyAll, setHostTheme, setHostTokens } from "./lib/settings.js";

// Optional embedder bridge. Extension hosts (VS Code, Open VSX) pass
// the active editor theme via URL on first paint and via postMessage
// thereafter. setHostTheme treats it as an override for "system" mode
// only, so a user who explicitly picked dark or light in the settings
// panel still gets their choice. Source verification: we only accept
// messages from window.parent (the webview HTML the extension owns)
// because that is the sole legitimate sender — random tabs and other
// iframes never become our parent in any deployment.
function readInitialHostTheme(): "dark" | "light" | null {
  try {
    const t = new URLSearchParams(location.search).get("theme");
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

setHostTheme(readInitialHostTheme());
applyAll();

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const data = e.data;
  if (!data || typeof data !== "object") return;
  if (
    data.type === "gc.theme" &&
    (data.theme === "dark" || data.theme === "light" || data.theme === null)
  ) {
    setHostTheme(data.theme);
  } else if (data.type === "gc.tokens" && data.tokens && typeof data.tokens === "object") {
    setHostTokens(data.tokens as Record<string, string>);
  } else if (data.type === "gc.tokens.clear") {
    setHostTokens(null);
  }
});

// Announce readiness so the embedder can push the initial token snapshot
// without racing the iframe load event.
try {
  window.parent.postMessage({ type: "gc.ready" }, "*");
} catch {
  /* not embedded; ignore */
}

import "./app.ts";
