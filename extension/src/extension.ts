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
  themeSub: vscode.Disposable;
}

type GcTheme = "dark" | "light";

function currentHostTheme(): GcTheme {
  // VS Code ColorThemeKind: Light=1, Dark=2, HighContrast=3,
  // HighContrastLight=4. Treat high-contrast as their base lightness;
  // the SPA's dual theme covers that adequately.
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light) return "light";
  if (kind === vscode.ColorThemeKind.HighContrastLight) return "light";
  return "dark";
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
  // Go's flag package stops at the first non-flag positional, so every
  // optional --flag must come BEFORE the workspace path. Order matters.
  const args = ["local", "--ext-mode", "--http", "127.0.0.1:0"];
  const llmBackend = cfg.get<string>("llmBackend", "").trim();
  if (llmBackend) args.push("--llm-backend", llmBackend);
  const llmBase = cfg.get<string>("llmBaseUrl", "").trim();
  if (llmBase) args.push("--llm-base-url", llmBase);
  const llmModel = cfg.get<string>("llmModel", "").trim();
  if (llmModel) args.push("--llm-model", llmModel);
  args.push(cwd);

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
  const initialTheme = currentHostTheme();
  panel.webview.html = renderWebviewHtml(ready, initialTheme);

  // Live-update the SPA when the editor theme flips. We bridge via
  // the webview HTML, which relays into the iframe (the SPA cannot
  // be reached directly from the extension host because it sits one
  // postMessage hop deeper).
  const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
    void panel.webview.postMessage({
      type: "gc.theme",
      theme: currentHostTheme(),
    });
  });

  const session: Session = { proc, panel, ready, themeSub };
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

// Token map: VS Code semantic colour vars on the webview body ->
// SPA design tokens. Kept narrow (path A from the design audit) so
// drift stays manageable. Both names live in this file because the
// iframe can't reach across origins to read the webview's vars
// directly — the webview HTML extracts them and posts the snapshot.
//
// Keep in sync with HOST_TOKEN_ALLOWLIST in web/src/lib/settings.ts.
const TOKEN_MAP: Record<string, string> = {
  "--vscode-sideBar-background": "--surface-0",
  "--vscode-editor-background": "--surface-1",
  "--vscode-editorGroupHeader-tabsBackground": "--surface-1-alt",
  "--vscode-editorWidget-background": "--surface-2",
  "--vscode-list-hoverBackground": "--surface-3",
  "--vscode-input-background": "--surface-4",
  "--vscode-list-activeSelectionBackground": "--surface-5",
  "--vscode-panel-border": "--border-default",
  "--vscode-widget-border": "--border-strong",
  "--vscode-focusBorder": "--border-focus",
  "--vscode-foreground": "--text-default",
  "--vscode-descriptionForeground": "--text-muted",
  "--vscode-editor-foreground": "--text-strong",
  "--vscode-textLink-foreground": "--text-accent",
  "--vscode-button-background": "--accent",
};

function renderWebviewHtml(ready: ReadyInfo, theme: GcTheme): string {
  // portMapping rewrites localhost:<webviewPort> -> 127.0.0.1:<extensionHostPort>
  // for requests originating inside the webview. iframe must use
  // localhost so the mapping engages; using 127.0.0.1 directly bypasses
  // the rewrite and trips VS Code's outer CSP. Token is one-shot,
  // claimed by the SPA on first load. Theme is the coarse light/dark
  // bit; the fine-grained token snapshot is posted once the SPA
  // signals readiness.
  const src = `http://localhost:${ready.port}/?t=${ready.token}&theme=${theme}`;
  const tokenMapJson = JSON.stringify(TOKEN_MAP);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:${ready.port} http://127.0.0.1:${ready.port}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
    <title>git-chat</title>
    <style>
      html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background, #111); color: var(--vscode-foreground, #ddd); }
      iframe { border: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <iframe id="gc" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
    <script>
      var TOKEN_MAP = ${tokenMapJson};
      var iframe = document.getElementById("gc");

      // snapshotTokens reads the current --vscode-* values from body
      // styles and maps them to the SPA's semantic token namespace.
      // Empty values (theme didn't set that var) are dropped so the
      // SPA's index.html :root defaults shine through.
      function snapshotTokens() {
        var cs = getComputedStyle(document.body);
        var out = {};
        for (var src in TOKEN_MAP) {
          var v = cs.getPropertyValue(src).trim();
          if (v) out[TOKEN_MAP[src]] = v;
        }
        return out;
      }

      function sendTokens() {
        if (!iframe || !iframe.contentWindow) return;
        iframe.contentWindow.postMessage(
          { type: "gc.tokens", tokens: snapshotTokens() },
          "*"
        );
      }

      // Two trigger points:
      //   1. SPA boot — it posts gc.ready, we respond with the snapshot
      //   2. Extension host theme change — it forwards a gc.theme,
      //      which we relay AND follow up with a fresh token snapshot
      //      (the vscode-* vars on body have already been updated by
      //      VS Code by the time we receive the event).
      window.addEventListener("message", function (event) {
        var d = event.data;
        if (!d) return;
        if (d.type === "gc.ready" && event.source === iframe.contentWindow) {
          sendTokens();
          return;
        }
        if (d.type === "gc.theme") {
          iframe.contentWindow && iframe.contentWindow.postMessage(d, "*");
          sendTokens();
        }
      });
    </script>
  </body>
</html>`;
}

function killSession(s: Session): void {
  s.themeSub.dispose();
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
