// URL routing: parse and build deep-linkable URLs.
//
// URL scheme: #/{repoId}/{tab}[/{subPath}]?{queryParams}
//
// Tab-specific subpaths:
//   chat:   /{sessionId}
//   browse: /{filePath}   (encoded, may contain slashes)
//   log:    /{commitSha}
//   kb:     /{cardId}
//
// Query params (tab-specific view state):
//   ?blame=1          browse: blame toggle
//   ?compare=base..head  browse: compare mode
//   ?file=path        log: selected file in commit diff
//   ?split=1          log: split diff view
//   ?filter=path      log: file history filter

export type Tab = "chat" | "browse" | "log" | "kb";

const TABS = new Set<Tab>(["chat", "browse", "log", "kb"]);

export interface ParsedRoute {
  repoId: string;
  tab: Tab;
  // chat
  sessionId?: string;
  // browse
  filePath?: string;
  blame?: boolean;
  compareBase?: string;
  compareHead?: string;
  // log
  commitSha?: string;
  logFile?: string;
  splitView?: boolean;
  filterPath?: string;
  // kb
  cardId?: string;
}

export type NavState = Partial<ParsedRoute>;

export function parseRoute(url: URL): ParsedRoute {
  const hash = url.hash.replace(/^#\/?/, "");
  const [repoId, tab, ...rest] = hash.split("/");
  const validTab = TABS.has(tab as Tab) ? (tab as Tab) : "chat";
  const subPath = rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined;

  // Query params from the hash portion: everything after ?
  const qIdx = url.hash.indexOf("?");
  const params = qIdx >= 0 ? new URLSearchParams(url.hash.slice(qIdx + 1)) : new URLSearchParams();

  // Re-parse subPath without query string
  const cleanSub = subPath?.split("?")[0] || undefined;

  const route: ParsedRoute = {
    repoId: repoId || "",
    tab: validTab,
  };

  switch (validTab) {
    case "chat":
      if (cleanSub) route.sessionId = cleanSub;
      break;
    case "browse":
      if (cleanSub) route.filePath = cleanSub;
      if (params.get("blame") === "1") route.blame = true;
      if (params.has("compare")) {
        const parts = params.get("compare")!.split("..");
        if (parts.length === 2) {
          route.compareBase = parts[0];
          route.compareHead = parts[1];
        }
      }
      break;
    case "log":
      if (cleanSub) route.commitSha = cleanSub;
      if (params.has("file")) route.logFile = params.get("file")!;
      if (params.get("split") === "1") route.splitView = true;
      if (params.has("filter")) route.filterPath = params.get("filter")!;
      break;
    case "kb":
      if (cleanSub) route.cardId = cleanSub;
      break;
  }

  return route;
}

export function buildRoute(route: ParsedRoute): string {
  let hash = `#/${route.repoId}/${route.tab}`;

  switch (route.tab) {
    case "chat":
      if (route.sessionId) hash += `/${route.sessionId}`;
      break;
    case "browse":
      if (route.filePath) hash += `/${encodeURIComponent(route.filePath)}`;
      break;
    case "log":
      if (route.commitSha) hash += `/${route.commitSha}`;
      break;
    case "kb":
      if (route.cardId) hash += `/${route.cardId}`;
      break;
  }

  const params = new URLSearchParams();
  if (route.tab === "browse") {
    if (route.blame) params.set("blame", "1");
    if (route.compareBase && route.compareHead) {
      params.set("compare", `${route.compareBase}..${route.compareHead}`);
    }
  }
  if (route.tab === "log") {
    if (route.logFile) params.set("file", route.logFile);
    if (route.splitView) params.set("split", "1");
    if (route.filterPath) params.set("filter", route.filterPath);
  }

  const qs = params.toString();
  return qs ? `${hash}?${qs}` : hash;
}

export function routesEqual(a: ParsedRoute, b: ParsedRoute): boolean {
  return buildRoute(a) === buildRoute(b);
}

// Clear sub-state fields that belong to tabs other than the target tab.
export function clearStaleState(route: ParsedRoute): ParsedRoute {
  const clean: ParsedRoute = { repoId: route.repoId, tab: route.tab };
  switch (route.tab) {
    case "chat":
      clean.sessionId = route.sessionId;
      break;
    case "browse":
      clean.filePath = route.filePath;
      clean.blame = route.blame;
      clean.compareBase = route.compareBase;
      clean.compareHead = route.compareHead;
      break;
    case "log":
      clean.commitSha = route.commitSha;
      clean.logFile = route.logFile;
      clean.splitView = route.splitView;
      clean.filterPath = route.filterPath;
      break;
    case "kb":
      clean.cardId = route.cardId;
      break;
  }
  return clean;
}
