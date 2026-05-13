import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";
import * as vscode from "vscode";

// resolveBinary returns an absolute path to the git-chat binary using this
// precedence:
//   1. gitChat.binaryPath setting (explicit override)
//   2. GITCHAT_EXT_BINARY env var (mostly for development)
//   3. `git-chat` on PATH
//   4. previously downloaded copy in extension globalStorageUri
//
// If none resolve, we throw with a message linking to the README. Real
// auto-download is intentionally deferred until GitHub releases exist —
// shipping a half-working downloader would fail on first activate.
export async function resolveBinary(
  ctx: vscode.ExtensionContext,
): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("gitChat");
  const settingPath = cfg.get<string>("binaryPath", "").trim();
  if (settingPath && (await isExecutable(settingPath))) {
    return settingPath;
  }

  const envPath = (process.env.GITCHAT_EXT_BINARY ?? "").trim();
  if (envPath && (await isExecutable(envPath))) {
    return envPath;
  }

  const onPath = await whichGitChat();
  if (onPath) return onPath;

  const cached = path.join(ctx.globalStorageUri.fsPath, binaryName());
  if (await isExecutable(cached)) return cached;

  throw new Error(
    "git-chat binary not found. Install it (`brew install git-chat` or `go install github.com/pders01/git-chat/cmd/git-chat@latest`) " +
      "or set `gitChat.binaryPath` in settings. Auto-download is not yet implemented; see extension/README.md.",
  );
}

function binaryName(): string {
  return process.platform === "win32" ? "git-chat.exe" : "git-chat";
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichGitChat(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    cp.execFile(cmd, ["git-chat"], (err, stdout) => {
      if (err) return resolve(null);
      const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(first ? first.trim() : null);
    });
  });
}

// platformTag maps NodeJS platform/arch to the GitHub release asset
// naming convention. Reserved for the future download path.
export function platformTag(): string {
  const arch = os.arch() === "x64" ? "amd64" : os.arch();
  switch (process.platform) {
    case "darwin":
      return `darwin-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "win32":
      return `windows-${arch}`;
    default:
      return `${process.platform}-${arch}`;
  }
}
