#!/usr/bin/env node
// A minimal stand-in for `claude -p` with stream-json in and out, for the runner's own tests. It answers each user
// message in turn, after FAKE_STREAM_DELAY ms. FAKE_STREAM (comma-separated) changes how:
//   uuids     results name the messages they answer (user_message_uuids), as Claude Code 2.1.259+ does
//   utf8      the result line is written in two chunks split inside a multi-byte character
//   interrupt a control_request interrupt ends the turn at once, as Claude Code does
//   hang      user messages are never answered
import * as readline from 'readline';

interface Incoming {
  type?: string;
  uuid?: string;
  request_id?: string;
  request?: { subtype?: string };
  message?: { content?: string };
}

const modes = new Set((process.env.FAKE_STREAM || '').split(',').filter(Boolean));
const delay = Number(process.env.FAKE_STREAM_DELAY || 100);
const out = (m: unknown): void => void process.stdout.write(`${JSON.stringify(m)}\n`);

const queue: Incoming[] = [];
let busy: { timer: NodeJS.Timeout; msg: Incoming } | null = null;

function result(msg: Incoming, extra: Record<string, unknown> = {}): void {
  const line = Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `answer to: ${msg.message?.content ?? ''}`, total_cost_usd: 0.01, num_turns: 1, ...(modes.has('uuids') && { user_message_uuids: [msg.uuid] }), ...extra })}\n`);
  if (!modes.has('utf8')) return void process.stdout.write(line);
  // Inside the first two-byte character of the text: a pipe may cut a line anywhere.
  const at = line.findIndex((b) => b >= 0xc0) + 1;
  process.stdout.write(line.subarray(0, at));
  setTimeout(() => process.stdout.write(line.subarray(at)), 30);
}

function next(): void {
  if (busy || modes.has('hang')) return;
  const msg = queue.shift();
  if (!msg) return;
  busy = {
    msg,
    timer: setTimeout(() => {
      busy = null;
      result(msg);
      next();
    }, delay),
  };
}

out({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}`, model: 'claude-sonnet-5-5' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line) as Incoming;
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.request?.subtype === 'interrupt' && modes.has('interrupt') && busy) {
      clearTimeout(busy.timer);
      const msg = busy.msg;
      busy = null;
      result(msg, { subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['interrupted'] });
    }
    return;
  }
  if (m.type === 'user') {
    queue.push(m);
    next();
  }
});
process.stdin.on('end', () => process.exit(0));
