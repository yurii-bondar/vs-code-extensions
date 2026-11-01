// Gates and git hooks run code the agents wrote or changed: tests, package.json scripts, `.husky/*`. So they run in the
// sandbox the agents' own commands run in: Anthropic's sandbox-runtime (srt), the engine of Claude Code's sandbox
// (Seatbelt on macOS, bubblewrap on Linux and WSL2). It starts as a child process (`srt --settings <file> -c <cmd>`),
// which keeps its ES module build and the Node it needs out of the extension host. Native Windows has no sandbox, for
// the agents either.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { exists } from './files';

/** What a sandboxed command may do. */
interface SandboxPolicy {
  /** Where it may write; srt's own temp folder (its `TMPDIR`) always is. */
  allowWrite: string[];
  /** What it never writes inside those. srt adds `.git/hooks`, `.git/config` and shell profiles itself. */
  denyWrite: string[];
  /** What it never reads: credentials. */
  denyRead: string[];
  /** Hosts it may reach. */
  network: string[];
  /** Whether it may open local ports and reach what listens on them (macOS; Linux's sandbox has a loopback of its own). */
  localPorts: boolean;
}

/** A command as it is spawned; `cleanup` removes what wrapping it left on disk. */
interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/** How a shell command starts: in the sandbox, or plainly. */
type Launcher = (cmd: string, env: NodeJS.ProcessEnv) => Promise<Launch>;

/** bash where there is one, else sh; looked for once. */
let unixShell: Promise<string> | undefined;

async function shellCommand(cmd: string): Promise<[string, string[]]> {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', cmd]];
  unixShell ??= exists('/bin/bash').then((bash) => (bash ? '/bin/bash' : '/bin/sh'));
  return [await unixShell, ['-c', cmd]];
}

const plainLauncher: Launcher = async (cmd, env) => {
  const [file, args] = await shellCommand(cmd);
  return { file, args, env, cleanup: async () => {} };
};

/** The oldest Node srt runs on (VS Code 1.101 and later ships one; the JetBrains plugin runs the user's). */
const SRT_NODE = [22, 12];

/** Why srt cannot run here, or null. */
function sandboxProblem(platform: string = process.platform, nodeVersion: string = process.versions.node): string | null {
  if (platform !== 'darwin' && platform !== 'linux') return `there is no sandbox on ${platform}`;
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  if (major < SRT_NODE[0]! || (major === SRT_NODE[0] && minor < SRT_NODE[1]!)) return `the sandbox needs Node ${SRT_NODE.join('.')} or newer, and Claudestrator runs on ${nodeVersion} here: update VS Code (1.101 or newer ships one), or the Node.js the JetBrains plugin uses`;
  return null;
}

/** srt's command line entry, from the installed package. */
function srtCli(): string {
  return path.join(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime')), 'cli.js');
}

/**
 * Starts commands under srt with this policy. In the extension host Node is Electron's, run as Node; that switch is
 * srt's, so the command itself does not inherit it (an Electron app its tests start would behave as Node).
 */
function sandboxLauncher(policy: SandboxPolicy): Launcher {
  return async (cmd, env) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-srt-'));
    const settings = path.join(dir, 'settings.json');
    const config = { network: { allowedDomains: policy.network, deniedDomains: [], ...(policy.localPorts && { allowLocalBinding: true }) }, filesystem: { denyRead: policy.denyRead, allowWrite: policy.allowWrite, denyWrite: policy.denyWrite } };
    await fs.promises.writeFile(settings, JSON.stringify(config), { mode: 0o600 });
    const electron = Boolean(process.versions.electron);
    return {
      file: process.execPath,
      args: [srtCli(), '--settings', settings, '-c', electron ? `unset ELECTRON_RUN_AS_NODE; ${cmd}` : cmd],
      env: { ...env, ...(electron && { ELECTRON_RUN_AS_NODE: '1' }) },
      cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }),
    };
  };
}

/**
 * Whether srt starts on this machine with this policy: on Linux it needs bubblewrap, socat and ripgrep, and a
 * missing one shows only when a command runs. Null when it does, else what it said.
 */
async function probeSandbox(launch: Launcher, env: NodeJS.ProcessEnv, timeoutMs = 30000): Promise<string | null> {
  const l = await launch('true', env);
  try {
    return await new Promise<string | null>((resolve) => {
      let output = '';
      const child = spawn(l.file, l.args, { env: l.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(`it did not start in ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (output += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (output += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(e.message);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? null : output.trim().split('\n').slice(-4).join('\n') || `it exited with ${code}`);
      });
    });
  } finally {
    await l.cleanup();
  }
}

/** Shell-quotes one word: `it's` → `'it'\''s'`. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export type { Launch, Launcher, SandboxPolicy };
export { plainLauncher, probeSandbox, sandboxLauncher, sandboxProblem, shellCommand, shq };
