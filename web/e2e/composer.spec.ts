import { test, expect, type Page } from "@playwright/test";
import { startServer, authenticate, waitForShadowElement } from "./helpers";

let server: Awaited<ReturnType<typeof startServer>>;
let page: Page;

test.describe("composer keyboard input", () => {
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

  test("can type forward slash in composer", async () => {
    // Click the composer to focus it
    await waitForShadowElement(page, "gc-app gc-chat-view", "textarea");
    await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const textarea = chat?.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
      textarea?.focus();
    });

    // Type a forward slash
    await page.keyboard.type("/");

    // Verify the slash appears in the textarea
    const content = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const textarea = chat?.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
      return textarea?.value ?? "";
    });

    expect(content).toBe("/");
  });

  test("slash focuses composer when not in input", async () => {
    // Blur any focused element first
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      (document.querySelector("gc-app")?.shadowRoot?.activeElement as HTMLElement)?.blur();
    });

    // Press slash to focus composer
    await page.keyboard.press("/");

    // Verify composer is focused
    const isFocused = await page.evaluate(() => {
      const app = document.querySelector("gc-app");
      const chat = app?.shadowRoot?.querySelector("gc-chat-view");
      const textarea = chat?.shadowRoot?.querySelector("textarea");
      return chat?.shadowRoot?.activeElement === textarea;
    });

    expect(isFocused).toBe(true);
  });
});
