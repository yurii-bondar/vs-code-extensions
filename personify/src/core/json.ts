export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
