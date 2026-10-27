// Claude Code PreToolUse hook used by Claudestrator agents. It asks the extension (over a local socket)
// whether the tool call may run, and fails closed: no answer means deny.
import * as net from 'net';

const decide = (decision: 'allow' | 'deny', reason: string): never => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const socket = process.env.CLAUDESTRATOR_HOOK_SOCKET;
  const token = process.env.CLAUDESTRATOR_HOOK_TOKEN;
  // Not a Claudestrator run (e.g. the user ran claude by hand with these settings): stay out of the way.
  if (!socket || !token) return process.exit(0);
  let payload: unknown;
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return decide('deny', 'Claudestrator could not read the tool call');
  }
  const conn = net.connect(socket);
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('connect', () => conn.write(`${JSON.stringify({ token, payload })}\n`));
  conn.on('data', (d) => {
    buf += d;
    const i = buf.indexOf('\n');
    if (i < 0) return;
    let reply: { allow?: boolean; reason?: string };
    try {
      reply = JSON.parse(buf.slice(0, i));
    } catch {
      return decide('deny', 'Claudestrator sent an unreadable answer');
    }
    decide(reply.allow ? 'allow' : 'deny', reply.reason || (reply.allow ? 'allowed by Claudestrator' : 'denied by Claudestrator'));
  });
  conn.on('error', (e: NodeJS.ErrnoException) => decide('deny', `Claudestrator is not reachable (${e.code || e.message}); is VS Code still open?`));
});
