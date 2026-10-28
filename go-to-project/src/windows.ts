import { promises as fs } from 'fs';
import * as path from 'path';
import { beat, focused, lastProject, openProjects, parseFocus, parseRegistry, serializeRegistry } from './core/state';
import type { Focus } from './core/state';
import type { ProjectUri, WindowId } from './core/types';

interface WindowRegistryArgs {
  /** The extension's global storage dir, which every window shares. */
  dir: string;
  windowId: WindowId;
  now?: () => number;
}

/** Which projects are open in which window and which was focused last, in files every window reads and writes. */
export class WindowRegistry {
  private readonly registryFile: string;
  private readonly focusFile: string;
  private readonly windowId: WindowId;
  private readonly now: () => number;
  private writes = 0;

  constructor({ dir, windowId, now = Date.now }: WindowRegistryArgs) {
    this.registryFile = path.join(dir, 'windows.json');
    this.focusFile = path.join(dir, 'focus.json');
    this.windowId = windowId;
    this.now = now;
  }

  /** Says this window is alive and shows `own`, and drops windows that stopped saying so. */
  async heartbeat(own: ProjectUri | null): Promise<void> {
    const registry = parseRegistry(await this.read(this.registryFile));
    await this.write(this.registryFile, serializeRegistry(beat(registry, { windowId: this.windowId, uri: own, now: this.now() })));
  }

  async focus(own: ProjectUri): Promise<void> {
    const next = focused(await this.focusState(), own);
    if (next) await this.write(this.focusFile, next);
  }

  async focusState(): Promise<Focus> {
    return parseFocus(await this.read(this.focusFile));
  }

  async last(own: ProjectUri | null): Promise<ProjectUri | null> {
    return lastProject(await this.focusState(), own);
  }

  async open(own: ProjectUri | null): Promise<ProjectUri[]> {
    const registry = parseRegistry(await this.read(this.registryFile));
    return openProjects(registry, { windowId: this.windowId, own, now: this.now() });
  }

  async leave(): Promise<void> {
    const registry = parseRegistry(await this.read(this.registryFile));
    registry.delete(this.windowId);
    await this.write(this.registryFile, serializeRegistry(registry));
  }

  private async read(file: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  // Written to a temp file first, so another window never reads half a file.
  private async write(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${this.windowId}.${++this.writes}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, file);
    } catch {
      // best effort; another window may be writing
    }
  }
}
