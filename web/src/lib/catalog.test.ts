import { describe, expect, test } from "bun:test";
import { formatSources } from "./catalog.js";

describe("formatSources", () => {
  test("returns empty string for missing input", () => {
    expect(formatSources(undefined)).toBe("");
    expect(formatSources([])).toBe("");
  });

  test("single source renders as the id itself", () => {
    expect(formatSources(["catwalk"])).toBe("catwalk");
  });

  test("multi-source renders joined with +", () => {
    expect(formatSources(["catwalk", "openrouter"])).toBe("catwalk+openrouter");
    expect(formatSources(["catwalk", "openrouter", "models-dev"])).toBe(
      "catwalk+openrouter+models-dev",
    );
  });

  test("preserves caller's source order (merge order matters)", () => {
    // The merge orchestrator controls source order (registration order
    // for tiebreaks). Downstream display respects that ordering so
    // "catwalk+openrouter" stays stable across refreshes.
    expect(formatSources(["openrouter", "catwalk"])).toBe("openrouter+catwalk");
  });
});
