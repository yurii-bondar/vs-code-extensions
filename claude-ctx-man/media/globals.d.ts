// The editor is one plain script (statusline.js), not a module. What it exchanges with the extension is typed by
// src/wire.ts, and the config by statusline/types.ts.

type StatusLineConfig = import('../statusline/types').StatusLineConfig;
type SegmentConfig = import('../statusline/types').SegmentConfig;
type SegmentId = import('../statusline/types').SegmentId;
type BarFormat = import('../statusline/types').BarFormat;
type HostMessage = import('../src/wire').HostMessage;
type ClientMessage = import('../src/wire').ClientMessage;
type AccountView = import('../src/wire').AccountView;
type PresetView = import('../src/wire').PresetView;
type InstallStatus = import('../src/wire').InstallStatus;
type ToastKind = import('../src/wire').ToastKind;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };
