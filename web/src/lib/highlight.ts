// Shiki-backed code highlighting with a **fixed** language bundle.
//
// Using `shiki`'s auto `loadLanguage(lang as any)` causes the bundler to
// emit a chunk for every grammar Shiki knows — hundreds of files, some
// several hundred KB each. With `shiki/core` and explicit imports, only
// the grammars listed below reach the build graph. Unused languages from
// git-chat's perspective become plaintext.
//
// Adding a language is two steps: import its loader, add it to the `langs`
// list. Everything else Just Works.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

// Themes: dark + light, selected at highlight time based on active theme.
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";
import { getTheme } from "./settings.js";

// Languages — keep in alphabetical order by Shiki name.
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/docker";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import proto from "@shikijs/langs/proto";
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
import zig from "@shikijs/langs/zig";

const THEME_DARK = "github-dark-default";
const THEME_LIGHT = "github-light-default";

function activeTheme(): string {
  const choice = getTheme();
  if (choice === "light") return THEME_LIGHT;
  if (choice === "dark") return THEME_DARK;
  // "system" — check the resolved data-theme attribute.
  return document.documentElement.getAttribute("data-theme") === "light"
    ? THEME_LIGHT
    : THEME_DARK;
}

// The set of grammar names we ship. Anything outside this set renders as
// plaintext. Keep in sync with the imports above and with the Go-side
// languageByExt map in internal/repo/language.go.
const BUNDLED_LANGS = new Set<string>([
  "c",
  "cpp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "proto",
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
  "zig",
]);

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
        diff,
        dockerfile,
        go,
        html,
        java,
        javascript,
        json,
        jsx,
        markdown,
        proto,
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
        zig,
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).then((h) => {
      instance = h;
      return h;
    });
  }
  return initPromise;
}

// highlight returns Shiki-rendered HTML for code. Unknown languages fall
// through to plaintext without throwing.
export async function highlight(code: string, lang: string): Promise<string> {
  const h = await getHighlighter();
  const effective = BUNDLED_LANGS.has(lang) ? lang : "plaintext";
  return h.codeToHtml(code, {
    lang: effective,
    theme: activeTheme(),
  });
}
