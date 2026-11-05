// A conflicted file's markers, read as the conflict screens show them (design `23`–`29`), and the file written back
// from the choices made. Pure.
//
// git writes `<<<<<<<` for stage 2 and `>>>>>>>` for stage 3. In a merge stage 2 is your branch; in a rebase it is the
// branch you rebase onto, and stage 3 is your commit being replayed. The screens always put your local branch on the
// left, so `localIsFirst` says which marker side that is: true for a merge, false for a rebase. Labels are never taken
// from "ours" and "theirs".

export interface ConflictRegion {
  kind: 'conflict';
  /** 1-based line of the `<<<<<<<` marker in the conflicted file. */
  line: number;
  local: string[];
  remote: string[];
}

export interface CommonLines {
  kind: 'common';
  lines: string[];
}

export type ConflictPart = CommonLines | ConflictRegion;

/** What to keep for one conflict: one side, both (local first), or text written by hand. */
export type Resolution = { take: 'local' } | { take: 'remote' } | { take: 'both' } | { take: 'edit'; text: string };

/** The file split into common lines and conflicts; the diff3 base section, when present, is dropped. */
export function parseConflicts(text: string, { localIsFirst }: { localIsFirst: boolean }): ConflictPart[] {
  const parts: ConflictPart[] = [];
  let common: string[] = [];
  let region: { line: number; first: string[]; second: string[]; in: 'first' | 'base' | 'second' } | null = null;
  text.split('\n').forEach((line, i) => {
    if (!region && line.startsWith('<<<<<<<')) {
      if (common.length) parts.push({ kind: 'common', lines: common });
      common = [];
      region = { line: i + 1, first: [], second: [], in: 'first' };
      return;
    }
    if (region) {
      if (line.startsWith('|||||||') && region.in === 'first') region.in = 'base';
      else if (line.startsWith('=======') && region.in !== 'second') region.in = 'second';
      else if (line.startsWith('>>>>>>>') && region.in === 'second') {
        const { first, second } = region;
        parts.push({ kind: 'conflict', line: region.line, local: localIsFirst ? first : second, remote: localIsFirst ? second : first });
        region = null;
      } else if (region.in === 'first') region.first.push(line);
      else if (region.in === 'second') region.second.push(line);
      return;
    }
    common.push(line);
  });
  if (common.length) parts.push({ kind: 'common', lines: common });
  return parts;
}

export const conflictCount = (parts: readonly ConflictPart[]): number => parts.filter((p) => p.kind === 'conflict').length;

/** The lines a resolution keeps. */
export function resolvedLines(region: ConflictRegion, resolution: Resolution): string[] {
  switch (resolution.take) {
    case 'local':
      return region.local;
    case 'remote':
      return region.remote;
    case 'both':
      return [...region.local, ...region.remote];
    case 'edit':
      return resolution.text.split('\n');
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

/** The file with every conflict replaced by its resolution, in order. Throws when one is missing. */
export function applyResolutions(parts: readonly ConflictPart[], resolutions: readonly Resolution[]): string {
  let n = 0;
  const lines = parts.flatMap((p) => {
    if (p.kind === 'common') return p.lines;
    const resolution = resolutions[n++];
    if (!resolution) throw new Error(`Conflict ${n} has no choice yet.`);
    return resolvedLines(p, resolution);
  });
  return lines.join('\n');
}
