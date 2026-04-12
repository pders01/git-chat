// Markdown → HTML pipeline used by the chat view for assistant responses.
//
// Pipeline:
//   1. An optional diff-resolution pass replaces `[[diff from=X to=Y
//      path=Z]]` markers with fenced diff code blocks. The resolver is
//      supplied by the caller (who knows repoId and how to reach the
//      backend) and is awaited in parallel across all markers in a
//      single pass.
//   2. `marked` parses the markdown into tokens.
//   3. An async `walkTokens` pass runs every fenced code block through the
//      shared Shiki highlighter (see `highlight.ts`). Results are attached
//      to each token as a `shikiHtml` field.
//   4. A custom renderer returns the pre-computed Shiki HTML for code
//      blocks, and marked's defaults for everything else.
//   5. DOMPurify strips anything dangerous from the final HTML.
//
// The reason Shiki runs in `walkTokens` instead of a synchronous
// `renderer.code` is that `highlight()` returns a Promise — marked's
// sync render path can't await it. The two-pass design (async walk, then
// sync render) is the pattern marked's docs recommend for async
// integrations in v9+.

import { Marked } from "marked";
import DOMPurify, { type Config as PurifyConfig } from "dompurify";
import { highlight } from "./highlight.js";

// DiffRef is a parsed `[[diff from=X to=Y path=Z]]` marker. Any of
// from/to may be empty; the backend applies defaults ("" to = HEAD,
// "" from = parent of to).
export type DiffRef = {
  from: string;
  to: string;
  path: string;
};

// DiffResolver is a caller-supplied function that fetches the unified
// diff for a given ref tuple. Returns the plain patch text that will
// be embedded in a fenced `diff` code block. Throw or return empty
// string to skip the marker.
export type DiffResolver = (ref: DiffRef) => Promise<string>;

// markerPattern matches `[[diff]]` and `[[diff key=value key=value …]]`.
// The attrs group is optional — `[[diff]]` alone is a valid
// "latest-commit whole diff" shape (HEAD vs HEAD^, all files). Keys
// and values in the attr list are whitespace-separated; values may
// be bare (no whitespace) or "double-quoted". Any non-obvious
// attribute parse failure falls back to "marker left as-is" so the
// LLM's output isn't silently corrupted when it produces something
// unusual.
const markerPattern = /\[\[diff(?:\s+([^\]\n]+))?\]\]/g;

// A code token as marked defines it. We extend it with an optional
// `shikiHtml` field populated during walkTokens.
type CodeToken = {
  type: "code";
  raw: string;
  codeBlockStyle?: string;
  lang?: string;
  text: string;
  escaped?: boolean;
  shikiHtml?: string;
};

// Single shared Marked instance — configuration is applied once at module
// load, not per call. Creating a new instance (rather than mutating the
// default marked export) keeps the configuration local to this module and
// avoids global side effects if a future caller imports marked directly.
const marked = new Marked({
  async: true,
  gfm: true,
  breaks: false,
  walkTokens: async (token) => {
    if (token.type === "code") {
      const t = token as CodeToken;
      t.shikiHtml = await highlight(t.text, (t.lang || "").trim() || "plaintext");
    }
  },
});

// Custom renderer: only the `code` block is overridden. Everything else
// (paragraphs, lists, inline code, links, headings) uses marked's
// defaults, which already produce safe, well-formed HTML.
marked.use({
  renderer: {
    code(token) {
      const t = token as CodeToken;
      if (t.shikiHtml) return t.shikiHtml;
      // Defensive fallback: if walkTokens didn't get a chance to run
      // (shouldn't happen, but better safe), render as plain <pre>.
      const escaped = escapeHtml(t.text);
      return `<pre><code>${escaped}</code></pre>`;
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// DOMPurify config: allow the HTML tags marked emits for standard
// markdown, plus the span/pre structure Shiki emits for highlighted code.
// Explicitly no <script>, no <iframe>, no event handlers. We allow class
// and style on spans (Shiki uses inline styles for theming).
const PURIFY_CONFIG: PurifyConfig = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "code",
    "pre",
    "span",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "details",
    "summary",
  ],
  ALLOWED_ATTR: ["class", "style", "href", "title", "open"],
  // Links must be http(s) only. No javascript:, no data:, no mailto.
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
};

// renderMarkdown turns markdown source into sanitized HTML ready to feed
// into Lit's `unsafeHTML` directive. Safe to call with LLM output that
// may contain embedded HTML, script tags, or exotic URI schemes —
// DOMPurify strips them all before return.
//
// If `resolveDiff` is provided, `[[diff …]]` markers in the source are
// resolved in parallel before marked sees the text; each marker becomes
// a fenced ```diff block that Shiki highlights like any other language.
export async function renderMarkdown(
  source: string,
  resolveDiff?: DiffResolver,
): Promise<string> {
  if (!source) return "";
  const prepared = resolveDiff
    ? await expandDiffMarkers(source, resolveDiff)
    : source;
  const raw = await marked.parse(prepared);
  // DOMPurify returns `TrustedHTML | string` based on its overload
  // resolution when trustedTypes are in play. A plain string is what
  // Lit's unsafeHTML wants, so force the cast via unknown.
  return DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string;
}

// expandDiffMarkers finds every `[[diff …]]` marker in `source`,
// resolves them in parallel, and returns the source with each marker
// replaced by a fenced `diff` code block. Markers that fail to parse
// or resolve are left as-is so the user at least sees the raw LLM
// output rather than a silently-disappeared marker.
async function expandDiffMarkers(
  source: string,
  resolveDiff: DiffResolver,
): Promise<string> {
  type Hit = { match: string; start: number; end: number; ref: DiffRef | null };
  const hits: Hit[] = [];
  for (const m of source.matchAll(markerPattern)) {
    let start = m.index ?? 0;
    let end = start + m[0].length;
    // Defensive parser cleanup: Gemma (and other smaller models) often
    // wrap markers in inline-code backticks like `[[diff]]`. Left in
    // place, those backticks become orphans after we swap the middle
    // for a fenced block. Detect matched adjacent backticks and
    // absorb them into the replacement range.
    while (start > 0 && source[start - 1] === "`" && source[end] === "`") {
      start -= 1;
      end += 1;
    }
    // m[1] is undefined for the zero-attr form [[diff]]; treat it as
    // "whole HEAD commit, all files" by producing an empty-but-valid
    // DiffRef.
    const ref: DiffRef = m[1] ? parseDiffAttrs(m[1]) : emptyRef();
    hits.push({
      match: source.slice(start, end),
      start,
      end,
      ref,
    });
  }
  if (hits.length === 0) return source;

  // Resolve every parseable marker in parallel. Failures are captured
  // as empty strings and the marker stays as-is in the output.
  const resolutions = await Promise.all(
    hits.map(async (h) => {
      if (!h.ref) return null;
      try {
        const diff = await resolveDiff(h.ref);
        return diff;
      } catch {
        return null;
      }
    }),
  );

  // Splice replacements in reverse order so earlier indices stay valid
  // as we mutate the string.
  let out = source;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    const resolved = resolutions[i];
    if (resolved == null || resolved === "") continue;
    // Wrap in <details open> so the user gets a collapse-toggle for
    // free. The <summary> carries path + ref range as a header.
    const label = diffLabel(h.ref!);
    const replacement = [
      "",
      `<details class="diff-block" open>`,
      `<summary>${escapeHtml(label)}</summary>`,
      "",
      "```diff",
      resolved,
      "```",
      "",
      "</details>",
      "",
    ].join("\n");
    out = out.slice(0, h.start) + replacement + out.slice(h.end);
  }
  return out;
}

// diffLabel builds the human-readable header for a diff block.
// Examples: "internal/repo/reader.go (HEAD^..HEAD)"
//           "commit diff (HEAD^..HEAD)"
function diffLabel(ref: DiffRef): string {
  const path = ref.path || "commit diff";
  const from = ref.from || "HEAD^";
  const to = ref.to || "HEAD";
  return `${path} (${from}..${to})`;
}

function emptyRef(): DiffRef {
  return { from: "", to: "", path: "" };
}

// parseDiffAttrs accepts the inner text of a `[[diff …]]` marker
// (everything between `diff ` and `]]`) and returns a DiffRef.
// Accepts `key=value` with optional double quotes around values;
// unknown keys are ignored. Returns the parsed ref unconditionally —
// even an empty marker is valid and means "whole HEAD commit, all
// files".
function parseDiffAttrs(inner: string): DiffRef {
  const ref: DiffRef = { from: "", to: "", path: "" };
  // Tokenizer that handles "quoted values" with spaces.
  const tokenRe = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  for (const m of inner.matchAll(tokenRe)) {
    const key = m[1]!;
    const val = m[2] ?? m[3] ?? "";
    switch (key) {
      case "from":
        ref.from = val;
        break;
      case "to":
        ref.to = val;
        break;
      case "path":
        ref.path = val;
        break;
    }
  }
  return ref;
}
