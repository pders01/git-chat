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
import awk from "@shikijs/langs/awk";
import c from "@shikijs/langs/c";
import clojure from "@shikijs/langs/clojure";
import cpp from "@shikijs/langs/cpp";
import crystal from "@shikijs/langs/crystal";
import css from "@shikijs/langs/css";
import csv from "@shikijs/langs/csv";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/docker";
import dotenv from "@shikijs/langs/dotenv";
import elixir from "@shikijs/langs/elixir";
import erlang from "@shikijs/langs/erlang";
import fish from "@shikijs/langs/fish";
import fsharp from "@shikijs/langs/fsharp";
import gleam from "@shikijs/langs/gleam";
import glsl from "@shikijs/langs/glsl";
import go from "@shikijs/langs/go";
import graphql from "@shikijs/langs/graphql";
import haskell from "@shikijs/langs/haskell";
import hcl from "@shikijs/langs/hcl";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import json5 from "@shikijs/langs/json5";
import jsx from "@shikijs/langs/jsx";
import lisp from "@shikijs/langs/lisp";
import lua from "@shikijs/langs/lua";
import markdown from "@shikijs/langs/markdown";
import nginx from "@shikijs/langs/nginx";
import nim from "@shikijs/langs/nim";
import nix from "@shikijs/langs/nix";
import nushell from "@shikijs/langs/nushell";
import ocaml from "@shikijs/langs/ocaml";
import perl from "@shikijs/langs/perl";
import php from "@shikijs/langs/php";
import powershell from "@shikijs/langs/powershell";
import proto from "@shikijs/langs/proto";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import sshConfig from "@shikijs/langs/ssh-config";
import systemd from "@shikijs/langs/systemd";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import v from "@shikijs/langs/v";
import vue from "@shikijs/langs/vue";
import wgsl from "@shikijs/langs/wgsl";
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
  return document.documentElement.getAttribute("data-theme") === "light" ? THEME_LIGHT : THEME_DARK;
}

// The set of grammar names we ship. Anything outside this set renders as
// plaintext. Keep in sync with the imports above and with the Go-side
// languageByExt map in internal/repo/language.go.
const BUNDLED_LANGS = new Set<string>([
  "awk",
  "c",
  "clojure",
  "cpp",
  "crystal",
  "css",
  "csv",
  "diff",
  "dockerfile",
  "dotenv",
  "elixir",
  "erlang",
  "fish",
  "fsharp",
  "gleam",
  "glsl",
  "go",
  "graphql",
  "haskell",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "json5",
  "jsx",
  "lisp",
  "lua",
  "markdown",
  "nginx",
  "nim",
  "nix",
  "nushell",
  "ocaml",
  "perl",
  "php",
  "powershell",
  "proto",
  "python",
  "ruby",
  "rust",
  "shellscript",
  "sql",
  "ssh-config",
  "systemd",
  "toml",
  "tsx",
  "typescript",
  "v",
  "vue",
  "wgsl",
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
        awk,
        c,
        clojure,
        cpp,
        crystal,
        css,
        csv,
        diff,
        dockerfile,
        dotenv,
        elixir,
        erlang,
        fish,
        fsharp,
        gleam,
        glsl,
        go,
        graphql,
        haskell,
        hcl,
        html,
        ini,
        java,
        javascript,
        json,
        json5,
        jsx,
        lisp,
        lua,
        markdown,
        nginx,
        nim,
        nix,
        nushell,
        ocaml,
        perl,
        php,
        powershell,
        proto,
        python,
        ruby,
        rust,
        shellscript,
        sql,
        sshConfig,
        systemd,
        toml,
        tsx,
        typescript,
        v,
        vue,
        wgsl,
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
