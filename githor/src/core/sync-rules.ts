// When push, pull and force-push are offered, and why not. Pure: the webview imports this file to explain a button
// that is turned off.
import type { Branch } from './types';

/** Why `branch` cannot be pushed as it is, or null when it can. */
export function cannotPush(branch: Branch): string | null {
  if (!branch.local) return 'This branch is only on the remote.';
  if (!branch.upstream || branch.sync === 'gone') return 'This branch is not on a remote yet: publish it.';
  if (branch.sync === 'diverged') return 'Local and remote both moved: compare them first, or force-push.';
  if (!branch.ahead) return 'Nothing to push.';
  return null;
}

/** Why `branch` cannot be pulled, or null when it can. */
export function cannotPull(branch: Branch): string | null {
  if (!branch.local) return 'This branch is only on the remote: switch to it.';
  if (!branch.upstream || branch.sync === 'unpushed') return 'This branch is not on a remote yet.';
  if (branch.sync === 'gone') return 'Its remote branch was deleted.';
  if (branch.sync === 'diverged') return 'Local and remote both moved: compare them first.';
  return null;
}

/** Why force-push is turned off for `branch`, or null when it is offered. */
export function cannotForcePush(branch: Branch, defaultBranch: string | null): string | null {
  if (!branch.upstream || branch.sync === 'unpushed' || branch.sync === 'gone') return 'This branch is not on a remote yet.';
  if (branch.name === defaultBranch) return `Turned off on ${branch.name}: it rewrites shared history.`;
  return null;
}
