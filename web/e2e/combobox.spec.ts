import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, waitForShadowElement, clickShadowElement } from "./helpers";

let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

// Helper: open settings → LLM → Advanced config.
async function openLLMAdvanced(page: Page) {
  await clickShadowElement(page, "gc-app", ".settings-btn");
  await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]');
  await page.evaluate(() => {
    const app = document.querySelector("gc-app");
    const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
    const items = panel?.shadowRoot?.querySelectorAll(".settings-nav-item");
    items?.forEach((item) => {
      if (item.textContent?.trim().startsWith("LLM")) (item as HTMLElement).click();
    });
  });
  await page.evaluate(() => {
    const app = document.querySelector("gc-app");
    const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
    const details = panel?.shadowRoot?.querySelector("details.advanced-config") as HTMLDetailsElement | null;
    if (details && !details.open) details.open = true;
  });
}

// Helper: focus the first gc-combobox input and clear filter.
async function focusCombobox(page: Page) {
  await page.evaluate(() => {
    const app = document.querySelector("gc-app");
    const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
    const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox");
    const input = combobox?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.waitForTimeout(100);
}

// Helper: get combobox state.
async function getState(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector("gc-app");
    const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
    const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox") as any;
    if (!combobox) return { open: false, activeIndex: -1, optionCount: 0, activeLabel: "", inputValue: "", ariaExpanded: "false", ariaActivedescendant: "" };
    const input = combobox.shadowRoot?.querySelector("input") as HTMLInputElement | null;
    const options = combobox.shadowRoot?.querySelectorAll(".option") ?? [];
    const active = combobox.shadowRoot?.querySelector(".option.active");
    return {
      open: combobox.open ?? false,
      activeIndex: active ? [...options].indexOf(active) : -1,
      optionCount: options.length,
      activeLabel: active?.querySelector(".option-label")?.textContent?.trim() ?? "",
      inputValue: input?.value ?? "",
      ariaExpanded: input?.getAttribute("aria-expanded") ?? "false",
      ariaActivedescendant: input?.getAttribute("aria-activedescendant") ?? "",
    };
  });
}

test.describe("combobox keyboard navigation", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    server = await startServer();
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    await authenticate(page, server.url, server.logPath);
  });

  test.afterAll(async () => {
    await page.close();
    server.cleanup();
  });

  test("arrow keys, enter, escape, and aria attributes", async () => {
    await openLLMAdvanced(page);
    await focusCombobox(page);

    // ── ArrowDown opens and highlights first ──
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await getState(page)).activeIndex, { timeout: 2000 }).toBe(0);
    let s = await getState(page);
    expect(s.open).toBe(true);
    expect(s.optionCount).toBeGreaterThan(1);
    expect(s.ariaExpanded).toBe("true");

    // ── ArrowDown advances ──
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await getState(page)).activeIndex, { timeout: 2000 }).toBe(1);

    // ── ArrowUp moves back ──
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await getState(page)).activeIndex, { timeout: 2000 }).toBe(0);

    // ── ArrowUp at first stays at 0 ──
    await page.keyboard.press("ArrowUp");
    s = await getState(page);
    expect(s.activeIndex).toBe(0);

    // ── aria-activedescendant references the active option ──
    const valid = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
      const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox");
      const input = combobox?.shadowRoot?.querySelector("input");
      const id = input?.getAttribute("aria-activedescendant") ?? "";
      return id !== "" && !!combobox?.shadowRoot?.getElementById(id);
    });
    expect(valid).toBe(true);

    // ── Enter selects and closes ──
    const selectedLabel = s.activeLabel;
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await getState(page)).open, { timeout: 3000 }).toBe(false);
    s = await getState(page);
    expect(s.inputValue).toBe(selectedLabel);

    // ── Escape closes without selecting ──
    await focusCombobox(page);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(false);

    // ── Escape does NOT close the settings modal ──
    const settingsStillOpen = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
      return !!panel?.shadowRoot?.querySelector('[role="dialog"][aria-label="Settings"]');
    });
    expect(settingsStillOpen).toBe(true);

    // ── ArrowUp when closed opens and highlights last ──
    // First close via Escape (it's currently closed from above).
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(true);
    s = await getState(page);
    expect(s.activeIndex).toBe(s.optionCount - 1);
    await page.keyboard.press("Escape");

    // ── Enter with no highlight (free-form) closes dropdown ──
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
      const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox");
      const input = combobox?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.value = "custom-value-xyz";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await getState(page)).open, { timeout: 3000 }).toBe(false);

    // Clean up: close settings.
    await clickShadowElement(page, "gc-app gc-settings-panel", ".modal-backdrop");
    await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]', { state: "hidden" });
  });

  test("typing filters the option list", async () => {
    await openLLMAdvanced(page);
    await focusCombobox(page);

    // Verify the unfiltered list has more than 1 option.
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(true);
    const unfiltered = await getState(page);
    expect(unfiltered.optionCount).toBeGreaterThan(1);

    // Type to filter — use evaluate to set value directly (Playwright
    // keyboard.type sends per-character events which are unreliable
    // inside shadow DOM inputs).
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
      const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox");
      const input = combobox?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
      if (input) {
        input.value = "anthropic";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await expect.poll(async () => {
      const s = await getState(page);
      return s.optionCount;
    }, { timeout: 3000 }).toBeLessThan(unfiltered.optionCount);

    const s = await getState(page);
    expect(s.optionCount).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await clickShadowElement(page, "gc-app gc-settings-panel", ".modal-backdrop");
    await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]', { state: "hidden" });
  });

  test("dropdown is positioned directly below input", async () => {
    await openLLMAdvanced(page);
    // Wait for modal entrance animation to finish (0.12s).
    await page.waitForTimeout(200);
    await focusCombobox(page);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await getState(page)).open, { timeout: 2000 }).toBe(true);
    // Give positionListbox() in updated() time to apply styles.
    await page.waitForTimeout(100);

    // Poll until positions stabilize (animation + layout settle).
    await expect.poll(async () => {
      const pos = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        const panel = app?.shadowRoot?.querySelector("gc-settings-panel");
        const combobox = panel?.shadowRoot?.querySelector(".settings-content gc-combobox");
        const input = combobox?.shadowRoot?.querySelector("input");
        const listbox = combobox?.shadowRoot?.querySelector(".listbox") as HTMLElement | null;
        if (!input || !listbox) return null;
        const ir = input.getBoundingClientRect();
        const lr = listbox.getBoundingClientRect();
        return {
          vertGap: Math.round(lr.top - ir.bottom),
          leftDiff: Math.round(Math.abs(lr.left - ir.left)),
          widthDiff: Math.round(Math.abs(lr.width - ir.width)),
        };
      });
      if (!pos) return false;
      return pos.vertGap >= 0 && pos.vertGap <= 10 && pos.leftDiff <= 5 && pos.widthDiff <= 5;
    }, { timeout: 3000 }).toBe(true);

    await page.keyboard.press("Escape");
    await clickShadowElement(page, "gc-app gc-settings-panel", ".modal-backdrop");
    await waitForShadowElement(page, "gc-app gc-settings-panel", '[role="dialog"][aria-label="Settings"]', { state: "hidden" });
  });
});
