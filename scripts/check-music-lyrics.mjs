import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MusicLyricsService, parseLyricText, readEmbeddedLyrics, chooseLyricCandidate, LYRIC_TEXT_LIMIT } from './music-lyrics.mjs'

async function fixture(t, serviceOptions = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-test-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'music')
  await fs.mkdir(root)
  const file = path.join(root, '01 Synthetic.wav')
  const wav = Buffer.alloc(46)
  wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40)
  await fs.writeFile(file, wav)
  let networkCalls = 0
  const service = new MusicLyricsService({ fetcher: async () => { networkCalls++; throw new Error('unexpected network call') }, providers: ['amll'], ...serviceOptions })
  const input = { track: { id: 'synthetic-track', title: 'Synthetic Song', artist: 'Test Artist', duration: 120 }, album: { title: 'Test Album' }, descriptor: { path: file, allowedRoot: root, mime: 'audio/wav' } }
  return { temporary, root, file, sidecar: path.join(root, '01 Synthetic.lrc'), service, input, networkCalls: () => networkCalls }
}

const candidate = (overrides = {}) => ({ id: 123, trackName: 'Synthetic Song', artistName: 'Test Artist', albumName: 'Test Album', duration: 90, instrumental: false, syncedLyrics: '[00:01.20]A synthetic first line\n[00:20]A synthetic second line', plainLyrics: '', ...overrides })
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

test('LRC parser sorts repeated timestamps, applies positive offsets, deduplicates, and preserves clear cues', () => {
  const result = parseLyricText('[ar:Test]\n[offset:+250]\n[00:20.250][00:01.5]First\n[00:01.50]First\n[00:02.00]<00:02.0>Second\n[00:03.00]\n[00:20.250]Translation')
  assert.equal(result.status, 'synced')
  assert.deepEqual(result.lines, [{ time: 1.25, text: 'First' }, { time: 1.75, text: 'Second' }, { time: 2.75, text: '' }, { time: 20, text: 'First' }, { time: 20, text: 'Translation' }])
  assert.equal(parseLyricText('[offset:-1000]\n[00:01.0]Later').lines[0].time, 2)
})

test('plain, empty and explicit instrumental text stay distinct; markup remains inert text', () => {
  assert.deepEqual(parseLyricText('\uFEFFPlain line\r\n<img onerror="bad">'), { status: 'plain', lines: [{ time: null, text: 'Plain line' }, { time: null, text: '<img onerror="bad">' }] })
  assert.equal(parseLyricText('[ar:Test]\n[ti:Empty]').status, 'not-found')
  assert.equal(parseLyricText('[instrumental:true]').status, 'instrumental')
  assert.throws(() => parseLyricText('a'.repeat(LYRIC_TEXT_LIMIT + 1)), /过大/)
  assert.throws(() => parseLyricText(Array.from({ length: 2001 }, () => '[00:01]Synthetic').join('\n')), /行数/)
})

test('embedded SYLT uses millisecond format only; MPEG frame counts are not treated as time', () => {
  assert.deepEqual(readEmbeddedLyrics({ common: { lyrics: [{ timeStampFormat: 2, syncText: [{ timestamp: 1200, text: 'Synthetic line' }] }] } }), { status: 'synced', lines: [{ time: 1.2, text: 'Synthetic line' }] })
  assert.equal(readEmbeddedLyrics({ common: { lyrics: [{ timeStampFormat: 1, syncText: [{ timestamp: 1200, text: 'Frame count' }] }] } }).status, 'not-found')
  assert.equal(readEmbeddedLyrics({ common: { lyrics: [{ text: '[00:02]Embedded LRC' }] } }).status, 'synced')
})

test('local sidecar wins over tags and never calls the network, even for an explicit online request', async (t) => {
  const f = await fixture(t, { metadataParser: async () => { throw new Error('must not read tags before sidecar') } })
  await fs.writeFile(f.sidecar, '[00:01.23]Local synthetic line')
  const before = await fs.readFile(f.file)
  const result = await f.service.lookup(f.input, { online: true })
  assert.equal(result.status, 'synced'); assert.equal(result.lines[0].time, 1.23)
  assert.equal(result.source.kind, 'sidecar'); assert.equal(result.trackId, f.input.track.id)
  assert.equal(f.networkCalls(), 0)
  assert.deepEqual(await fs.readFile(f.file), before)
  assert.equal(JSON.stringify(result).includes(f.root), false, 'never expose private paths')
  await fs.writeFile(f.sidecar, '[00:02]Changed synthetic line')
  assert.equal((await f.service.lookup(f.input)).lines[0].time, 2, 'sidecar changes appear without library rescan')
})

test('UTF-16 sidecar and plain TXT fallbacks are supported', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.sidecar, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[00:03]合成测试行', 'utf16le')]))
  assert.equal((await f.service.lookup(f.input)).lines[0].text, '合成测试行')
  await fs.rm(f.sidecar)
  await fs.writeFile(f.sidecar.replace('.lrc', '.txt'), 'A synthetic plain lyric')
  assert.equal((await f.service.lookup(f.input)).status, 'plain')
})

test('an explicitly local-only request returns not-found without external requests', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.service.lookup(f.input, { online: false })).status, 'not-found')
  assert.equal(f.networkCalls(), 0)
})

test('embedded lyrics are read only after sidecar miss and cached by file identity', async (t) => {
  let parses = 0
  const f = await fixture(t, { metadataParser: async () => { parses++; return { common: { lyrics: [{ text: 'Embedded synthetic line' }] } } } })
  assert.equal((await f.service.lookup(f.input)).source.kind, 'embedded')
  await f.service.lookup(f.input)
  assert.equal(parses, 1)
  await fs.appendFile(f.file, 'change')
  await f.service.lookup(f.input)
  assert.equal(parses, 2)
})

test('real metadata parser reads a generated MP3 USLT tag without modifying the source', async (t) => {
  const f = await fixture(t)
  const text = Buffer.from('Generated embedded test line', 'latin1')
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), text])
  const frame = Buffer.alloc(10); frame.write('USLT'); frame.writeUInt32BE(payload.length, 4)
  const tagSize = frame.length + payload.length
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (tagSize >> 21) & 127, (tagSize >> 14) & 127, (tagSize >> 7) & 127, tagSize & 127])
  const audioFrame = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(audioFrame)
  const data = Buffer.concat([header, frame, payload, audioFrame, audioFrame, audioFrame])
  const file = path.join(f.root, 'tagged.mp3')
  await fs.writeFile(file, data)
  const result = await f.service.lookup({ ...f.input, descriptor: { path: file, allowedRoot: f.root, mime: 'audio/mpeg' } })
  assert.equal(result.status, 'plain'); assert.equal(result.source.kind, 'embedded')
  assert.equal(result.lines[0].text, 'Generated embedded test line')
  assert.deepEqual(await fs.readFile(file), data)
})

test('out-of-root audio and sidecar symlinks are rejected without reading or exposing paths', async (t) => {
  const f = await fixture(t)
  const outside = path.join(f.temporary, 'outside.txt')
  await fs.writeFile(outside, 'outside synthetic text')
  await fs.symlink(outside, f.sidecar)
  const sidecar = await f.service.lookup(f.input)
  assert.equal(sidecar.status, 'error'); assert.match(sidecar.message, /目录/)
  assert.equal(JSON.stringify(sidecar).includes('outside synthetic'), false)
  await fs.rm(f.sidecar)
  const linked = path.join(f.root, 'linked.wav')
  await fs.symlink(outside, linked)
  const audio = await f.service.lookup({ ...f.input, descriptor: { ...f.input.descriptor, path: linked } })
  assert.equal(audio.status, 'error')
  assert.equal(f.networkCalls(), 0)
})

test('oversized sidecar has a bounded error and never silently falls through to the network', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.sidecar, Buffer.alloc(LYRIC_TEXT_LIMIT + 1, 65))
  const result = await f.service.lookup(f.input, { online: true })
  assert.equal(result.status, 'error'); assert.match(result.message, /过大/)
  assert.equal(f.networkCalls(), 0)
})

test('matching rejects other singers and versions, but ranks release variants and duplicate records', () => {
  const metadata = { title: 'Synthetic Song', artist: 'Test Artist', album: 'Test Album', duration: 120 }
  assert.equal(chooseLyricCandidate(metadata, [candidate()]).song.id, 123)
  for (const other of [{ artistName: 'Other Artist' }, { trackName: 'Synthetic Song Live' }, { duration: 130 }]) assert.equal(chooseLyricCandidate(metadata, [candidate(other)]).song, undefined)
  assert.equal(chooseLyricCandidate(metadata, [candidate(), candidate({ id: 124 })]).song.id, 123)
  assert.equal(chooseLyricCandidate(metadata, [candidate({ albumName: 'Another Album' })]).song.id, 123)
  assert.equal(chooseLyricCandidate(metadata, [candidate({ duration: 60 })]).song.id, 123, 'last lyric may end well before audio ends')
})

test('online lookup starts automatically on a local miss and uses bounded metadata-only requests and memory cache', async (t) => {
  const calls = []
  const f = await fixture(t, { fetcher: async (url, options) => { calls.push({ url: String(url), options }); return response([candidate()]) } })
  assert.equal((await f.service.lookup(f.input, { online: false })).status, 'not-found'); assert.equal(calls.length, 0)
  const online = await f.service.lookup(f.input, { online: true })
  assert.equal(online.status, 'synced'); assert.equal(online.source.kind, 'online')
  assert.equal(online.source.name, 'AMLL TTML DataBase', 'the LRCLIB-compatible endpoint is attributed to its actual provider')
  assert.equal(online.source.url, 'https://api.amll.dev/v1/lrclib/get/123')
  assert.equal(new URL(calls[0].url).hostname, 'api.amll.dev')
  assert.equal(new URL(calls[0].url).searchParams.get('pageSize'), '20')
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.credentials, 'omit')
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(calls[0].options.headers['User-Agent'], `RhineMusicDemo/${manifest.version} (https://github.com/RonaldDeng/Rhine-Music-Demo)`)
  assert.equal(calls[0].url.includes(f.root), false)
  assert.equal((await f.service.lookup(f.input)).status, 'synced'); assert.equal(calls.length, 1)
  await fs.writeFile(f.sidecar, '[00:01]New local lyric')
  assert.equal((await f.service.lookup(f.input)).source.kind, 'sidecar', 'new sidecar supersedes online cache')
})

test('missing artist prevents online lookup and unmatched response is not-found', async (t) => {
  const f = await fixture(t)
  const result = await f.service.lookup({ ...f.input, track: { ...f.input.track, artist: 'Unknown Artist' } }, { online: true })
  assert.equal(result.status, 'not-found'); assert.equal(f.networkCalls(), 0)
  const g = await fixture(t, { fetcher: async () => response([candidate({ artistName: 'Wrong Artist' })]) })
  assert.equal((await g.service.lookup(g.input, { online: true })).status, 'not-found')
})

test('provider instrumental, empty, malformed, oversized and throttled responses remain distinct', async (t) => {
  for (const [mock, expected, pattern] of [
    [() => response([candidate({ instrumental: true, syncedLyrics: '' })]), 'instrumental'],
    [() => response([]), 'not-found'],
    [() => response([candidate({ duration: 90, syncedLyrics: '[10:00]Synthetic invalid late cue' })]), 'not-found'],
    [() => new Response('not JSON'), 'error'],
    [() => response([], 200, { 'Content-Length': '3000000' }), 'error', /过大/],
    [() => response({}, 429), 'error', /限流/],
    [() => response({}, 500), 'error', /不可用/],
  ]) {
    const f = await fixture(t, { fetcher: async () => mock() })
    const result = await f.service.lookup(f.input, { online: true })
    assert.equal(result.status, expected)
    if (pattern) assert.match(result.message, pattern)
  }
})

test('streamed oversized response is cancelled even without a content length header', async (t) => {
  let cancelled = false
  const f = await fixture(t, { fetcher: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)) },
    cancel() { cancelled = true },
  })) })
  const result = await f.service.lookup(f.input, { online: true })
  assert.equal(result.status, 'error'); assert.match(result.message, /过大/)
  assert.equal(cancelled, true)
})

test('network timeout and caller abort cancel transport and do not expose transport errors', async (t) => {
  const f = await fixture(t, { timeoutMs: 20, fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private transport address')), { once: true })
  }) })
  const timed = await f.service.lookup(f.input, { online: true })
  assert.equal(timed.status, 'error'); assert.match(timed.message, /超时/)
  assert.equal(JSON.stringify(timed).includes('private transport'), false)
  const controller = new AbortController(); controller.abort()
  const cancelled = await f.service.lookup(f.input, { online: true, signal: controller.signal })
  assert.equal(cancelled.status, 'error'); assert.match(cancelled.message, /取消/)
})

test('default source fallbacks recover from a refused provider and rank recording duration over a wrong album', async (t) => {
  const calls = []
  const f = await fixture(t, { providers: ['netease', 'lrclib', 'amll'], fetcher: async (url) => {
    calls.push(String(url))
    if (url.hostname === 'music.163.com') return response({ code: 403 })
    assert.equal(url.hostname, 'lrclib.net')
    return response([candidate({ id: 1, duration: 135 }), candidate({ id: 2, albumName: 'Compilation', duration: 120 })])
  } })
  const result = await f.service.lookup(f.input)
  assert.equal(result.status, 'synced')
  assert.equal(result.source.name, 'LRCLIB')
  assert.match(result.source.url, /\/2$/)
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1]).searchParams.has('album_name'), false)
})

test('NetEase checks identity before fetching lyrics and skips an invalid first lyric candidate', async (t) => {
  const fetchedIds = []
  const f = await fixture(t, { providers: ['netease'], fetcher: async (url) => {
    if (url.pathname.includes('/search/')) return response({ code: 200, result: { songs: [
      { id: 1, name: 'Synthetic Song', artists: [{ name: 'Other Singer' }], album: { name: 'Test Album' }, duration: 120000 },
      { id: 2, name: 'Synthetic Song', artists: [{ name: 'Test Artist' }], album: { name: 'Test Album' }, duration: 120000 },
      { id: 3, name: 'Synthetic Song', artists: [{ name: 'Test Artist' }], album: { name: 'Test Album' }, duration: 120000 },
    ] } })
    fetchedIds.push(Number(url.searchParams.get('id')))
    return response({ code: 200, lrc: { lyric: fetchedIds.at(-1) === 2 ? 'x'.repeat(3000) : '[00:01]Independent synthetic lyric' } })
  } })
  const result = await f.service.lookup(f.input)
  assert.equal(result.status, 'synced'); assert.equal(result.source.name, '网易云音乐')
  assert.equal(result.source.url, 'https://music.163.com/song?id=3')
  assert.deepEqual(fetchedIds, [2, 3], 'never fetch an unrelated singer, and malformed matching candidates do not block later ones')
})

test('duplicate artist/title labels and metadata annotations match, while recording variants do not', () => {
  const metadata = { title: 'Synthetic Song (From The Film)', artist: 'Test Artist', album: 'Test Album', duration: 120 }
  assert.equal(chooseLyricCandidate(metadata, [candidate({ trackName: 'Synthetic Song / Synthetic Song', artistName: 'Test Artist / Test Artist', duration: 120 })], { durationKind: 'recording' }).song.id, 123)
  for (const trackName of ['Synthetic Song (Live)', 'Synthetic Song (Remix)', 'Synthetic Song (粤语)', 'Synthetic Song (Demo)', 'Synthetic Song (Piano Version)', 'Synthetic Song (TV Size)', 'Another Song']) {
    assert.equal(chooseLyricCandidate(metadata, [candidate({ trackName })]).song, undefined)
  }
  assert.equal(chooseLyricCandidate({ ...metadata, artist: 'Test Artist / Second Artist' }, [candidate()]).song, undefined, 'do not silently discard an explicit collaborator')
  assert.equal(chooseLyricCandidate({ ...metadata, artist: 'AC/DC' }, [candidate({ artistName: 'AC' })]).song, undefined, 'slash in a band name must not become an unrelated artist')
})

test('plain sidecar can be upgraded by timed embedded or automatic online lyrics, and remains the fallback on failure', async (t) => {
  let requests = 0
  const f = await fixture(t, { metadataParser: async () => ({ common: { lyrics: [{ text: '[00:03]Timed embedded line' }] } }), fetcher: async () => { requests++; return response([candidate()]) } })
  await fs.writeFile(f.sidecar.replace('.lrc', '.txt'), 'Plain local line')
  assert.equal((await f.service.lookup(f.input)).source.kind, 'embedded')
  assert.equal(requests, 0)
  const g = await fixture(t, { fetcher: async () => response([candidate()]) })
  await fs.writeFile(g.sidecar.replace('.lrc', '.txt'), 'Plain local line')
  assert.equal((await g.service.lookup(g.input)).source.kind, 'online')
  const h = await fixture(t, { fetcher: async () => response({}, 500) })
  await fs.writeFile(h.sidecar.replace('.lrc', '.txt'), 'Plain local line')
  const fallback = await h.service.lookup(h.input)
  assert.equal(fallback.status, 'plain'); assert.equal(fallback.source.kind, 'sidecar')
})

test('manual refresh bypasses negative cache and unknown track artist may use album artist', async (t) => {
  let available = false
  let calls = 0
  const f = await fixture(t, { fetcher: async () => { calls++; return response(available ? [candidate()] : []) } })
  const input = { ...f.input, track: { ...f.input.track, artist: 'Unknown Artist' }, album: { ...f.input.album, artist: 'Test Artist' } }
  assert.equal((await f.service.lookup(input)).status, 'not-found')
  const firstCalls = calls
  available = true
  assert.equal((await f.service.lookup(input)).status, 'not-found'); assert.equal(calls, firstCalls)
  assert.equal((await f.service.lookup(input, { refresh: true })).status, 'synced'); assert.ok(calls > firstCalls)
})

test('same-song requests share transport, and aborting one consumer does not cancel another', async (t) => {
  let requests = 0
  let finish
  const f = await fixture(t, { fetcher: async (_url, { signal }) => {
    requests++
    return new Promise((resolve, reject) => {
      finish = () => resolve(response([candidate()]))
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  } })
  const controller = new AbortController()
  const first = f.service.lookup(f.input, { signal: controller.signal })
  const second = f.service.lookup(f.input)
  while (!finish || ![...f.service.inflight.values()].some((task) => task.consumers === 2)) await new Promise((resolve) => setTimeout(resolve, 1))
  controller.abort()
  assert.match((await first).message, /取消/)
  finish()
  assert.equal((await second).status, 'synced'); assert.equal(requests, 1)
})

test('a cancelled last consumer releases transport and does not poison the next song or retry', async (t) => {
  let requests = 0
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const f = await fixture(t, { fetcher: async (_url, { signal }) => {
    requests++
    if (requests > 1) return response([candidate()])
    started()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } })
  const controller = new AbortController()
  const pending = f.service.lookup(f.input, { signal: controller.signal })
  await startedPromise
  controller.abort()
  assert.equal((await pending).status, 'error')
  assert.equal((await f.service.lookup(f.input)).status, 'synced')
  assert.equal(requests, 2); assert.equal(f.service.activeRequests, 0)
})

test('provider failures are distinct from a successful search with no matching lyrics', async (t) => {
  const empty = await fixture(t, { providers: ['netease', 'lrclib', 'amll'], fetcher: async (url) => response(url.hostname === 'music.163.com' ? { code: 200, result: { songs: [] } } : []) })
  assert.equal((await empty.service.lookup(empty.input)).status, 'not-found')
  const failed = await fixture(t, { providers: ['netease', 'lrclib', 'amll'], fetcher: async (url) => url.hostname === 'music.163.com' ? response({}, 500) : response([]) })
  assert.equal((await failed.service.lookup(failed.input)).status, 'error')
})
