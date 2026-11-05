// Sync, Pull and Push for the current branch, the Push menu and its states (design `05`, `11`, `44`), and the action a
// branch row offers on hover (Penpot "Sync badge": `Push 2`, `Pull 3`, `Publish`).
import { cannotForcePush, cannotPull, cannotPush } from '../src/core/sync-rules.js';
import type { Branch } from '../src/core/types.js';
import type { BusyView, StateView } from '../src/protocol.js';
import { icon } from './icons.js';
import { esc, listing, plural } from './text.js';

/** The Push menu: its options, the force-push confirmation, or the publish card. */
export interface PushPopover {
  ref: string;
  mode: 'menu' | 'confirm' | 'publish';
  force: boolean;
  tags: boolean;
  /** What a force-push removes from the remote; null until the host answers. */
  removes: { count: number; authors: string[] } | null;
}

const commits = (n: number): string => plural(n, 'commit', 'commits');
const attr = (why: string | null): string => (why ? ` disabled title="${esc(why)}"` : '');
const spinOr = (on: boolean, name: Parameters<typeof icon>[0]): string => icon(on ? 'spinner' : name, on ? 'gt-spin' : '');
const isNew = (b: Branch): boolean => b.sync === 'unpushed' || b.sync === 'gone';

/** The current branch's buttons. `compact` is the sidebar: Push and Pull share the row, Sync is an icon. */
export function syncButtonsHtml({ state, popover, compact }: { state: StateView; popover: PushPopover | null; compact: boolean }): string {
  const branch = state.branches.find((b) => b.current);
  if (!branch) return '';
  const busy = state.busy;
  const running = (action: BusyView['action']): boolean => busy?.action === action && (busy.ref === null || busy.ref === branch.ref);
  const blocked = state.operation ? `Finish or abort the ${state.operation.kind} first.` : busy ? 'Busy…' : null;
  const anyBusy = blocked !== null;

  const pullWhy = blocked ?? cannotPull(branch);
  const syncWhy = blocked ?? (isNew(branch) ? null : cannotPull(branch));
  const pull = `<button class="gt-btn" data-action="pull" data-ref="${esc(branch.ref)}"${attr(pullWhy)}>${spinOr(running('pull'), 'pull')}Pull${branch.behind ? ` ${branch.behind}` : ''}</button>`;
  const sync = compact
    ? `<button class="gt-icon-btn" data-action="sync" title="${esc(syncWhy ?? 'Sync: pull, then push')}" aria-label="Sync"${syncWhy ? ' disabled' : ''}>${spinOr(running('sync'), 'diverge')}</button>`
    : `<button class="gt-btn" data-action="sync"${attr(syncWhy)}>${spinOr(running('sync'), 'diverge')}Sync</button>`;

  let push: string;
  if (isNew(branch)) {
    push = `<button class="gt-btn gt-btn--primary" data-action="publishCard" data-ref="${esc(branch.ref)}"${attr(blocked)}>${spinOr(running('publish'), 'push')}Publish</button>`;
  } else {
    const pushWhy = blocked ?? cannotPush(branch);
    const label = `${spinOr(running('push'), 'push')}Push${branch.ahead ? ` ${branch.ahead}` : ''}`;
    const tone = branch.ahead && !pushWhy ? ' gt-btn--primary' : '';
    push = `<span class="gt-split">
      <button class="gt-btn${tone}" data-action="pushNow" data-ref="${esc(branch.ref)}"${attr(pushWhy)}>${label}</button>
      <button class="gt-btn${tone} gt-split__arrow" data-action="pushMenu" data-ref="${esc(branch.ref)}" title="Push options" aria-label="Push options" aria-haspopup="dialog"${anyBusy ? ' disabled' : ''}>${icon('chevDown', 'gt-i--sm')}</button>
    </span>`;
  }
  const open = popover && popover.ref === branch.ref ? popoverHtml(popover, branch, state.defaultBranch, compact) : '';
  return compact
    ? `<div class="gt-side-actions"><span class="gt-menu-anchor gt-side-actions__push">${push}${open}</span>${pull}${sync}</div>`
    : `${sync}${pull}<span class="gt-menu-anchor">${push}${open}</span>`;
}

function popoverHtml(p: PushPopover, branch: Branch, defaultBranch: string | null, compact: boolean): string {
  const side = compact ? ' gt-popover--left' : '';
  const upstream = esc(branch.upstream ?? '');
  if (p.mode === 'publish') {
    const remote = esc((branch.upstream ?? 'origin/').split('/')[0] || 'origin');
    return `<div class="gt-popover${side}" role="dialog" aria-label="Publish" data-stop>
  <strong>Publish ${branch.ahead ? commits(branch.ahead) : esc(branch.name)} to ${remote}</strong>
  <div class="gt-kv"><span class="gt-muted">From</span><span><span class="gt-chip">${icon('laptop', 'gt-i--sm')}local</span> ${esc(branch.name)}</span>
  <span class="gt-muted">To</span><span>creates ${remote}/${esc(branch.name)}</span></div>
  <div class="gt-popover__foot"><button class="gt-btn gt-btn--primary" data-action="publish" data-ref="${esc(branch.ref)}">${icon('push')}Publish</button><button class="gt-btn" data-action="closePopover">Cancel</button></div>
</div>`;
  }
  if (p.mode === 'confirm') {
    const r = p.removes;
    const what = !r
      ? 'Checking what is on origin…'
      : r.count
        ? `Removes ${r.authors.length === 1 ? `${esc(r.authors[0] ?? '')}'s` : ''} ${commits(r.count)}${r.authors.length > 1 ? ` by ${esc(listing(r.authors))}` : ''} from ${upstream} for everyone.`
        : `Rewrites ${upstream} to match your branch, for everyone.`;
    return `<div class="gt-popover${side}" role="alertdialog" aria-label="Force-push" data-stop>
  <div class="gt-banner gt-banner--danger"><span class="gt-banner__icon">${icon('warn')}</span><span>${what}</span></div>
  <div class="gt-popover__foot"><button class="gt-btn gt-btn--danger" data-action="forcePush" data-ref="${esc(branch.ref)}"${r ? '' : ' disabled'}>Force-push</button><button class="gt-btn" data-action="closePopover">Cancel</button></div>
</div>`;
  }
  const forceWhy = cannotForcePush(branch, defaultBranch);
  const pushWhy = cannotPush(branch);
  const label = `Push${branch.ahead ? ` ${branch.ahead}` : ''}`;
  const go = p.force
    ? `<button class="gt-btn gt-btn--danger" data-action="confirmForce" data-ref="${esc(branch.ref)}">Force-push…</button>`
    : `<button class="gt-btn gt-btn--primary" data-action="pushChosen" data-ref="${esc(branch.ref)}"${attr(pushWhy)}>${icon('push')}${label}</button>`;
  return `<div class="gt-popover${side}" role="dialog" aria-label="Push options" data-stop>
  <div class="gt-popover__box">
    <button class="gt-option${p.force ? '' : ' is-on'}" data-action="pushOption" data-force="false"${pushWhy ? ` title="${esc(pushWhy)}"` : ''}>
      <span class="gt-option__label">${p.force ? '<span class="gt-option__tick"></span>' : icon('check', 'gt-i--sm')}${label}</span>
    </button>
    <button class="gt-option gt-option--danger${p.force ? ' is-on' : ''}" data-action="pushOption" data-force="true"${forceWhy ? ' disabled' : ''}>
      <span class="gt-option__label">${p.force ? icon('check', 'gt-i--sm') : '<span class="gt-option__tick"></span>'}Force-push with lease</span>
      <span class="gt-option__note">${esc(forceWhy ?? 'Stops if someone pushed since your last fetch.')}</span>
    </button>
    <div class="gt-menu__sep"></div>
    <label class="gt-check gt-option"><input type="checkbox" data-action="toggleTags"${p.tags ? ' checked' : ''}><span>Push tags<span class="gt-check__note">Also sends tags that origin doesn't have yet.</span></span></label>
  </div>
  <div class="gt-popover__foot">${go}<button class="gt-btn" data-action="closePopover">Cancel</button></div>
</div>`;
}

/** The action a row offers on hover, beside its marks. */
export function rowActionHtml(branch: Branch, busy: BusyView | null): string {
  const ref = esc(branch.ref);
  const spinning = busy?.ref === branch.ref;
  const disabled = busy ? ' disabled' : '';
  const button = (action: string, tone: string, glyph: Parameters<typeof icon>[0], label: string): string =>
    `<button class="gt-sync gt-sync--${tone} gt-branch__act" data-action="${action}" data-ref="${ref}"${disabled}>${icon(spinning ? 'spinner' : glyph, spinning ? 'gt-i--sm gt-spin' : 'gt-i--sm')}${label}</button>`;
  if (!branch.local) return '';
  if (branch.sync === 'gone' && !branch.current) return button('deleteBranchAsk', 'gone', 'trash', 'Delete local');
  if (branch.sync === 'unpushed' && branch.ahead) return button('publish', 'ahead', 'push', 'Publish');
  if (!cannotPush(branch)) return button('push', 'ahead', 'push', `Push ${branch.ahead}`);
  if (!cannotPull(branch) && branch.behind) return button('pull', 'behind', 'pull', `Pull ${branch.behind}`);
  return '';
}
