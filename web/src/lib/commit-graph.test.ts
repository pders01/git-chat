import { describe, expect, test } from "bun:test";
import { layoutGraph, type GraphCommitInput } from "./commit-graph.js";

function linear(shas: readonly string[]): GraphCommitInput[] {
  // Build a linear history: shas[0] is newest, each commit has the
  // next one as its sole parent. Final commit is a root (no parents).
  return shas.map((sha, i) => ({
    sha,
    parentShas: i < shas.length - 1 ? [shas[i + 1]] : [],
  }));
}

describe("layoutGraph", () => {
  test("empty input returns empty layout", () => {
    const { nodes, maxLane } = layoutGraph([]);
    expect(nodes).toEqual([]);
    expect(maxLane).toBe(0);
  });

  test("single commit occupies lane 0", () => {
    const { nodes, maxLane } = layoutGraph([{ sha: "a" }]);
    expect(nodes).toEqual([{ row: 0, lane: 0, parents: [] }]);
    expect(maxLane).toBe(0);
  });

  test("linear history stays in a single lane", () => {
    const { nodes, maxLane } = layoutGraph(linear(["a", "b", "c", "d"]));
    expect(maxLane).toBe(0);
    for (const n of nodes) {
      expect(n.lane).toBe(0);
    }
  });

  test("merge commit places trunk parent in lane 0 and branch parent in a new lane", () => {
    // a is a merge with parents [b (trunk), c (side branch)].
    // b has its own ancestry (b→d) so the side branch doesn't reconnect
    // immediately. c (side branch tip) should sit in the lane the merge
    // reserved, not lane 0.
    const { nodes, maxLane } = layoutGraph([
      { sha: "a", parentShas: ["b", "c"] },
      { sha: "b", parentShas: ["d"] },
      { sha: "d" }, // root on the trunk side
      { sha: "c" }, // side branch tip — should land in the reserved lane
    ]);
    expect(nodes[0]).toEqual({ row: 0, lane: 0, parents: ["b", "c"] });
    expect(nodes[1].lane).toBe(0); // b stays in trunk
    expect(nodes[2].lane).toBe(0); // d continues the trunk
    expect(nodes[3].lane).toBeGreaterThan(0); // c finally sits in its reserved lane
    expect(maxLane).toBeGreaterThan(0);
  });

  test("orphan commit after trunk finishes reuses a freed lane", () => {
    // a→b→(root); then an unrelated orphan commit d. After a and b
    // finish, lane 0 is freed. The orphan d should reuse lane 0.
    const { nodes } = layoutGraph([
      { sha: "a", parentShas: ["b"] },
      { sha: "b" }, // root
      { sha: "d" }, // orphan
    ]);
    expect(nodes[2].lane).toBe(0);
  });

  test("parent SHAs are preserved on nodes so the renderer can draw lines", () => {
    const { nodes } = layoutGraph([
      { sha: "a", parentShas: ["b", "c"] },
      { sha: "b" },
      { sha: "c" },
    ]);
    expect(nodes[0].parents).toEqual(["b", "c"]);
    expect(nodes[1].parents).toEqual([]);
  });

  test("three-way merge opens two extra lanes", () => {
    // a's parents are [b, c, d]. First parent b continues in lane 0;
    // c and d should each get their own extra lane.
    const { maxLane } = layoutGraph([
      { sha: "a", parentShas: ["b", "c", "d"] },
      { sha: "b" },
      { sha: "c" },
      { sha: "d" },
    ]);
    expect(maxLane).toBe(2);
  });

  test("same parent referenced twice doesn't double-allocate lanes", () => {
    // Rare but possible (octopus merge variant / data oddity).
    // Second reference should find the existing lane and not grow the graph.
    const { maxLane } = layoutGraph([{ sha: "a", parentShas: ["b", "b"] }, { sha: "b" }]);
    expect(maxLane).toBe(0);
  });
});
