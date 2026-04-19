// Lane-assignment algorithm for the commit-log graph view. Pure
// function: no DOM, no Lit. Consumers render SVG lines/dots on top of
// the output.
//
// The algorithm is a simplified first-parent-follows-lane layout, the
// same shape most git-log UIs (tig, lazygit, gitk) converged on:
//
//   - Each commit is placed in a row.
//   - A commit occupies the leftmost free lane, or — if it has already
//     been "expected" by a child's first parent — the lane that child
//     reserved for it.
//   - The commit's first parent continues in the same lane (trunk
//     behaviour); additional parents (merge commits) open new lanes.
//   - When no child is waiting on a lane, the lane is freed for the
//     next commit to reuse — this keeps the graph narrow.

export interface GraphCommitInput {
  /** Commit's own SHA. Used as the lane key. */
  sha: string;
  /** Parent SHAs in git order (first parent is the "trunk"). */
  parentShas?: readonly string[];
}

export interface GraphNode {
  /** 0-indexed row in the rendered list. */
  row: number;
  /** 0-indexed lane the commit's dot sits in. */
  lane: number;
  /** Parents — passed through so the renderer can draw lines to them. */
  parents: readonly string[];
}

export interface GraphLayout {
  nodes: GraphNode[];
  /** Maximum lane index used, i.e. `maxLane + 1` lanes in total. */
  maxLane: number;
}

/**
 * Compute lane assignments for a list of commits (newest first, which
 * matches both git log's default and this app's sort order).
 *
 * Given a commit:
 *   - If one of its children already reserved a lane for it (by naming
 *     its SHA as a parent), sit in that lane.
 *   - Otherwise take the leftmost free lane (or open a new one).
 *   - Reserve its first parent for that lane (straight-line continues).
 *   - For merge commits (2+ parents), reserve extra parents in free or
 *     new lanes so the merge line has somewhere to go.
 */
export function layoutGraph(commits: readonly GraphCommitInput[]): GraphLayout {
  // lanes[i] = SHA currently "expected" in lane i; "" means the lane is
  // free. The slice grows as the graph fans out.
  const lanes: string[] = [];
  const nodes: GraphNode[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = lanes.indexOf("");
      if (lane === -1) {
        lane = lanes.length;
        lanes.push("");
      }
    }

    const parents = c.parentShas ?? [];
    lanes[lane] = parents.length > 0 ? parents[0] : "";

    for (let p = 1; p < parents.length; p++) {
      const existing = lanes.indexOf(parents[p]);
      if (existing === -1) {
        const free = lanes.indexOf("");
        if (free !== -1) lanes[free] = parents[p];
        else lanes.push(parents[p]);
      }
    }

    nodes.push({ row: i, lane, parents });
  }

  const maxLane = nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  return { nodes, maxLane };
}
