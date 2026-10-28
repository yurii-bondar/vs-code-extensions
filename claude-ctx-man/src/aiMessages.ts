import { isRecord } from './json';
import type { ClientMessage, PresetId, ToolId } from './aiWire';

const TOOLS: readonly string[] = ['claude', 'cursor', 'agents'] satisfies ToolId[];
const PRESETS: readonly string[] = ['claude-only', 'several'] satisfies PresetId[];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What the AI files page posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseAiMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  const { type, root, preset, path } = raw;
  if (type === 'ready') return { type: 'ready' };
  if (typeof root !== 'string') return null;
  if (type === 'open') return typeof path === 'string' ? { type: 'open', root, path } : null;
  if ((type !== 'plan' && type !== 'create') || typeof preset !== 'string' || !PRESETS.includes(preset)) return null;
  const tools = strings(raw['tools']).filter((t): t is ToolId => TOOLS.includes(t));
  return type === 'plan' ? { type, root, preset: preset as PresetId, tools } : { type, root, preset: preset as PresetId, tools, skip: strings(raw['skip']) };
}
