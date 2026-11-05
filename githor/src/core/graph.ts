// The commit graph's lanes (design `01`: Penpot "Commit row", `gt-graph`). Pure: the webview imports this file and
// draws each row from what `layoutGraph` returns.

export interface GraphCommit {
  sha: string;
  parents: readonly string[];
}

/** A line inside one row's half: from lane `from` at that half's top to lane `to` at its bottom. */
export interface GraphLine {
  from: number;
  to: number;
  /** Colour index: the lane's, kept as long as the line continues. */
  color: number;
}

export interface GraphRow {
  /** The lane the commit's node sits in. */
  lane: number;
  color: number;
  /** Lines in the upper half, from the row's top edge to its middle. */
  up: GraphLine[];
  /** Lines in the lower half, from the middle to the bottom edge. */
  down: GraphLine[];
}

/**
 * Lays commits, newest first and in topological order, out in lanes. Each lane waits for one commit (the parent the
 * lane leads to). A commit takes the lane that waits for it, or the first free one; its first parent continues that
 * lane, and every other parent gets a lane of its own, unless a lane already waits for it. Lanes never shift: a freed
 * lane is reused by the next commit that needs one.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const freeLane = (avoid: number): number => {
    const i = lanes.findIndex((l, j) => l === null && j !== avoid);
    return i === -1 ? lanes.length : i;
  };

  return commits.map((commit) => {
    // what reaches this row from above: a tip, which no lane waits for, gets no line from the top
    const before = [...lanes];
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = freeLane(-1);
      colors[lane] = nextColor++;
    }
    const color = colors[lane] ?? 0;

    const up: GraphLine[] = [];
    before.forEach((sha, j) => {
      if (sha === null) return;
      up.push({ from: j, to: sha === commit.sha ? lane : j, color: colors[j] ?? 0 });
    });
    // every lane that waited for this commit ends at its node
    before.forEach((sha, j) => {
      if (sha === commit.sha) lanes[j] = null;
    });
    lanes[lane] = null;

    const down: GraphLine[] = [];
    commit.parents.forEach((parent, i) => {
      const waiting = lanes.indexOf(parent);
      if (i === 0 && waiting > lane) {
        // the first parent waits further right: it moves to this lane, so the main line stays to the left
        lanes[waiting] = null;
        lanes[lane] = parent;
        down.push({ from: lane, to: lane, color });
        return;
      }
      if (waiting !== -1) {
        down.push({ from: lane, to: waiting, color: colors[waiting] ?? 0 });
        return;
      }
      const target = i === 0 && lanes[lane] === null ? lane : freeLane(lane);
      lanes[target] = parent;
      if (target !== lane) colors[target] = nextColor++;
      down.push({ from: lane, to: target, color: target === lane ? color : (colors[target] ?? 0) });
    });
    // lanes passing by continue down, into the lane their commit moved to when it moved
    before.forEach((sha, j) => {
      if (sha === null || sha === commit.sha) return;
      const to = lanes.indexOf(sha);
      if (to !== -1) down.push({ from: j, to, color: colors[j] ?? 0 });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, color, up, down };
  });
}

/** The commits reachable from `tip` among those loaded: what highlighting a branch keeps bright. */
export function reachable(commits: readonly GraphCommit[], tip: string): Set<string> {
  const parents = new Map(commits.map((c) => [c.sha, c.parents]));
  const seen = new Set<string>();
  const todo = [tip];
  while (todo.length) {
    const sha = todo.pop() as string;
    if (seen.has(sha) || !parents.has(sha)) continue;
    seen.add(sha);
    todo.push(...(parents.get(sha) ?? []));
  }
  return seen;
}

/** How many lanes the graph needs at most: the width of its column. */
export const graphWidth = (rows: readonly GraphRow[]): number => rows.reduce((w, r) => Math.max(w, r.lane + 1, ...r.up.map((l) => Math.max(l.from, l.to) + 1), ...r.down.map((l) => Math.max(l.from, l.to) + 1)), 1);
