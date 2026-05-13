// User preferences persisted to localStorage and applied as CSS
// variable overrides on :root. Every setting has a default from the
// design tokens in index.html; user overrides replace them at runtime.
//
// Settings are read once on boot (applyAll) and written on every
// change (set). Components that need reactive updates can subscribe
// via onChange().

const PREFIX = "gc.settings.";

export type SettingKey = "sidebar-width" | "content-max-width" | "font-size";

export type ThemeChoice = "system" | "light" | "dark";

const DEFAULTS: Record<SettingKey, string> = {
  "sidebar-width": "260px",
  "content-max-width": "820px",
  "font-size": "0.84rem",
};

// CSS variable names mapped from setting keys.
const CSS_VAR: Record<SettingKey, string> = {
  "sidebar-width": "--sidebar-width",
  "content-max-width": "--content-max-width",
  "font-size": "--text-base",
};

// ── Theme management ──────────────────────────────────────────

const THEME_KEY = PREFIX + "theme";
const darkMq = window.matchMedia("(prefers-color-scheme: dark)");

// Embedding host (e.g. VS Code extension webview) can advertise a
// preferred theme via postMessage. We honour it ONLY when the user's
// stored choice is "system" — explicit dark/light from the UI wins.
let hostTheme: "dark" | "light" | null = null;

function resolveTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice === "system") {
    return hostTheme ?? (darkMq.matches ? "dark" : "light");
  }
  return choice;
}

// setHostTheme is called when the embedding context (VS Code, Open VSX)
// tells us its active colour theme. Does NOT persist — the host is the
// authority while it's hosting, but the user's explicit choice (dark
// or light) still wins. Pass null to clear (host detached).
export function setHostTheme(theme: "dark" | "light" | null) {
  if (hostTheme === theme) return;
  hostTheme = theme;
  if (getTheme() === "system") {
    applyTheme(resolveTheme("system"));
    notify();
  }
}

// Host-provided design tokens. Embedder (VS Code extension webview)
// posts a snapshot of resolved colour values keyed by our semantic
// token names (--surface-1, --text-default, --accent, etc). We
// overlay them on :root with setProperty, which beats the index.html
// :root defaults at CSS specificity. Pass null to clear.
//
// Only a fixed allow-list of token names is honoured — a hostile or
// buggy host can't inject arbitrary CSS variables. List mirrors the
// 13 entries in the extension's token map (extension/src/extension.ts)
// and includes the SPA-side aliases the design system depends on.
const HOST_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  "--surface-0",
  "--surface-1",
  "--surface-1-alt",
  "--surface-2",
  "--surface-3",
  "--surface-4",
  "--surface-5",
  "--border-default",
  "--border-strong",
  "--border-focus",
  "--text-default",
  "--text-muted",
  "--text-strong",
  "--text-accent",
  "--accent",
]);

// Names of tokens currently overlaid by the host, so a clear can
// remove only those without touching user-set values.
const appliedHostTokens = new Set<string>();

export function setHostTokens(tokens: Record<string, string> | null) {
  const root = document.documentElement;
  for (const name of appliedHostTokens) {
    root.style.removeProperty(name);
  }
  appliedHostTokens.clear();
  if (!tokens) {
    notify();
    return;
  }
  for (const [name, value] of Object.entries(tokens)) {
    if (!HOST_TOKEN_ALLOWLIST.has(name)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    // Reject anything that isn't a plausible colour value to keep
    // setProperty from accepting `url(...)` or other CSS sneak paths.
    if (!/^[#a-zA-Z0-9(),.\s%-]+$/.test(value)) continue;
    root.style.setProperty(name, value);
    appliedHostTokens.add(name);
  }
  notify();
}

function applyTheme(resolved: "dark" | "light") {
  const el = document.documentElement;
  if (resolved === "light") {
    el.setAttribute("data-theme", "light");
  } else {
    el.removeAttribute("data-theme");
  }
}

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* */
  }
  return "system";
}

export function setTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* */
  }
  applyTheme(resolveTheme(choice));
  notify();
}

// React to OS theme changes when in "system" mode.
darkMq.addEventListener("change", () => {
  if (getTheme() === "system") {
    applyTheme(resolveTheme("system"));
    notify();
  }
});

type Listener = () => void;
const listeners: Listener[] = [];

export function onChange(fn: Listener) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

export function get(key: SettingKey): string {
  try {
    return localStorage.getItem(PREFIX + key) || DEFAULTS[key];
  } catch {
    return DEFAULTS[key];
  }
}

export function set(key: SettingKey, value: string) {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage disabled */
  }
  document.documentElement.style.setProperty(CSS_VAR[key], value);
  notify();
}

export function reset(key: SettingKey) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage disabled */
  }
  document.documentElement.style.removeProperty(CSS_VAR[key]);
  notify();
}

// Apply all saved settings on boot. Call once from main.ts.
export function applyAll() {
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    const val = get(key);
    if (val !== DEFAULTS[key]) {
      document.documentElement.style.setProperty(CSS_VAR[key], val);
    }
  }
  applyTheme(resolveTheme(getTheme()));
}

export function allKeys(): SettingKey[] {
  return Object.keys(DEFAULTS) as SettingKey[];
}

export function defaultFor(key: SettingKey): string {
  return DEFAULTS[key];
}
