import { MessageRole } from "../gen/gitchat/v1/chat_pb.js";

export { MessageRole };

// A turn in the in-memory transcript. For messages loaded from history it
// maps 1:1 onto ChatMessage; for the in-flight assistant turn, `streaming`
// is true and `content` grows as tokens arrive.
//
// `html` is the DOMPurify-sanitized markdown rendering of `content`. We
// populate it lazily — once after streaming finishes for live turns, and
// immediately after load for historical turns. While a turn is actively
// streaming, `html` stays undefined and the UI falls back to plain text.
// Re-parsing markdown on every token would produce visual flicker (fenced
// code blocks opening and closing) and wastes CPU on Shiki calls that
// would be invalidated on the next chunk.
export type Turn = {
  id: string;
  role: MessageRole;
  content: string;
  model?: string;
  streaming?: boolean;
  html?: string;
  tokensIn?: number;
  tokensOut?: number;
  // Non-empty when the assistant turn errored mid-stream or completed
  // with Done.error. Surfaces a retry button on that turn and lets
  // the regenerate path distinguish "rerun a good answer" from
  // "recover from a failure".
  error?: string;
  attachments?: ClientAttachment[];
  // Soft server-side notices ("images stripped — model doesn't support
  // vision"). Rendered below the user turn so the degradation is
  // visible without blocking the stream.
  warnings?: string[];
  // Agentic tool invocations the assistant triggered during this
  // turn, in the order they were emitted. A ToolEvent starts with
  // state="running" on the ToolCall chunk and flips to "done" on
  // the matching ToolResult. Rendered as a compact summary block
  // above the assistant prose; expand to see args + result.
  tools?: ToolEvent[];
  // Reasoning-model chain-of-thought accumulated during this turn.
  // Rendered as a collapsible "thinking" block above the reply.
  // Kept separate from `content` so the user's clipboard copy of
  // the assistant turn stays clean.
  thinking?: string;
  thinkingExpanded?: boolean;
};

export type ToolEvent = {
  id: string;
  name: string;
  argsJson: string;
  state: "running" | "done" | "error";
  content?: string;
  expanded?: boolean;
};

// ClientAttachment is the composer/rendering shape for a user-uploaded
// file. `url` is an object URL created once for image previews — we
// lean on browser-tab lifetime rather than bookkeeping revocations,
// since the upload caps keep total memory bounded.
export type ClientAttachment = {
  mimeType: string;
  filename: string;
  size: number;
  data: Uint8Array;
  url?: string;
};

// Per-model pricing in dollars per million tokens.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "gpt-4o": { in: 2.5, out: 10 },
};
const DEFAULT_PRICING = { in: 5, out: 15 };

export function estimateCost(model: string, tokensIn: number, tokensOut: number): string {
  const key = Object.keys(MODEL_PRICING).find((k) => model.toLowerCase().includes(k));
  const rate = key ? MODEL_PRICING[key] : DEFAULT_PRICING;
  const cost = (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
  if (cost < 0.001) return "<$0.001";
  return `~$${cost.toFixed(3)}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// fmtToolSummary renders a one-line recap of a tool invocation that
// still reads at a glance: the top-level string args joined compactly.
export function fmtToolSummary(ev: ToolEvent): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = ev.argsJson ? JSON.parse(ev.argsJson) : {};
  } catch {
    return ev.argsJson.slice(0, 80);
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.length > 0) parts.push(`${k}=${v}`);
  }
  return parts.join(" · ");
}

// fmtJSON reformats a JSON blob for the expanded tool panel.
export function fmtJSON(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type ViewState =
  | { phase: "loading" }
  | {
      phase: "ready";
      sessions: import("../gen/gitchat/v1/chat_pb.js").ChatSession[];
      selected: string | null;
    }
  | { phase: "error"; message: string };

export function turnFromMessage(m: import("../gen/gitchat/v1/chat_pb.js").ChatMessage): Turn {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model || undefined,
    tokensIn: Number(m.tokenCountIn) || undefined,
    tokensOut: Number(m.tokenCountOut) || undefined,
    attachments:
      m.attachments && m.attachments.length > 0
        ? m.attachments.map(attachmentFromProto)
        : undefined,
    tools:
      m.toolEvents && m.toolEvents.length > 0
        ? m.toolEvents.map((e) => ({
            id: e.toolCallId,
            name: e.name,
            argsJson: e.argsJson,
            state: e.isError ? ("error" as const) : ("done" as const),
            content: e.resultContent,
          }))
        : undefined,
  };
}

function attachmentFromProto(a: {
  mimeType: string;
  filename: string;
  size: bigint;
  data: Uint8Array;
}): ClientAttachment {
  const out: ClientAttachment = {
    mimeType: a.mimeType,
    filename: a.filename,
    size: Number(a.size),
    data: a.data,
  };
  if (out.mimeType.startsWith("image/") && a.data.byteLength > 0) {
    out.url = bytesToDataURL(a.data, out.mimeType);
  }
  return out;
}

// bytesToDataURL builds a data: URL from raw bytes. Data URLs sidestep
// Blob lifetime and object-URL revocation entirely, and our attachment
// caps keep the resulting string from growing pathologically.
function bytesToDataURL(data: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
