import * as path from 'path';

export function tildify(location: string, home: string): string {
  return location.startsWith(home + path.sep) ? `~${location.slice(home.length)}` : location;
}

export function isUnder(p: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => p === dir || p.startsWith(dir + path.sep));
}
