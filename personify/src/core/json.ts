import type { SettingValue } from './types';

export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The objects of a list; anything else is dropped. */
export const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** A value the catalog's settings can hold; null for anything else. */
export const settingValue = (value: unknown): SettingValue | null => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
