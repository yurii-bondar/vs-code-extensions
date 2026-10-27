// The extension's side of the PreToolUse hook: a local socket (Unix socket or Windows named pipe)
// where each running agent session has a token mapped to its permission policy.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

class HookServer {
  constructor() {
    this.sessions = new Map();
    const id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const name = `claudestrator-${id}.sock`;
    // Unix socket paths are limited to ~104 bytes; a long TMPDIR falls back to /tmp.
    const tmp = path.join(os.tmpdir(), name).length < 100 ? os.tmpdir() : '/tmp';
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\claudestrator-${id}` : path.join(tmp, name);
    this.server = null;
  }

  listen() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => this.onConnection(conn));
      this.server.on('error', reject);
      this.server.listen(this.address, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.address, 0o600);
          } catch {
            // best effort: the token is the real check
          }
        }
        resolve();
      });
    });
  }

  /** Registers a policy: `decide({ tool, input, cwd }) → Promise<{ allow, reason }>`. Returns the env for the agent. */
  register(decide) {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, decide);
    return { token, env: { CLAUDESTRATOR_HOOK_SOCKET: this.address, CLAUDESTRATOR_HOOK_TOKEN: token } };
  }

  unregister(token) {
    this.sessions.delete(token);
  }

  onConnection(conn) {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = '';
      let reply;
      try {
        const { token, payload } = JSON.parse(line);
        const decide = this.sessions.get(token);
        if (!decide) reply = { allow: false, reason: 'this agent session is no longer active in Claudestrator' };
        else reply = await decide({ tool: payload.tool_name, input: payload.tool_input || {}, cwd: payload.cwd });
      } catch (e) {
        reply = { allow: false, reason: `Claudestrator error: ${e.message}` };
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  }

  dispose() {
    if (this.server) this.server.close();
    this.server = null;
    if (process.platform !== 'win32') fs.rmSync(this.address, { force: true });
  }
}

const quote = (s) => (process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * Writes the `--settings` file every agent gets: one PreToolUse hook for all tools. `node` is a Node.js binary;
 * without one, VS Code's own runtime runs the script in Node mode.
 */
function writeHookSettings(file, { node, script }) {
  const runtime = node ? quote(node) : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)}`;
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${runtime} ${quote(script)}`, timeout: 900 }] }] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

module.exports = { HookServer, writeHookSettings };
