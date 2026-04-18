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
//   ?view=city|changes browse: view mode (absent = default file view)
//   ?blame=1          browse: blame toggle
//   ?compare=base..head  browse: compare mode
//   ?file=path        log: selected file in commit diff
//   ?split=1          log: split diff view
//   ?filter=path      log: file history filter
//   ?view=calendar    log: calendar overview (absent = commits view)

export type Tab = "chat" | "browse" | "log" | "kb";

const TABS = new Set<Tab>(["chat", "browse", "log", "kb"]);

export type BrowseView = "file" | "city" | "changes";
export type LogView = "commits" | "calendar";

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
  browseView?: BrowseView; // "file" (default), "city", or "changes"
  // log
  commitSha?: string;
  logFile?: string;
  splitView?: boolean;
  filterPath?: string;
  logView?: LogView;
  // kb
  cardId?: string;
}

export type NavState = Partial<ParsedRoute>;

export function parseRoute(url: URL): ParsedRoute {
  const raw = url.hash.replace(/^#\/?/, "");
  // Split path from query params (both live inside the hash fragment).
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const params = qIdx >= 0 ? new URLSearchParams(raw.slice(qIdx + 1)) : new URLSearchParams();

  const [repoId, tab, ...rest] = pathPart.split("/");
  const validTab = TABS.has(tab as Tab) ? (tab as Tab) : "chat";
  const cleanSub = rest.length > 0 ? decodeURIComponent(rest.join("/")) || undefined : undefined;

  const route: ParsedRoute = {
    repoId: repoId || "",
    tab: validTab,
  };

  switch (validTab) {
    case "chat":
      if (cleanSub) route.sessionId = cleanSub;
      break;
    case "browse": {
      if (cleanSub) route.filePath = cleanSub;
      if (params.get("blame") === "1") route.blame = true;
      if (params.has("compare")) {
        const parts = params.get("compare")!.split("..");
        if (parts.length === 2) {
          route.compareBase = parts[0];
          route.compareHead = parts[1];
        }
      }
      const view = params.get("view");
      if (view === "city" || view === "changes") route.browseView = view;
      break;
    }
    case "log":
      if (cleanSub) route.commitSha = cleanSub;
      if (params.has("file")) route.logFile = params.get("file")!;
      if (params.get("split") === "1") route.splitView = true;
      if (params.has("filter")) route.filterPath = params.get("filter")!;
      if (params.get("view") === "calendar") route.logView = "calendar";
      break;
    case "kb":
      if (cleanSub) route.cardId = cleanSub;
      break;
  }

  return normalizeBrowseState(route);
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
    if (route.browseView && route.browseView !== "file") {
      params.set("view", route.browseView);
    }
  }
  if (route.tab === "log") {
    if (route.logFile) params.set("file", route.logFile);
    if (route.splitView) params.set("split", "1");
    if (route.filterPath) params.set("filter", route.filterPath);
    if (route.logView && route.logView !== "commits") params.set("view", route.logView);
  }

  const qs = params.toString();
  return qs ? `${hash}?${qs}` : hash;
}

export function routesEqual(a: ParsedRoute, b: ParsedRoute): boolean {
  return buildRoute(a) === buildRoute(b);
}

// Enforce mutual exclusion between browse view modes.
// compare (compareBase+compareHead) and browseView (city/changes) cannot
// coexist. compare wins if both are set (it's more specific).
export function normalizeBrowseState(route: ParsedRoute): ParsedRoute {
  if (route.tab !== "browse") return route;
  const hasCompare = !!(route.compareBase && route.compareHead);
  const hasView = !!(route.browseView && route.browseView !== "file");
  if (hasCompare && hasView) {
    // compare wins — clear browseView
    return { ...route, browseView: undefined };
  }
  if (hasView) {
    // browseView wins — clear compare
    return { ...route, compareBase: undefined, compareHead: undefined };
  }
  return route;
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
      clean.browseView = route.browseView;
      break;
    case "log":
      clean.commitSha = route.commitSha;
      clean.logFile = route.logFile;
      clean.splitView = route.splitView;
      clean.filterPath = route.filterPath;
      clean.logView = route.logView;
      break;
    case "kb":
      clean.cardId = route.cardId;
      break;
  }
  return clean;
}
