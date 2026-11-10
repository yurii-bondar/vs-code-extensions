import * as path from 'path';

export function tildify(location: string, home: string): string {
  return location.startsWith(home + path.sep) ? `~${location.slice(home.length)}` : location;
}

/** `~` and `~/…` to the home folder; anything else is resolved as is. */
export function untildify(location: string, home: string): string {
  if (location === '~') return home;
  if (location.startsWith('~/') || location.startsWith(`~${path.sep}`)) return path.join(home, location.slice(2));
  return path.resolve(location);
}

export function isUnder(p: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => p === dir || p.startsWith(dir + path.sep));
}
