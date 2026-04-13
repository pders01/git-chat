import { expect, type Page } from "@playwright/test";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import * as fs from "fs";
import * as net from "net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root is two levels up from web/e2e/
const repoRoot = resolve(__dirname, "../..");

// Global port counter to ensure unique ports across parallel tests
let portCounter = 10000 + Math.floor(Math.random() * 1000);

// Get a unique, available port
async function getUniquePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = () => {
      portCounter++;
      const server = net.createServer();
      server.once("error", () => {
        // Port in use, try next
        tryPort();
      });
      server.once("listening", () => {
        server.close(() => resolve(portCounter));
      });
      server.listen(portCounter, "127.0.0.1");
    };
    tryPort();
  });
}

// buildBinary builds the Go server binary if it doesn't exist or is
// stale. Returns the path to the binary.
export function ensureBinary(): string {
  execSync(
    `go build -trimpath -ldflags "-s -w -X main.version=e2e" -o dist/git-chat ./cmd/git-chat`,
    { stdio: "pipe", cwd: repoRoot },
  );
  return resolve(repoRoot, "dist/git-chat");
}

// startServer starts a git-chat local instance on a free port and
// returns the claim URL + a cleanup function. Uses a temp DB that's
// deleted on cleanup. Retries on port conflicts.
export async function startServer(maxRetries = 3): Promise<{
  url: string;
  logPath: string;
  cleanup: () => void;
}> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await startServerOnce();
    } catch (e) {
      lastError = e as Error;
      // If the error is about port in use, retry
      if (lastError.message.includes("address already in use")) {
        console.log(`Port conflict on attempt ${attempt + 1}, retrying...`);
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      // Other errors are fatal
      throw lastError;
    }
  }
  throw new Error(`Failed to start server after ${maxRetries} attempts: ${lastError?.message}`);
}

// Internal function that attempts to start server once
async function startServerOnce(): Promise<{
  url: string;
  logPath: string;
  cleanup: () => void;
}> {
  const bin = ensureBinary();
  const dbPath = `/tmp/gc-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const logPath = `/tmp/gc-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
  const port = await getUniquePort();

  // Open log file fd and close it when child spawns to prevent leaks
  const logFd = fs.openSync(logPath, "w");

  const child = spawn(bin, [
    "local",
    "--http", `127.0.0.1:${port}`,
    "--no-browser",
    "--db", dbPath,
    repoRoot,
  ], {
    stdio: ["ignore", "ignore", logFd],
    detached: true,
  });

  // Close our copy of the fd now that child has inherited it
  fs.closeSync(logFd);

  // Wait for the server to print the Open URL.
  let url = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const log = fs.readFileSync(logPath, "utf-8");
      const m = log.match(/Open: (http:\/\/[^\s]+)/);
      if (m) {
        url = m[1];
        break;
      }
      // Also check for errors
      if (log.includes("error") || log.includes("Error")) {
        console.error("Server error:", log);
      }
    } catch {
      // file not ready yet
    }
    execSync("sleep 0.1");
  }
  if (!url) {
    const log = fs.readFileSync(logPath, "utf-8");
    console.error("Server log:", log);
    child.kill();
    throw new Error("Server didn't start in time");
  }

  return {
    url,
    logPath,
    cleanup: () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(logPath); } catch {}
    },
  };
}

// authenticate navigates to the claim URL so the session cookie is set,
// then waits for the authenticated shell to render.
export async function authenticate(page: Page, url: string, logPath?: string) {
  // Enable console logging for debugging
  page.on("console", msg => {
    console.log(`[Browser ${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", err => {
    console.error("[Browser error]", err);
  });

  await page.goto(url, { waitUntil: "networkidle" });

  // Debug: log initial state
  const initialUrl = await page.evaluate(() => window.location.href);
  console.log("Initial URL:", initialUrl);

  // Wait for the hash redirect which only happens after successful auth
  // (boot → localClaim → whoami → enterAuthenticated → pushHash).
  // Note: history.pushState() doesn't trigger navigation events, so we poll.
  try {
    await expect.poll(
      async () => {
        const hash = await page.evaluate(() => window.location.hash);
        const href = await page.evaluate(() => window.location.href);
        console.log(`Polling: hash=${hash}, href=${href}`);
        return hash.startsWith("#/");
      },
      { timeout: 30_000, interval: 500 }
    ).toBe(true);
  } catch (e) {
    // Log page content and server logs on failure
    const content = await page.content();
    console.error("Page content:", content.substring(0, 500));
    if (logPath) {
      try {
        const log = fs.readFileSync(logPath, "utf-8");
        console.error("Server log:", log);
      } catch {}
    }
    throw e;
  }

  // Wait for authenticated state to be fully rendered
  await expect.poll(
    async () => {
      const phase = await page.evaluate(() => {
        const app = document.querySelector("gc-app");
        return (app as any)?.state?.phase;
      });
      console.log(`Phase: ${phase}`);
      return phase;
    },
    { timeout: 10_000, interval: 100 }
  ).toBe("authenticated");
}
