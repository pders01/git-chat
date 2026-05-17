/** Extract a human-readable message from an unknown thrown value. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
