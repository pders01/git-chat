import * as cp from "node:child_process";
import * as vscode from "vscode";

import { resolveBinary } from "./binary";
import { parseReadyLine, type ReadyInfo } from "./parseReady";

// One active session = one git-chat process + one webview panel.
// Restart kills+respawns. Closing the panel kills the process.
interface Session {
  proc: cp.ChildProcess;
  panel: vscode.WebviewPanel;
  ready: ReadyInfo;
}

let current: Session | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("git-chat");
  ctx.subscriptions.push(outputChannel);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("gitChat.open", () =>
      openCommand(ctx).catch(reportError),
    ),
    vscode.commands.registerCommand("gitChat.restart", () =>
      restartCommand(ctx).catch(reportError),
    ),
  );
}

export function deactivate(): void {
  if (current) {
    killSession(current);
    current = undefined;
  }
}

async function openCommand(ctx: vscode.ExtensionContext): Promise<void> {
  if (current) {
    current.panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  const folder = pickWorkspaceFolder();
  if (!folder) {
    vscode.window.showErrorMessage(
      "git-chat needs an open workspace folder containing a git repository.",
    );
    return;
  }
  current = await launchSession(ctx, folder.uri.fsPath);
}

async function restartCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const folder = pickWorkspaceFolder();
  if (!folder) return;
  if (current) {
    killSession(current);
    current = undefined;
  }
  current = await launchSession(ctx, folder.uri.fsPath);
}

function pickWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders[0];
}

async function launchSession(
  ctx: vscode.ExtensionContext,
  cwd: string,
): Promise<Session> {
  const binary = await resolveBinary(ctx);
  const cfg = vscode.workspace.getConfiguration("gitChat");
  const args = ["local", "--ext-mode", "--http", "127.0.0.1:0", cwd];
  const llmBackend = cfg.get<string>("llmBackend", "").trim();
  if (llmBackend) args.push("--llm-backend", llmBackend);
  const llmBase = cfg.get<string>("llmBaseUrl", "").trim();
  if (llmBase) args.push("--llm-base-url", llmBase);
  const llmModel = cfg.get<string>("llmModel", "").trim();
  if (llmModel) args.push("--llm-model", llmModel);

  log(`spawn ${binary} ${args.join(" ")}`);
  const proc = cp.spawn(binary, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const ready = await waitForReady(proc);
  log(`ready port=${ready.port}`);

  const panel = vscode.window.createWebviewPanel(
    "gitChat",
    "git-chat",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: [
        { webviewPort: ready.port, extensionHostPort: ready.port },
      ],
    },
  );
  panel.webview.html = renderWebviewHtml(ready);

  const session: Session = { proc, panel, ready };
  panel.onDidDispose(() => {
    if (current === session) {
      current = undefined;
    }
    killSession(session);
  });
  proc.on("exit", (code) => {
    log(`git-chat exited code=${code}`);
    if (current === session) {
      panel.dispose();
    }
  });
  return session;
}

function waitForReady(proc: cp.ChildProcess): Promise<ReadyInfo> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("git-chat did not emit GITCHAT_READY within 20s"));
    }, 20_000);

    let stdoutBuf = "";
    const onStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const ready = parseReadyLine(line);
        if (ready) {
          cleanup();
          resolve(ready);
          return;
        }
        log(`stdout: ${line}`);
      }
    };
    const onStderr = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const line of s.split(/\r?\n/)) {
        if (line.length > 0) log(`stderr: ${line}`);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`git-chat exited before ready (code=${code})`));
    };
    function cleanup() {
      clearTimeout(timeout);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("exit", onExit);
    }

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
  });
}

function renderWebviewHtml(ready: ReadyInfo): string {
  // The iframe loads the Go server's SPA directly. The portMapping in
  // createWebviewPanel rewrites 127.0.0.1:<port> so VS Code's webview
  // sandbox lets the request through. Token is one-shot — claimed by
  // the SPA on first load.
  const src = `http://127.0.0.1:${ready.port}/?t=${ready.token}`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${ready.port}; style-src 'unsafe-inline';" />
    <title>git-chat</title>
    <style>
      html, body { height: 100%; margin: 0; padding: 0; background: #111; }
      iframe { border: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>
  </body>
</html>`;
}

function killSession(s: Session): void {
  try {
    if (s.proc.exitCode === null && s.proc.signalCode === null) {
      s.proc.kill();
    }
  } catch {
    // best effort
  }
}

function log(msg: string): void {
  outputChannel?.appendLine(msg);
}

function reportError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  log(`error: ${msg}`);
  vscode.window.showErrorMessage(`git-chat: ${msg}`);
}
