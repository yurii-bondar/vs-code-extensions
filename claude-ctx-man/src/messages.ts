import { isRecord } from './json';
import { normalizeConfig } from '../statusline/render';
import type { ClientMessage } from './wire';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What the status line editor posted, narrowed once at the edge; null for anything that is not a known message. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['type']) {
    case 'ready':
    case 'openConfig':
      return { type: raw['type'] };
    case 'update':
      return isRecord(raw['config']) ? { type: 'update', config: normalizeConfig(raw['config']) } : null;
    case 'previewAccount':
      return typeof raw['dir'] === 'string' ? { type: 'previewAccount', dir: raw['dir'] } : null;
    case 'apply':
    case 'restore':
      return { type: raw['type'], dirs: strings(raw['dirs']) };
    default:
      return null;
  }
}
