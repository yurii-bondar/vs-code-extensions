// The settings each agent session gets (`--settings`): the guard hook, plus what Claude Code itself enforces even if
// a command slips past the guard's reading of it (`node -e "…"`, a script the agent wrote): deny rules for secrets
// and pushes, and the OS sandbox around every shell command (Seatbelt on macOS, bubblewrap on Linux and WSL2).
import * as path from 'path';

/**
 * Credentials an agent never reads, with its file tools or from a shell command. Claude Code's rule syntax: `~/` is
 * the home folder, `//` the filesystem root. Tokens of GitHub (`gh`, git's credential store) and of package registries
 * are here too: with one, a command could write to GitHub over its API or publish a package.
 */
const SECRET_FILES = [
  '~/.ssh/**',
  '~/.aws/**',
  '~/.gnupg/**',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.kube/**',
  '~/.config/gcloud/**',
  '~/.azure/**',
  '~/.config/gh/**',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.yarnrc.yml',
  '~/.pypirc',
  '~/.cargo/credentials',
  '~/.cargo/credentials.toml',
  '~/.gem/credentials',
  '~/.claude.json',
  '~/.claude*/.claude.json',
  '~/.claude*/.credentials.json',
  // Read by builds too, so only Read is refused them: a build's own tool still reads its registry's settings.
  '~/.m2/settings.xml',
  '~/.gradle/gradle.properties',
  '~/.yarnrc',
  '~/.config/pip/pip.conf',
  '~/.pip/pip.conf',
  ...['~/.config/git/credentials', '~/.terraform.d/credentials.tfrc.json', '~/.pgpass', '~/.my.cnf', '~/.vault-token', '~/.composer/auth.json', '~/.config/composer/auth.json', '~/.config/glab-cli/**', '~/.config/hub', '~/.bash_history', '~/.zsh_history', '~/.local/share/fish/fish_history'],
  '//**/.env',
  '//**/.envrc',
  '//**/.env.local',
  '//**/.env.*.local',
  ...['production', 'prod', 'staging', 'stage', 'development', 'dev', 'test'].map((name) => `//**/.env.${name}`),
];

/** A dotenv file by its name: `.env`, `.env.local`, `.env.staging`, direnv's `.envrc`. Its values are credentials. */
const ENV_FILE = /^\.env(rc)?($|\.)/i;

/** The same for the sandbox, which writes paths plainly (`~` is the home folder). */
const SECRET_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.kube',
  '~/.config/gcloud',
  '~/.azure',
  '~/.config/gh',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.yarnrc.yml',
  '~/.pypirc',
  '~/.cargo/credentials',
  '~/.cargo/credentials.toml',
  '~/.gem/credentials',
  '~/.claude.json',
  '~/.claude*/.claude.json',
  '~/.claude*/.credentials.json',
  '~/.config/git/credentials',
  '~/.terraform.d/credentials.tfrc.json',
  '~/.pgpass',
  '~/.my.cnf',
  '~/.vault-token',
  '~/.composer/auth.json',
  '~/.config/composer/auth.json',
  '~/.config/glab-cli',
  '~/.config/hub',
  '~/.bash_history',
  '~/.zsh_history',
  '~/.local/share/fish/fish_history',
];

/**
 * Environment variables that hold a credential: by name (`NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `SSH_AUTH_SOCK`), or by
 * a password in a URL (`DATABASE_URL=postgres://u:p@…`). A sandboxed command gets none of them.
 */
/** A word of a variable's name that makes it a credential: NPM_TOKEN, MYSQL_PWD, GITHUB_PAT, CI_JOB_JWT, SENTRY_DSN. */
const CREDENTIAL_WORD = /^(TOKENS?|SECRETS?|PASSWORD|PASSWD|PASS|PWD|PASSPHRASE|APIKEY|KEYS?|CREDENTIALS?|AUTH|AUTHTOKEN|PAT|JWT|DSN|WEBHOOK|SESSION|COOKIE|PRIVATE)$/;
/** One word that ends in one: PGPASSWORD, GHTOKEN. */
const CREDENTIAL_END = /(TOKEN|SECRET|PASSWORD|PASSWD)$/;
/** Names with such a word that hold none: the shell's folders, a desktop's or a terminal's session. */
const NOT_CREDENTIALS = new Set(['PWD', 'OLDPWD', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_SESSION_CLASS', 'XDG_SESSION_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'TOKENIZERS_PARALLELISM']);
const URL_PASSWORD = /:\/\/[^/\s:@]+:[^/\s@]+@/;
/** A value that is a token by its shape: GitHub, Slack, OpenAI, Anthropic, AWS, Stripe and npm keys. */
const TOKEN_VALUE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|sk-(ant-)?[\w-]{20,}|AKIA[0-9A-Z]{16}|[sr]k_live_\w{10,}|npm_[A-Za-z0-9]{30,})$/;

const credentialName = (name: string): boolean => {
  const upper = name.toUpperCase();
  return !NOT_CREDENTIALS.has(upper) && upper.split(/_+/).some((w) => CREDENTIAL_WORD.test(w) || CREDENTIAL_END.test(w));
};

function credentialVars(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => credentialName(name) || URL_PASSWORD.test(env[name] ?? '') || TOKEN_VALUE.test((env[name] ?? '').trim()))
    .sort();
}

/** GitHub's tokens: an agent reads GitHub through Claudestrator and pushes nothing, so its session has none of them. */
const GITHUB_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

/** Pushing and merging are Claudestrator's, after you confirm: denied by Claude Code too, whatever the guard says. */
const DENIED_COMMANDS = ['Bash(git push)', 'Bash(git push *)', 'Bash(gh pr merge)', 'Bash(gh pr merge *)'];

/**
 * Hosts a sandboxed command may reach without `policy.network`: package registries, so installs and builds work,
 * and GitHub's download hosts (release archives, tarball dependencies). Not github.com, where git would push, and not
 * api.github.com, which takes writes as well as reads: a command that finds a token (the macOS keychain stays
 * readable in the sandbox) could change a repo there. The readiness check gets its PR list from Claudestrator.
 */
const REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'rubygems.org',
  'index.rubygems.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'repo.packagist.org',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

interface SessionSettingsArgs {
  /** The guard: `HookServer.settings()`. */
  hooks: Record<string, unknown>;
  /**
   * The guard's `host:port`. With the sandbox on, Claude Code sends an http hook through the sandbox's network proxy
   * too: a host missing from the allowed ones waits for an approval nobody gives in -p, and then fails (403).
   */
  guard: string;
  /** Where the session may write; empty for a stage that changes nothing. */
  writeRoots: string[];
  /**
   * What it never writes, inside its write roots too: Claudestrator's config and task state (`configPaths`), and what
   * of the repos runs outside the sandbox (`Engine.runsOutside`: git's hooks folder, Claude Code's settings).
   */
  protect: string[];
  /** Files it never reads besides the usual credentials: Claudestrator's own, such as the MCP config it writes. */
  secrets: string[];
  /** Environment variables its shell commands never see (`credentialVars`). */
  envVars: string[];
  /** The session's working directory: the sandbox lets a session write there unless told not to. */
  cwd: string;
  /** `policy.sandbox`: run the agents' shell commands in Claude Code's sandbox. */
  sandbox: boolean;
  /** `policy.writable`: folders commands may write besides the write roots (build caches). */
  writable: string[];
  /** `policy.network`: hosts commands may reach besides the registries. */
  network: string[];
  /** `policy.localPorts`: commands may open local ports and reach what listens on them (macOS). */
  localPorts: boolean;
}

/** An absolute path in Claude Code's rule syntax, where `//` is the filesystem root: `/ws/x` → `//ws/x`. */
const ruleRoot = (abs: string): string => `/${abs.split(path.sep).join('/').replace(/^\/*/, '/')}`;

/** One session's settings. */
function sessionSettings({ hooks, guard, writeRoots, protect, secrets, envVars, cwd, sandbox, network, writable, localPorts }: SessionSettingsArgs): Record<string, unknown> {
  return {
    hooks,
    // Edit rules cover Write too. Git metadata is here as well as in the sandbox: the sandbox holds only shell commands.
    permissions: { deny: [...[...SECRET_FILES, ...secrets.map(ruleRoot)].map((f) => `Read(${f})`), ...[...protect, ...writeRoots.map((r) => path.join(r, '.git'))].flatMap((p) => [`Edit(${ruleRoot(p)})`, `Edit(${ruleRoot(p)}/**)`]), ...DENIED_COMMANDS] },
    ...(sandbox && {
      sandbox: {
        enabled: true,
        // A command that fails in the sandbox is not run again outside it.
        allowUnsandboxedCommands: false,
        filesystem: {
          denyRead: [...SECRET_PATHS, ...secrets],
          ...(writable.length && { allowWrite: writable }),
          // Git metadata is Claudestrator's (a hook or core.fsmonitor written there would run on its next git call),
          // and a stage that changes nothing writes nowhere but a temp folder.
          denyWrite: [...writeRoots.map((r) => path.join(r, '.git')), ...protect, ...(writeRoots.length ? [] : [cwd])],
        },
        network: { allowedDomains: [...new Set([guard, ...REGISTRIES, ...network])], ...(localPorts && { allowLocalBinding: true }) },
        credentials: { envVars: [...new Set([...envVars, ...GITHUB_TOKENS])].map((name) => ({ name, mode: 'deny' })) },
      },
    }),
  };
}

export type { SessionSettingsArgs };
export { sessionSettings, credentialVars, ENV_FILE, REGISTRIES, SECRET_PATHS, GITHUB_TOKENS };
