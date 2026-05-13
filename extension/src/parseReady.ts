// READY line protocol: the Go binary, when started with --ext-mode,
// emits exactly one line on stdout shaped:
//
//   GITCHAT_READY port=12345 token=abcd...
//
// before it begins serving. This module owns parsing of that line.
// Keep the format stable — changing it breaks shipped extensions.

export interface ReadyInfo {
  port: number;
  token: string;
}

export function parseReadyLine(line: string): ReadyInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("GITCHAT_READY ")) return null;
  const fields = new Map<string, string>();
  for (const part of trimmed.slice("GITCHAT_READY ".length).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const portStr = fields.get("port");
  const token = fields.get("token");
  if (!portStr || !token) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, token };
}
