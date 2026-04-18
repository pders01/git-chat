import type { ClientAttachment } from "./chat-types.js";

// Client-side attachment validation mirrors the server (see
// internal/chat/service.go). Drift is not checked — keep in sync.
export const ALLOWED_ATTACHMENT_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

export async function readFileToAttachment(file: File): Promise<ClientAttachment> {
  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const att: ClientAttachment = {
    mimeType: file.type || "application/octet-stream",
    filename: file.name || "attachment",
    size: data.byteLength,
    data,
  };
  if (att.mimeType.startsWith("image/")) {
    att.url = bytesToDataURL(data, att.mimeType);
  }
  return att;
}

// bytesToDataURL builds a data: URL from raw bytes.
function bytesToDataURL(data: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
