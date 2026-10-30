// The settings each agent session gets (`--settings`): the guard hook, plus what Claude Code itself enforces even if
// a command slips past the guard's reading of it (`node -e "…"`, a script the agent wrote): deny rules for secrets
// and pushes, and the OS sandbox around every shell command (Seatbelt on macOS, bubblewrap on Linux and WSL2).
import * as path from 'path';

/**
 * Credentials an agent never reads, with its file tools or from a shell command. Claude Code's rule syntax: `~/` is
 * the home folder, `//` the filesystem root.
 */
const SECRET_FILES = ['~/.ssh/**', '~/.aws/**', '~/.gnupg/**', '~/.netrc', '~/.docker/config.json', '~/.kube/**', '~/.config/gcloud/**', '~/.azure/**', '~/.claude*/.credentials.json', '//**/.env', '//**/.env.local', '//**/.env.*.local', '//**/.env.production'];

/** The same for the sandbox, which writes paths plainly (`~` is the home folder). */
const SECRET_PATHS = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.docker/config.json', '~/.kube', '~/.config/gcloud', '~/.azure'];

/** Pushing and merging are Claudestrator's, after you confirm: denied by Claude Code too, whatever the guard says. */
const DENIED_COMMANDS = ['Bash(git push)', 'Bash(git push *)', 'Bash(gh pr merge)', 'Bash(gh pr merge *)'];

/**
 * Hosts a sandboxed command may reach without `policy.network`: package registries, so installs and builds work,
 * and GitHub's API and download hosts for reading (`gh pr list`, release archives). Not github.com itself: git over
 * it is how a push would leave.
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
  'api.github.com',
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
  /** What it never writes, inside its write roots too: Claudestrator's config and task state (`configPaths`). */
  protect: string[];
  /** The session's working directory: the sandbox lets a session write there unless told not to. */
  cwd: string;
  /** `policy.sandbox`: run the agents' shell commands in Claude Code's sandbox. */
  sandbox: boolean;
  /** `policy.network`: hosts commands may reach besides the registries. */
  network: string[];
}

/** An absolute path in Claude Code's rule syntax, where `//` is the filesystem root: `/ws/x` → `//ws/x`. */
const ruleRoot = (abs: string): string => `/${abs.split(path.sep).join('/').replace(/^\/*/, '/')}`;

/** One session's settings. */
function sessionSettings({ hooks, guard, writeRoots, protect, cwd, sandbox, network }: SessionSettingsArgs): Record<string, unknown> {
  return {
    hooks,
    permissions: { deny: [...SECRET_FILES.map((f) => `Read(${f})`), ...protect.flatMap((p) => [`Edit(${ruleRoot(p)})`, `Edit(${ruleRoot(p)}/**)`]), ...DENIED_COMMANDS] },
    ...(sandbox && {
      sandbox: {
        enabled: true,
        // A command that fails in the sandbox is not run again outside it.
        allowUnsandboxedCommands: false,
        filesystem: {
          denyRead: SECRET_PATHS,
          // Git metadata is Claudestrator's (a hook or core.fsmonitor written there would run on its next git call),
          // and a stage that changes nothing writes nowhere but a temp folder.
          denyWrite: [...writeRoots.map((r) => path.join(r, '.git')), ...protect, ...(writeRoots.length ? [] : [cwd])],
        },
        network: { allowedDomains: [...new Set([guard, ...REGISTRIES, ...network])] },
      },
    }),
  };
}

export type { SessionSettingsArgs };
export { sessionSettings, REGISTRIES };
