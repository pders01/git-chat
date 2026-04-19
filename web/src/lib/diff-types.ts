// SideFilesState models the 3-pane view's enrichment data — the full
// before/after file bodies fetched in parallel with the diff. Only
// consulted when the diff is `ready` AND threePane is toggled on;
// otherwise it sits at `idle`. Shared by commit-log and compare-view
// since both drive the same three-pane component.
export type SideFilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; leftText: string; rightText: string; language: string };

// One-character git status badge used by the file-list columns in
// commit-log, compare-view, and changes-view. Matches common git UIs
// (git status --short, GitHub file headers): A/D/R/C/M for the usual
// transitions, M as the fallback so unknown statuses still render
// something meaningful.
export function statusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "M";
  }
}

// Trailing segment of a slash-separated path. Used by the file-list
// columns to show just `foo.ts` instead of the full `web/src/.../foo.ts`;
// the directory chain is usually visible via the surrounding tree view.
export function fileName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
