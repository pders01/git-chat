// Shiki-backed code highlighting with **tiered** language bundles.
//
// Core languages (~20) ship with the initial bundle for instant startup.
// Extended languages (~30+) are fetched on-demand when first encountered.
// This balances fast initial load with comprehensive language support.

import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

// Themes: dark + light, selected at highlight time based on active theme.
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";
import { getTheme } from "./settings.js";

// ============ CORE LANGUAGES (always loaded) ============
// These cover ~90% of typical repository viewing patterns.
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import css from "@shikijs/langs/css";
import dockerfile from "@shikijs/langs/docker";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";

const THEME_DARK = "github-dark-default";
const THEME_LIGHT = "github-light-default";

function activeTheme(): string {
  const choice = getTheme();
  if (choice === "light") return THEME_LIGHT;
  if (choice === "dark") return THEME_DARK;
  return document.documentElement.getAttribute("data-theme") === "light" ? THEME_LIGHT : THEME_DARK;
}

// Core languages that ship with the initial bundle
const CORE_LANGS = new Set<string>([
  "c",
  "cpp",
  "css",
  "dockerfile",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "ruby",
  "rust",
  "shellscript",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
]);

// Extended language registry — maps grammar name to dynamic import.
// These are fetched on-demand when first encountered.
const EXTENDED_LANG_IMPORTS: Record<
  string,
  () => Promise<LanguageRegistration | LanguageRegistration[]>
> = {
  awk: () => import("@shikijs/langs/awk").then((m) => m.default ?? m),
  clojure: () => import("@shikijs/langs/clojure").then((m) => m.default ?? m),
  crystal: () => import("@shikijs/langs/crystal").then((m) => m.default ?? m),
  csv: () => import("@shikijs/langs/csv").then((m) => m.default ?? m),
  diff: () => import("@shikijs/langs/diff").then((m) => m.default ?? m),
  dotenv: () => import("@shikijs/langs/dotenv").then((m) => m.default ?? m),
  elixir: () => import("@shikijs/langs/elixir").then((m) => m.default ?? m),
  erlang: () => import("@shikijs/langs/erlang").then((m) => m.default ?? m),
  fish: () => import("@shikijs/langs/fish").then((m) => m.default ?? m),
  fsharp: () => import("@shikijs/langs/fsharp").then((m) => m.default ?? m),
  gleam: () => import("@shikijs/langs/gleam").then((m) => m.default ?? m),
  glsl: () => import("@shikijs/langs/glsl").then((m) => m.default ?? m),
  graphql: () => import("@shikijs/langs/graphql").then((m) => m.default ?? m),
  haskell: () => import("@shikijs/langs/haskell").then((m) => m.default ?? m),
  hcl: () => import("@shikijs/langs/hcl").then((m) => m.default ?? m),
  ini: () => import("@shikijs/langs/ini").then((m) => m.default ?? m),
  json5: () => import("@shikijs/langs/json5").then((m) => m.default ?? m),
  lisp: () => import("@shikijs/langs/lisp").then((m) => m.default ?? m),
  lua: () => import("@shikijs/langs/lua").then((m) => m.default ?? m),
  nginx: () => import("@shikijs/langs/nginx").then((m) => m.default ?? m),
  nim: () => import("@shikijs/langs/nim").then((m) => m.default ?? m),
  nix: () => import("@shikijs/langs/nix").then((m) => m.default ?? m),
  nushell: () => import("@shikijs/langs/nushell").then((m) => m.default ?? m),
  ocaml: () => import("@shikijs/langs/ocaml").then((m) => m.default ?? m),
  perl: () => import("@shikijs/langs/perl").then((m) => m.default ?? m),
  php: () => import("@shikijs/langs/php").then((m) => m.default ?? m),
  powershell: () => import("@shikijs/langs/powershell").then((m) => m.default ?? m),
  proto: () => import("@shikijs/langs/proto").then((m) => m.default ?? m),
  "ssh-config": () => import("@shikijs/langs/ssh-config").then((m) => m.default ?? m),
  systemd: () => import("@shikijs/langs/systemd").then((m) => m.default ?? m),
  v: () => import("@shikijs/langs/v").then((m) => m.default ?? m),
  wgsl: () => import("@shikijs/langs/wgsl").then((m) => m.default ?? m),
  zig: () => import("@shikijs/langs/zig").then((m) => m.default ?? m),
};

const EXTENDED_LANGS = new Set(Object.keys(EXTENDED_LANG_IMPORTS));

// Track which extended languages have been loaded
const loadedExtendedLangs = new Set<string>();

let instance: HighlighterCore | null = null;
let initPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (instance) return instance;
  if (!initPromise) {
    initPromise = createHighlighterCore({
      themes: [githubDark, githubLight],
      langs: [
        c,
        cpp,
        css,
        dockerfile,
        go,
        html,
        java,
        javascript,
        json,
        jsx,
        markdown,
        python,
        ruby,
        rust,
        shellscript,
        sql,
        toml,
        tsx,
        typescript,
        vue,
        xml,
        yaml,
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).then((h) => {
      instance = h;
      return h;
    });
  }
  return initPromise;
}

// Load an extended language on-demand
async function loadExtendedLanguage(h: HighlighterCore, lang: string): Promise<void> {
  if (loadedExtendedLangs.has(lang) || !EXTENDED_LANGS.has(lang)) return;

  try {
    const loader = EXTENDED_LANG_IMPORTS[lang];
    const grammar = await loader();
    await h.loadLanguage(grammar);
    loadedExtendedLangs.add(lang);
  } catch (err) {
    console.warn(`Failed to load language '${lang}':`, err);
  }
}

// highlight returns Shiki-rendered HTML for code.
// Core languages render immediately; extended languages load on-demand.
// Unknown languages fall through to plaintext without throwing.
export async function highlight(code: string, lang: string): Promise<string> {
  const h = await getHighlighter();

  // Core language — available immediately
  if (CORE_LANGS.has(lang)) {
    return h.codeToHtml(code, { lang, theme: activeTheme() });
  }

  // Extended language — load on demand then render
  if (EXTENDED_LANGS.has(lang)) {
    await loadExtendedLanguage(h, lang);
    if (loadedExtendedLangs.has(lang)) {
      return h.codeToHtml(code, { lang, theme: activeTheme() });
    }
    // Fallback to plaintext if loading failed
    return h.codeToHtml(code, { lang: "plaintext", theme: activeTheme() });
  }

  // Unknown language — plaintext
  return h.codeToHtml(code, { lang: "plaintext", theme: activeTheme() });
}
