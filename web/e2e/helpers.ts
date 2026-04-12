import { type Page } from "@playwright/test";
import { execSync, spawn } from "child_process";
import * as fs from "fs";

// buildBinary builds the Go server binary if it doesn't exist or is
// stale. Returns the path to the binary.
export function ensureBinary(): string {
  const bin = "../dist/git-chat";
  execSync(
    `cd .. && go build -trimpath -ldflags "-s -w -X main.version=e2e" -o dist/git-chat ./cmd/git-chat`,
    { stdio: "pipe" },
  );
  return bin;
}

// startServer starts a git-chat local instance on a free port and
// returns the claim URL + a cleanup function. Uses a temp DB that's
// deleted on cleanup.
export function startServer(): {
  url: string;
  cleanup: () => void;
} {
  const bin = ensureBinary();
  const dbPath = `/tmp/gc-e2e-${Date.now()}.db`;
  const logPath = `/tmp/gc-e2e-${Date.now()}.log`;

  const child = spawn(bin, [
    "local",
    "--http", "127.0.0.1:0",
    "--no-browser",
    "--db", dbPath,
    "..",
  ], {
    stdio: ["ignore", "ignore", fs.openSync(logPath, "w")],
    detached: true,
  });

  // Wait for the server to print the Open URL.
  let url = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const log = fs.readFileSync(logPath, "utf-8");
      const m = log.match(/Open: (http:\/\/[^\s]+)/);
      if (m) {
        url = m[1];
        break;
      }
    } catch {
      // file not ready yet
    }
    execSync("sleep 0.2");
  }
  if (!url) {
    child.kill();
    throw new Error("Server didn't start in time");
  }

  return {
    url,
    cleanup: () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(logPath); } catch {}
    },
  };
}

// authenticate navigates to the claim URL so the session cookie is set,
// then waits for the authenticated shell to render.
export async function authenticate(page: Page, url: string) {
  await page.goto(url);
  // Wait for the hash redirect which only happens after successful auth
  // (boot → localClaim → whoami → enterAuthenticated → pushHash).
  await page.waitForURL(/#\//, { timeout: 10_000 });
  // Give Lit's Shadow DOM children time to fully render.
  await page.waitForTimeout(1500);
}
