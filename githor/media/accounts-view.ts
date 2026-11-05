// Accounts (design `45`–`48`): the Manage accounts page, the Add account dialog, the dialogs for a refused or expired
// account and for a commit as an account the rules would not pick, and the "no account yet" notice on the Commit tab.
// The page never sees a token: signing in happens in VS Code's own boxes, started by the host.
import type { AccountRef, AccountView, AccountsView, HostMessage, NewAccount } from '../src/protocol.js';
import type { Provider } from '../src/core/types.js';
import { icon } from './icons.js';
import { esc } from './text.js';

type Problem = Extract<HostMessage, { type: 'accountProblem' }>;

export type AccountDialog =
  | { kind: 'add'; input: NewAccount; busy: boolean }
  | { kind: 'edit'; id: string; label: string; name: string; email: string; busy: boolean }
  | { kind: 'remove'; id: string; label: string; busy: boolean }
  | { kind: 'problem'; problem: Problem; busy: boolean }
  | { kind: 'confirm'; active: AccountRef; suggested: AccountRef; rule: string; busy: boolean };

const PROVIDERS: readonly { id: Provider; label: string; host: string }[] = [
  { id: 'github', label: 'GitHub', host: 'github.com' },
  { id: 'gitlab', label: 'GitLab', host: 'gitlab.com' },
  { id: 'other', label: 'Other git host', host: '' },
];

export function newAccount(defaults: AccountsView['defaults'] | undefined): AccountDialog {
  return { kind: 'add', input: { provider: 'github', host: 'github.com', method: 'browser', label: '', name: defaults?.name ?? '', email: defaults?.email ?? '' }, busy: false };
}

/** A new provider brings its host and a sign-in it has: only GitHub signs in through the browser. */
export function withProvider(input: NewAccount, provider: Provider): NewAccount {
  const host = PROVIDERS.find((p) => p.id === provider)?.host ?? '';
  return { ...input, provider, host, method: provider === 'github' ? 'browser' : input.method === 'browser' ? 'token' : input.method };
}

const how = (a: AccountView): string => {
  switch (a.auth.kind) {
    case 'browser':
      return 'Signed in with browser';
    case 'token':
      return 'Access token';
    case 'ssh':
      return `SSH key, ${a.auth.keyPath.split('/').pop() ?? a.auth.keyPath}`;
    default: {
      const unreachable: never = a.auth;
      return unreachable;
    }
  }
};

function accountRowHtml(a: AccountView): string {
  const badge = a.expired ? '<span class="gt-account__badge gt-account__badge--warn">sign-in expired</span>' : a.usedHere ? '<span class="gt-account__badge">used here</span>' : '';
  const main = a.expired
    ? `<button class="gt-btn gt-btn--primary" data-action="signInAgain" data-id="${esc(a.id)}">Sign in again</button>`
    : `<button class="gt-btn gt-btn--ghost" data-action="editAccount" data-id="${esc(a.id)}">Edit</button>`;
  return `<div class="gt-account">
  <span class="gt-account__icon">${icon(a.auth.kind === 'ssh' ? 'key' : 'account')}</span>
  <span class="gt-account__text">
    <span class="gt-account__name"><strong>${esc(a.label)}</strong>${badge}</span>
    <span class="gt-muted">${esc(a.email)}  ·  ${esc(a.host)}/${esc(a.login)}</span>
    <span class="gt-muted">${how(a)}</span>
  </span>
  <span class="gt-pane__row">${main}<button class="gt-btn gt-btn--ghost" data-action="removeAccountAsk" data-id="${esc(a.id)}">Remove</button></span>
</div>`;
}

/** The Manage accounts page (design `46`): this repository, the accounts, the rules by remote. */
export function accountsPageHtml(view: AccountsView | null): string {
  const head = `<div class="gt-pane__head gt-accounts__head">
  <button class="gt-btn gt-btn--ghost" data-action="closeAccounts">${icon('back', 'gt-i--sm')}Back to log</button>
  <h2 class="gt-accounts__title">Accounts</h2>
  <span class="gt-spacer"></span>
  <button class="gt-btn gt-btn--primary" data-action="addAccountOpen">${icon('add', 'gt-i--sm')}Add account…</button>
</div>`;
  if (!view) return `${head}<div class="gt-empty"><span class="gt-dialog__loading">${icon('spinner', 'gt-spin')}Reading the accounts…</span></div>`;
  const byId = new Map(view.accounts.map((a) => [a.id, a]));
  const repo = view.repo;
  const picked = repo?.picked ? byId.get(repo.picked) : undefined;
  const options = [`<option value=""${repo?.choice ? '' : ' selected'}>By the rules</option>`, ...view.accounts.map((a) => `<option value="${esc(a.id)}"${repo?.choice === a.id ? ' selected' : ''}>${esc(a.label)}</option>`)].join('');
  const repoHtml = repo
    ? `<section class="gt-accounts__section">
  <h3 class="gt-section-title">THIS REPOSITORY</h3>
  <div class="gt-account">
    <span class="gt-account__icon">${icon('folder')}</span>
    <span class="gt-account__text">
      <strong>${esc(repo.name)}</strong>
      <span class="gt-muted gt-mono">${repo.remote ? `${esc(repo.remoteName ?? '')}  ${esc(repo.remote)}` : 'No remote'}</span>
      <span>${picked ? `${esc(picked.label)}${repo.why ? ` (${esc(repo.why)})` : ''}` : 'No account: commits use git’s own name and email'}</span>
    </span>
    ${view.accounts.length ? `<label class="gt-select" title="The account for this repository"><select data-action="pickRepoAccount" aria-label="Account for this repository">${options}</select>${icon('pull', 'gt-i--sm')}</label>` : ''}
  </div>
</section>`
    : '';
  const list = view.accounts.length
    ? view.accounts.map(accountRowHtml).join('')
    : `<div class="gt-empty">${icon('account')}<span class="gt-empty__title">No account yet</span><span>Commits use your global git name and email until you add one.</span></div>`;
  const rules = view.rules.length
    ? view.rules
        .map((r) => {
          const known = view.accounts.some((a) => a.label === r.account || a.id === r.account);
          return `<div class="gt-rule"><span class="gt-mono">${r.remote === '*' ? '<em>everything else</em>' : esc(r.remote)}</span><span class="gt-rule__arrow">→</span><span${known ? '' : ' class="gt-rule--unknown" title="No account has this name"'}>${esc(r.account)}</span></div>`;
        })
        .join('')
    : '<p class="gt-muted">No rules yet: a repository uses the account chosen for it, or the one used last.</p>';
  return `${head}
<div class="gt-scroll gt-accounts">
  ${repoHtml}
  <section class="gt-accounts__section">
    <h3 class="gt-section-title">ACCOUNTS</h3>
    ${list}
  </section>
  <section class="gt-accounts__section">
    <h3 class="gt-section-title">PICK THE ACCOUNT BY REMOTE</h3>
    <div class="gt-rules">${rules}</div>
    <p class="gt-muted">The first rule that matches wins. A choice made for one repository overrides the rules.</p>
    <div class="gt-pane__row"><button class="gt-btn" data-action="openRules">Edit rules in settings</button></div>
  </section>
</div>`;
}

const field = ({ label, role, value, placeholder = '' }: { label: string; role: string; value: string; placeholder?: string }): string =>
  `<label class="gt-field"><span class="gt-section-title">${label}</span><span class="gt-input"><input data-role="${role}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false"></span></label>`;

function dialog({ title, body, foot, close }: { title: string; body: string; foot: string; close: string }): string {
  return `<div class="gt-backdrop" data-action="${close}">
  <div class="gt-dialog" role="dialog" aria-modal="true" aria-labelledby="gt-account-title" data-stop>
    <div class="gt-dialog__title"><h2 id="gt-account-title">${title}</h2></div>
    ${body}
    <div class="gt-dialog__foot">${foot}</div>
  </div>
</div>`;
}

const button = ({ action, label, kind = '', busy = false, submit = false, id = '' }: { action: string; label: string; kind?: string; busy?: boolean; submit?: boolean; id?: string }): string =>
  `<button class="gt-btn${kind ? ` gt-btn--${kind}` : ''}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}${submit ? ' data-role="submit"' : ''}${busy ? ' disabled' : ''}>${label}</button>`;

function addHtml(d: Extract<AccountDialog, { kind: 'add' }>): string {
  const { input } = d;
  const providers = PROVIDERS.map((p) => `<option value="${p.id}"${input.provider === p.id ? ' selected' : ''}>${p.label}</option>`).join('');
  const method = (m: NewAccount['method'], label: string, note: string): string =>
    `<button class="gt-signin${input.method === m ? ' is-on' : ''}" data-action="pickMethod" data-method="${m}" aria-pressed="${input.method === m}"><span class="gt-signin__label">${label}</span><span class="gt-muted">${note}</span></button>`;
  const methods =
    input.provider === 'github'
      ? `${method('browser', `${icon('account', 'gt-i--sm')}Sign in with browser`, 'Through VS Code’s GitHub sign-in')}<span class="gt-signin__or">or</span>${method('token', 'Use a token instead', 'A personal access token, kept in VS Code’s secret storage')}${method('ssh', 'Use an SSH key', 'A key from ~/.ssh')}`
      : `${method('token', `${icon('key', 'gt-i--sm')}Access token`, 'Checked with the host, kept in VS Code’s secret storage')}${method('ssh', 'SSH key', 'A key from ~/.ssh')}`;
  const ok = !d.busy && input.name.trim() !== '' && input.email.trim() !== '' && input.host.trim() !== '';
  const next = input.method === 'browser' ? 'VS Code asks which GitHub account next.' : input.method === 'token' ? 'VS Code asks for the token next; it never passes through this page.' : 'VS Code asks for the key file next.';
  return dialog({
    title: 'Add account',
    close: 'closeAccountDialog',
    body: `<label class="gt-field"><span class="gt-section-title">Provider</span><span class="gt-select gt-select--wide"><select data-action="pickProvider">${providers}</select>${icon('pull', 'gt-i--sm')}</span></label>
    ${input.provider === 'github' ? '' : field({ label: 'Host', role: 'accountHost', value: input.host, placeholder: 'gitlab.example.com' })}
    <div class="gt-signins">${methods}</div>
    ${field({ label: 'Name in Githor', role: 'accountLabel', value: input.label, placeholder: input.method === 'browser' ? 'The GitHub login' : 'Work, Personal…' })}
    ${field({ label: 'Name in commits', role: 'accountName', value: input.name })}
    ${field({ label: 'Email in commits', role: 'accountEmail', value: input.email })}
    <p class="gt-muted">${d.busy ? `${icon('spinner', 'gt-spin gt-i--sm')} Waiting for the sign-in in VS Code…` : next}</p>`,
    foot: `${button({ action: 'closeAccountDialog', label: 'Cancel', kind: 'ghost' })}<button class="gt-btn gt-btn--primary" data-action="addAccountDo" data-role="submit"${ok ? '' : ' disabled'}>Add account</button>`,
  });
}

/** The open account dialog, if any. */
export function accountDialogHtml(d: AccountDialog): string {
  switch (d.kind) {
    case 'add':
      return addHtml(d);
    case 'edit': {
      const ok = !d.busy && [d.label, d.name, d.email].every((v) => v.trim() !== '');
      return dialog({
        title: `Edit ${esc(d.label)}`,
        close: 'closeAccountDialog',
        body: `${field({ label: 'Name in Githor', role: 'accountLabel', value: d.label })}${field({ label: 'Name in commits', role: 'accountName', value: d.name })}${field({ label: 'Email in commits', role: 'accountEmail', value: d.email })}
    <p class="gt-muted">Commits made from now on carry this name and email; commits that exist keep theirs.</p>`,
        foot: `${button({ action: 'closeAccountDialog', label: 'Cancel', kind: 'ghost' })}<button class="gt-btn gt-btn--primary" data-action="editAccountDo" data-role="submit"${ok ? '' : ' disabled'}>Save</button>`,
      });
    }
    case 'remove':
      return dialog({
        title: `Remove ${esc(d.label)}?`,
        close: 'closeAccountDialog',
        body: '<p>Sign-in is removed from this computer. Commits that exist keep their author. Repos that use it fall back to the rules.</p>',
        foot: `${button({ action: 'closeAccountDialog', label: 'Cancel', kind: 'ghost' })}${button({ action: 'removeAccountDo', label: 'Remove account', kind: 'danger', busy: d.busy, submit: true, id: d.id })}`,
      });
    case 'confirm':
      return dialog({
        title: `Commit as ${esc(d.active.label)}?`,
        close: 'dropRetry',
        body: `<p><strong>This repo normally uses ${esc(d.suggested.label)}</strong></p><p class="gt-muted">The rule for <span class="gt-mono">${esc(d.rule === '*' ? 'everything else' : d.rule)}</span> picks ${esc(d.suggested.label)}.</p>`,
        foot: `${button({ action: 'retryAs', label: `Commit as ${esc(d.active.label)}`, kind: 'ghost', busy: d.busy })}${button({ action: 'retryAs', label: `Switch to ${esc(d.suggested.label)} and commit`, kind: 'primary', busy: d.busy, submit: true, id: d.suggested.id })}`,
      });
    case 'problem':
      return problemHtml(d.problem, d.busy);
    default: {
      const unreachable: never = d;
      return unreachable;
    }
  }
}

/** The remote refused the account, or its sign-in expired (design `48`). */
function problemHtml(p: Problem, busy: boolean): string {
  if (p.kind === 'unauthorized')
    return dialog({
      title: `${esc(p.account.label)} needs a new sign-in`,
      close: 'dropRetry',
      body: `<p><strong>The sign-in expired</strong></p><p class="gt-muted">Pull and push for this repo stop until you sign in.</p>`,
      foot: `${button({ action: 'dropRetry', label: 'Later', kind: 'ghost' })}${button({ action: 'signInAgain', label: 'Sign in again', kind: 'primary', busy, submit: true, id: p.account.id })}`,
    });
  const why = p.kind === 'forbidden' ? '403: no write access' : '404: this account cannot see the repository';
  const body = p.suggestion
    ? `${esc(p.suggestion.label)} can push to <span class="gt-mono">${esc(p.remote)}</span>.`
    : `None of your other accounts can push to <span class="gt-mono">${esc(p.remote)}</span>. Add one that can, or ask for access.`;
  return dialog({
    title: `${esc(p.remoteName)} rejected ${esc(p.account.label)}`,
    close: 'dropRetry',
    body: `<p><strong>${why}</strong></p><p class="gt-muted">${body}</p>`,
    foot: `${button({ action: 'dropRetry', label: 'Cancel', kind: 'ghost' })}${
      p.suggestion
        ? button({ action: 'retryAs', label: `Switch to ${esc(p.suggestion.label)} and retry`, kind: 'primary', busy, submit: true, id: p.suggestion.id })
        : button({ action: 'addAccountOpen', label: 'Add account…', kind: 'primary', submit: true })
    }`,
  });
}

/** On the Commit tab while there is no account (design `48`, No account yet). */
export const noAccountHtml = (): string => `<div class="gt-banner gt-banner--info">
  <span class="gt-banner__icon">${icon('account')}</span>
  <span class="gt-banner__text"><strong>Add your first account</strong><span class="gt-muted">Commits use your global git name and email until you add one.</span></span>
  <span class="gt-pane__row"><button class="gt-btn gt-btn--ghost" data-action="hideAccountHint">Not now</button><button class="gt-btn" data-action="addAccountOpen">Add account…</button></span>
</div>`;
