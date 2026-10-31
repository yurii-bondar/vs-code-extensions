// File checks and writes without blocking the extension host.
import * as fs from 'fs';
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

export { exists, signature, writeAtomic, writeReplacing };
