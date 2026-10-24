import test from 'node:test'
import assert from 'node:assert/strict'

const entries = new Map()
const handlers = new Set()
let denied = false
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => { if (denied) throw new Error('Storage unavailable'); return entries.get(key) ?? null },
  setItem: (key, value) => { if (denied) throw new Error('Storage unavailable'); entries.set(key, value) },
} })
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: (name, callback) => { if (name === 'storage') handlers.add(callback) },
} })
const preferences = await import('../src/music-lyrics-preferences.ts')
const { DEFAULT_LYRICS_PREFERENCES, LYRICS_PREFERENCES_KEYS, getLyricsPreferences,
  updateLyricsPreferences, subscribeLyricsPreferences, sanitizeLyricsPreferences, sanitizeLyricsCustomFont, lyricsFontFamily } = preferences
const storageEvent = (key) => { for (const callback of handlers) callback({ key }) }

test('missing or malformed settings use an independent lyric default and bounded integer font size', () => {
  assert.deepEqual(getLyricsPreferences(), DEFAULT_LYRICS_PREFERENCES)
  for (const value of [null, [], 'text', { font: 'unknown', fontSize: Infinity, highlightAnchor: 'bottom' }]) {
    assert.deepEqual(sanitizeLyricsPreferences(value), DEFAULT_LYRICS_PREFERENCES)
  }
  assert.equal(sanitizeLyricsPreferences({ fontSize: 10 }).fontSize, 18)
  assert.equal(sanitizeLyricsPreferences({ fontSize: 80 }).fontSize, 48)
  assert.equal(sanitizeLyricsPreferences({ fontSize: 31.7 }).fontSize, 32)
  entries.set(LYRICS_PREFERENCES_KEYS.normal, '{broken')
  storageEvent(LYRICS_PREFERENCES_KEYS.normal)
  assert.deepEqual(getLyricsPreferences(), DEFAULT_LYRICS_PREFERENCES)
})

test('lyric settings persist independently and ignore retired layout-review preferences', () => {
  entries.set('rhine-music-lyrics-preferences-review', JSON.stringify({ fontSize: 48 }))
  storageEvent('rhine-music-lyrics-preferences-review')
  assert.deepEqual(getLyricsPreferences(), DEFAULT_LYRICS_PREFERENCES)
  updateLyricsPreferences({ font: 'misans', fontSize: 22, highlightAnchor: 'top' })
  assert.equal(getLyricsPreferences().fontSize, 22)
  assert.equal(getLyricsPreferences().font, 'misans')
  assert.equal(getLyricsPreferences().highlightAnchor, 'top')
  assert.equal(JSON.parse(entries.get(LYRICS_PREFERENCES_KEYS.normal)).fontSize, 22)
  assert.equal(entries.has('rhine-music-preferences'), false, 'does not write the global UI/audio preference store')
})

test('subscribers get snapshots, unsubscription works, and other tabs only refresh the active scope', () => {
  const seen = []
  const unsubscribe = subscribeLyricsPreferences((value) => { seen.push(value); value.fontSize = 999 })
  assert.equal(seen.length, 1)
  assert.equal(getLyricsPreferences().fontSize, 22, 'listener cannot mutate the stored state')
  updateLyricsPreferences({ fontSize: 30 })
  assert.equal(seen.length, 2)
  entries.set(LYRICS_PREFERENCES_KEYS.normal, JSON.stringify({ font: 'system', fontSize: 34, highlightAnchor: 'center' }))
  storageEvent('rhine-music-lyrics-preferences-review')
  assert.equal(getLyricsPreferences().fontSize, 30)
  storageEvent(LYRICS_PREFERENCES_KEYS.normal)
  assert.equal(getLyricsPreferences().fontSize, 34)
  assert.equal(seen.length, 3)
  unsubscribe()
  updateLyricsPreferences({ fontSize: 32 })
  assert.equal(seen.length, 3)
})

test('storage denial still permits in-page font changes and never leaks an exception into playback', () => {
  denied = true
  assert.doesNotThrow(() => updateLyricsPreferences({ fontSize: 38 }))
  assert.equal(getLyricsPreferences().fontSize, 38)
  denied = false
})

test('custom local font names cannot inject a CSS list, URL or declaration and always keep a bundled fallback', () => {
  for (const input of ['x", serif; color: red', 'url(https://example.invalid/font)', 'Arial, serif', 'Font\nName', 'x'.repeat(81), 'var(--unsafe)']) {
    assert.equal(sanitizeLyricsCustomFont(input), '')
    const stack = lyricsFontFamily({ ...DEFAULT_LYRICS_PREFERENCES, font: 'custom', customFont: input })
    assert.equal(stack, '"Rhine Noto Sans SC", system-ui, sans-serif')
  }
  assert.equal(sanitizeLyricsCustomFont('  Source   Han Sans SC  '), 'Source Han Sans SC')
  assert.equal(sanitizeLyricsCustomFont('思源黑体 CN'), '思源黑体 CN')
  assert.equal(lyricsFontFamily({ ...DEFAULT_LYRICS_PREFERENCES, font: 'custom', customFont: "Founder's Font" }), '"Founder\'s Font", "Rhine Noto Sans SC", system-ui, sans-serif')
  assert.match(lyricsFontFamily({ ...DEFAULT_LYRICS_PREFERENCES, font: 'custom', customFont: 'Not Installed Here' }), /^"Not Installed Here", "Rhine Noto Sans SC"/)
})
