// File checks and writes without blocking the extension host.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** Whether a path exists. */
const exists = (p: string): Promise<boolean> =>
  fs.promises.access(p).then(
    () => true,
    () => false
  );

/**
 * Writes a file whole or not at all: into a temporary file next to it, then renamed over it. A crash or a full disk
 * mid-write leaves the old file, never half a config.yaml that stops every task. A link (a config kept in your
 * dotfiles) stays a link: the file it points to is the one replaced.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const target = await fs.promises.realpath(file).catch(() => file);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const mode = await fs.promises.stat(target).then(
    (st) => st.mode & 0o777,
    () => undefined
  );
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, text, mode === undefined ? {} : { mode });
    await fs.promises.rename(tmp, target);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Writes a file in a folder others may write too (an agent's sandbox reaches the workspace): into a new temporary
 * file, then renamed onto the name. A link planted under that name is replaced, never followed, so the text cannot
 * land in the file it points to (`~/.zshrc`).
 */
async function writeReplacing(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, text, { flag: 'wx' });
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

/** A file's size and change time, '' when it is not there: whether it changed since it was read. */
const signature = (file: string): Promise<string> =>
  fs.promises.stat(file).then(
    (st) => `${st.size}:${st.mtimeMs}`,
    () => ''
  );

/**
 * The folder Claudestrator's own temporary files live in: the sandbox's settings, commit messages, PR bodies, a copy of
 * a repo's index. It sits in the system temp folder, which checks and git hooks may write on macOS (`mktemp` writes
 * there whatever TMPDIR says), so every sandbox keeps them out of this one: a check could otherwise change the
 * sandbox of the command after it, or the message of the next commit. One per user: /tmp is shared on Linux.
 */
const ownTempRoot = (): string => path.join(os.tmpdir(), `claudestrator-${process.getuid ? process.getuid() : 'user'}`);

/** A new folder of Claudestrator's own for temporary files, `prefix` and a random suffix. */
async function ownTemp(prefix: string): Promise<string> {
  const root = ownTempRoot();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(root, prefix));
}

export { exists, ownTemp, ownTempRoot, signature, writeAtomic, writeReplacing };
