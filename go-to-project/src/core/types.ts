/** `vscode.env.sessionId`: one per window. */
export type WindowId = string & { readonly __brand: 'WindowId' };
/** A project's folder or `.code-workspace` URI as a string: the key windows are matched by. */
export type ProjectUri = string & { readonly __brand: 'ProjectUri' };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
