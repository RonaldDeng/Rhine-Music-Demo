/** Preferences for lyric verses only; album/archive typography has a separate design. */
export type LyricsFont = 'noto-sans-sc' | 'misans' | 'system' | 'custom';
export type LyricsHighlightAnchor = 'center' | 'top';
export interface LyricsPreferences {
  font: LyricsFont;
  customFont: string;
  fontSize: number;
  highlightAnchor: LyricsHighlightAnchor;
}

type Listener = (preferences: LyricsPreferences) => void;
export const LYRICS_FONT_SIZE_MIN = 18;
export const LYRICS_FONT_SIZE_MAX = 48;
export const LYRICS_FONT_OPTIONS: ReadonlyArray<{ value: LyricsFont; label: string }> = Object.freeze([
  { value: 'noto-sans-sc', label: 'Noto Sans SC · 开源黑体' },
  { value: 'misans', label: 'MiSans · 原有字体' },
  { value: 'system', label: '系统字体' },
  { value: 'custom', label: '本机其他字体' },
]);
export const DEFAULT_LYRICS_PREFERENCES: Readonly<LyricsPreferences> = Object.freeze({
  font: 'noto-sans-sc', customFont: '', fontSize: 28, highlightAnchor: 'center',
});
export const LYRICS_PREFERENCES_KEYS = Object.freeze({
  normal: 'rhine-music-lyrics-preferences',
});

/** Accept one family name, never a CSS expression, URL, or comma-separated stack. */
export function sanitizeLyricsCustomFont(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const family = value.trim().replace(/\s+/gu, ' ');
  if (!family || [...family].length > 80 || !/^[\p{L}\p{M}\p{N} ._+\-'’]+$/u.test(family)) return '';
  return family;
}

export function sanitizeLyricsPreferences(value: unknown): LyricsPreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    font: LYRICS_FONT_OPTIONS.some((option) => option.value === raw.font) ? raw.font as LyricsFont : DEFAULT_LYRICS_PREFERENCES.font,
    customFont: sanitizeLyricsCustomFont(raw.customFont),
    fontSize: typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
      ? Math.max(LYRICS_FONT_SIZE_MIN, Math.min(LYRICS_FONT_SIZE_MAX, Math.round(raw.fontSize)))
      : DEFAULT_LYRICS_PREFERENCES.fontSize,
    highlightAnchor: raw.highlightAnchor === 'top' ? 'top' : 'center',
  };
}

const bundledFamily = '"Rhine Noto Sans SC", system-ui, sans-serif';
export function lyricsFontFamily(preferences: LyricsPreferences): string {
  const safe = sanitizeLyricsPreferences(preferences);
  if (safe.font === 'system') return 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  if (safe.font === 'misans') return `"MiSans", ${bundledFamily}`;
  if (safe.font === 'custom' && safe.customFont) return `"${safe.customFont}", ${bundledFamily}`;
  return bundledFamily;
}

const key = LYRICS_PREFERENCES_KEYS.normal;
let current: LyricsPreferences | undefined;
let listening = false;
const listeners = new Set<Listener>();

function read(): LyricsPreferences {
  try { return sanitizeLyricsPreferences(JSON.parse(localStorage.getItem(key) || 'null')); }
  catch { return { ...DEFAULT_LYRICS_PREFERENCES }; }
}

function equal(a: LyricsPreferences, b: LyricsPreferences): boolean {
  return a.font === b.font && a.customFont === b.customFont && a.fontSize === b.fontSize && a.highlightAnchor === b.highlightAnchor;
}

function publish(next: LyricsPreferences) {
  const changed = !current || !equal(current, next);
  current = next;
  if (changed) for (const listener of listeners) listener({ ...next });
}

function ensureCurrent(): LyricsPreferences {
  current ??= read();
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === key || event.key === null) publish(read());
    });
  }
  return current;
}

export function getLyricsPreferences(): LyricsPreferences {
  return { ...ensureCurrent() };
}

export function updateLyricsPreferences(patch: Partial<LyricsPreferences>): LyricsPreferences {
  const next = sanitizeLyricsPreferences({ ...ensureCurrent(), ...patch });
  try { localStorage.setItem(key, JSON.stringify(next)); }
  catch { /* Storage denial does not prevent changes in the current page. */ }
  publish(next);
  return { ...next };
}

/** Immediately receives a snapshot, then updates; unsubscribing detaches only this listener. */
export function subscribeLyricsPreferences(listener: Listener): () => void {
  const snapshot = getLyricsPreferences();
  listeners.add(listener);
  listener(snapshot);
  return () => { listeners.delete(listener); };
}
