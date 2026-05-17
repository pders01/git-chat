// Host-side event-map augmentations. The bulk of the gc:* event types
// live in @pders01/chatworks (lib/events.ts) — this file only carries
// events that reference host-owned types (routing, diff-pane payloads)
// and so can't live in the package. Importing the package's events
// module here chains both augmentations into a single import target.

import "@pders01/chatworks/events";
import type { ChangedFile } from "@pders01/chatworks/proto/repo";
import type { NavState } from "./routing.js";

export interface DiffFilesLoadedDetail {
  files: ChangedFile[];
  parentSha: string;
  toCommit: string;
}

declare global {
  interface HTMLElementEventMap {
    "gc:nav": CustomEvent<NavState>;
    "gc:diff-files-loaded": CustomEvent<DiffFilesLoadedDetail>;
  }
}
