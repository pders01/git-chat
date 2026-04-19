// Shared catalog helpers. Keeps source-attribution rendering identical
// across the settings panel, composer slash-command autocomplete, and
// anywhere else a catalog entry is surfaced.

/**
 * Render the set of catalog sources that contributed a model into a
 * terse tag string for display next to the model name.
 *
 * Single source: "catwalk"
 * Merged entry: "catwalk+openrouter"
 * Empty/missing: "" (callers filter it out of description lists)
 *
 * Intentionally unadorned — no "via" prefix, no "(source)" parens. The
 * dropdown rows are already dense; adding connector words bloats the
 * line without adding signal. A user who sees "catwalk" and wonders
 * what it means finds the answer in the refresh button's tooltip.
 */
export function formatSources(sources: readonly string[] | undefined): string {
  if (!sources || sources.length === 0) return "";
  return sources.join("+");
}
