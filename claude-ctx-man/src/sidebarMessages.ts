import { isRecord } from './json';
import type { AccountAction, ClientMessage, SessionAction, Tool } from './sidebarWire';

const ACCOUNT_ACTIONS: readonly string[] = ['use', 'new', 'hide'] satisfies AccountAction[];
const SESSION_ACTIONS: readonly string[] = ['resume', 'continue', 'handoff', 'copy', 'reveal'] satisfies SessionAction[];
const TOOLS: readonly string[] = ['statusline', 'aiFiles', 'addAccount', 'showHidden', 'refresh'] satisfies Tool[];

/** What the sidebar page posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseSidebarMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  const { type, action, dir, key, all, tool } = raw;
  switch (type) {
    case 'ready':
      return { type: 'ready' };
    case 'account':
      return typeof dir === 'string' && typeof action === 'string' && ACCOUNT_ACTIONS.includes(action) ? { type, action: action as AccountAction, dir } : null;
    case 'session':
      return typeof key === 'string' && typeof action === 'string' && SESSION_ACTIONS.includes(action) ? { type, action: action as SessionAction, key } : null;
    case 'scope':
      return typeof all === 'boolean' ? { type, all } : null;
    case 'tool':
      return typeof tool === 'string' && TOOLS.includes(tool) ? { type, tool: tool as Tool } : null;
    default:
      return null;
  }
}
