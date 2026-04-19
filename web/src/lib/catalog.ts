// Shared catalog helpers. Keeps source-attribution rendering identical
// across the settings panel, composer slash-command autocomplete, and
// anywhere else a catalog entry is surfaced.

import type { CatalogProvider } from "../gen/gitchat/v1/repo_pb.js";

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

/**
 * Derive a provider-level source list by unioning every model's
 * sources. Proto tags sources on CatalogModel only; provider-level
 * attribution is implicit in "which sources fed any of its models".
 * Dedups while preserving first-seen order so display stays stable
 * across refreshes.
 */
export function providerSources(c: CatalogProvider): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of c.models ?? []) {
    for (const s of m.sources ?? []) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Context needed to decide whether a catalog provider can actually be
 * called with the current git-chat config. Pure data — no RPC calls —
 * so isProviderAvailable() is testable in isolation.
 */
export interface AvailabilityContext {
  /** URLs of detected local endpoints (LM Studio, Ollama, …). Callable
   * without an API key. */
  localUrls: readonly string[];
  /** Base URLs from saved profiles. Each profile carries its own key
   * by construction, so matching a profile's URL = callable. */
  profileBaseUrls: readonly string[];
  /** Backends used by saved profiles (e.g. "openai", "anthropic").
   * Anthropic-type providers unlock when any anthropic profile exists
   * since the protocol URL is hardcoded in the backend. */
  profileBackends: readonly string[];
  /** Current LLM_BASE_URL config value. Empty string if unset. */
  configBaseUrl: string;
  /** Current LLM_BACKEND config value. Usually "openai" or "anthropic". */
  configBackend: string;
  /** Whether LLM_API_KEY is set (non-empty, even if masked as ••••••••). */
  configHasKey: boolean;
}

/**
 * Decide if a catalog provider is callable right now. The answer is
 * binary — no "maybe, if you configure a key" fuzziness. Pickers use
 * this to hide providers the user can't reach, so picking never puts
 * the config into a state that 404s or (worse) sends the wrong key.
 *
 * Rules:
 *   - Local URLs are always callable — no auth.
 *   - A saved profile's base URL is callable — profile has its own key.
 *   - LLM_BASE_URL is callable iff LLM_API_KEY is set, OR the URL is
 *     localhost (local dev endpoints need no key).
 *   - Anthropic-type providers match differently: the Anthropic
 *     protocol hardcodes the URL, so they unlock when any configured
 *     route uses the anthropic backend + has a key.
 */
export function isProviderAvailable(provider: CatalogProvider, ctx: AvailabilityContext): boolean {
  if (provider.type === "anthropic") {
    if (ctx.profileBackends.includes("anthropic")) return true;
    if (ctx.configBackend === "anthropic" && ctx.configHasKey) return true;
    return false;
  }

  // OpenAI-compatible: need a route whose base URL lines up with this
  // provider's defaultBaseUrl.
  const providerURL = provider.defaultBaseUrl;
  if (!providerURL) return false;

  if (ctx.localUrls.some((u) => urlsMatch(u, providerURL))) return true;
  if (ctx.profileBaseUrls.some((u) => urlsMatch(u, providerURL))) return true;

  if (ctx.configBaseUrl && urlsMatch(ctx.configBaseUrl, providerURL)) {
    const isLocal = isLocalhostURL(ctx.configBaseUrl);
    return isLocal || ctx.configHasKey;
  }
  return false;
}

function urlsMatch(a: string, b: string): boolean {
  const A = normalizeURL(a);
  const B = normalizeURL(b);
  return A === B || A.startsWith(B) || B.startsWith(A);
}

function normalizeURL(u: string): string {
  return u.replace(/\/+$/, "").toLowerCase();
}

/** True if the URL points at the loopback interface. Local endpoints
 * need no API key, so they're exempt from key-leak warnings. */
export function isLocalhostURL(u: string): boolean {
  return (
    u.startsWith("http://localhost") || u.startsWith("http://127.") || u.startsWith("http://[::1]")
  );
}

/** Fold the three pieces of "what routes are configured" (local
 * endpoints, saved profiles, raw config entries) into one
 * AvailabilityContext. Accepts narrow duck-typed shapes so both RPC
 * responses and component @state fields can feed it without casts. */
export function buildAvailabilityContext(
  localEndpoints: ReadonlyArray<{ url?: string }>,
  profiles: ReadonlyArray<{ baseUrl?: string; backend?: string }>,
  configEntries: ReadonlyArray<{ key: string; value: string }>,
): AvailabilityContext {
  const readConfig = (key: string) => configEntries.find((e) => e.key === key)?.value ?? "";
  return {
    localUrls: localEndpoints.map((ep) => ep.url ?? "").filter(Boolean),
    profileBaseUrls: profiles.map((p) => p.baseUrl ?? "").filter(Boolean),
    profileBackends: profiles.map((p) => p.backend ?? "").filter(Boolean),
    configBaseUrl: readConfig("LLM_BASE_URL"),
    configBackend: readConfig("LLM_BACKEND") || "openai",
    // API keys are returned masked ("••••••••") when set, empty when
    // unset — truthiness is the right signal here.
    configHasKey: !!readConfig("LLM_API_KEY"),
  };
}

/** Extract hostname (without port) from a URL. Returns "" for blank
 * input or malformed strings — callers should treat empty as "unknown"
 * rather than "same as other empty". */
export function hostOf(u: string): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Per-1M-token pricing pair. */
export interface ModelPricing {
  in: number;
  out: number;
}

/** Look up pricing for a model by scanning the catalog. Returns null
 * if the model isn't listed, or if it's listed but priced at 0 on both
 * axes (free models — caller decides whether that still means "free"
 * or "unknown pricing" in context). */
export function findModelPricing(
  modelId: string,
  catalog: readonly CatalogProvider[],
): ModelPricing | null {
  for (const prov of catalog) {
    for (const m of prov.models ?? []) {
      if (m.id === modelId) {
        return { in: m.costPer1mIn, out: m.costPer1mOut };
      }
    }
  }
  return null;
}

/** Convert a character count to a rough token count. 1 token ≈ 4 chars
 * for English prose is the well-known heuristic; code and non-English
 * text will diverge, but for pre-send cost estimation this is fine —
 * the actual count comes back with the turn and the estimate's job is
 * "give the user a ballpark before they commit." */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Combine input/output token counts with a pricing pair to produce a
 * USD cost. Returns 0 when pricing is null (unknown) — callers should
 * render "unknown" separately if that's a material distinction for
 * them; most surfaces just want "the number or zero." */
export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  pricing: ModelPricing | null,
): number {
  if (!pricing) return 0;
  return (tokensIn * pricing.in + tokensOut * pricing.out) / 1_000_000;
}
