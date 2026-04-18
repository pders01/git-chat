// SideFilesState models the 3-pane view's enrichment data — the full
// before/after file bodies fetched in parallel with the diff. Only
// consulted when the diff is `ready` AND threePane is toggled on;
// otherwise it sits at `idle`. Shared by commit-log and compare-view
// since both drive the same three-pane component.
export type SideFilesState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; leftText: string; rightText: string; language: string };
