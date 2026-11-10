import { promises as fs } from 'fs';
import * as path from 'path';

/** How many directories from `goToProject.directories` get a command of their own (package.json has one per slot). */
export const DIRECTORY_SLOTS = 9;

const WORKSPACE_EXT = '.code-workspace';

const byName = (a: string, b: string): number => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' });

/** The folders and `.code-workspace` files right inside `dir`, by name; hidden ones are left out. Throws when `dir` cannot be read. */
export async function projectsIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry): Promise<string | null> => {
      if (entry.name.startsWith('.')) return null;
      const full = path.join(dir, entry.name);
      // A symlink counts as what it points to.
      const stat = entry.isSymbolicLink() ? await fs.stat(full).catch(() => null) : entry;
      if (!stat) return null;
      if (stat.isDirectory()) return full;
      return stat.isFile() && entry.name.endsWith(WORKSPACE_EXT) ? full : null;
    })
  );
  return found.filter((p): p is string => p !== null).sort(byName);
}

/** `goToProject.directories` as written: the non-empty strings, in order. */
export function parseDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}
