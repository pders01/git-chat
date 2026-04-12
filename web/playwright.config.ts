import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:18080",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "desktop",
      testMatch: /layout\.spec/,
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec/,
      use: { viewport: { width: 375, height: 812 } },
    },
  ],
  // Server is started externally via `make test-e2e` — Playwright
  // doesn't manage the Go binary lifecycle.
  webServer: undefined,
});
