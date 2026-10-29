import { createHash } from 'crypto';

// Like JetBrains project icons: up to two initials ("shop-admin-panel" → "SA") on a colour picked from the name.
const PALETTE = ['#4D8FE8', '#3FB27F', '#E8804D', '#B36BE0', '#E05C7A', '#2FAFB8', '#C9A227', '#7A86E8', '#5FA855', '#D96C4F'] as const;

export function initials(name: string): string {
  const [first = '?', second] = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2);
  return letters.toUpperCase();
}

export function iconColor(name: string): string {
  const byte = createHash('sha1').update(name).digest()[0] ?? 0;
  return PALETTE[byte % PALETTE.length] ?? PALETTE[0];
}

export function iconSvg(text: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="21.5" text-anchor="middle" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${text.length > 1 ? 14 : 16}" font-weight="700" fill="#fff">${text}</text></svg>`;
}
