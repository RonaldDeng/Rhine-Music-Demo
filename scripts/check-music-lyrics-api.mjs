import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'

function silentWav() {
  const bytes = Buffer.alloc(44 + 960)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(960, 40)
  return bytes
}

async function fixture(t, { sidecar = true, provider } = {}) {
  // Local HTTP clients use node:http; provider requests are always isolated fixtures.
  let networkCalls = 0
  const queries = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    networkCalls++; queries.push(String(url))
    if (provider) return provider(new URL(url), options)
    throw new Error('External network is disabled in lyrics API tests')
  })
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-api-test-'))
  const root = path.join(temporary, 'music'), dataDir = path.join(temporary, 'index'), distDir = path.join(temporary, 'dist')
  await fs.mkdir(root); await fs.mkdir(distDir)
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>Isolated lyrics test</h1>')
  const file = path.join(root, '01 Synthetic.wav'), lyricFile = path.join(root, '01 Synthetic.lrc')
  await fs.writeFile(file, silentWav())
  if (sidecar) await fs.writeFile(lyricFile, '[ar:Synthetic Artist]\n[00:00.00]Generated first test line\n[00:00.005]Generated second test line')
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [root], metadataParser: async () => ({ common: { title: 'Synthetic Track', artist: 'Synthetic Artist', album: 'Synthetic Album' }, format: { duration: .01 } }) }).init()
  await store.scan()
  const track = store.snapshot().albums[0].tracks[0]
  const { server } = await createMusicServer({ store, distDir, autoScan: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(temporary, { recursive: true, force: true })
  })
  const port = server.address().port, origin = `http://127.0.0.1:${port}`, route = `/api/lyrics/${track.id}`
  const request = (routePath = route, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: routePath, method, headers, signal }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = text ? JSON.parse(text) : null } catch { json = null }
        resolve({ status: incoming.statusCode, headers: incoming.headers, text, json })
      })
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end(body)
  })
  return { temporary, root, dataDir, file, lyricFile, store, track, request, route, origin, queries, networkCalls: () => networkCalls }
}

test('lyrics HTTP GET reads synthetic local LRC with no provider calls or library/source mutation', async t => {
  const f = await fixture(t)
  const indexPath = path.join(f.dataDir, 'library-index.json')
  const [sourceBefore, lyricsBefore, indexBefore] = await Promise.all([fs.readFile(f.file), fs.readFile(f.lyricFile), fs.readFile(indexPath)])
  const memoryBefore = JSON.stringify(f.store.index)
  const first = await f.request()
  assert.equal(first.status, 200); assert.equal(first.json.status, 'synced')
  assert.equal(first.json.trackId, f.track.id); assert.equal(first.json.source.kind, 'sidecar')
  assert.equal(first.json.lines[1].time, .005)
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.equal(first.headers['x-content-type-options'], 'nosniff')
  assert.equal(first.text.includes(f.temporary), false)
  const explicit = await f.request(f.route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"online":true}' })
  assert.equal(explicit.status, 200); assert.equal(explicit.json.source.kind, 'sidecar', 'online authorization does not override a valid local source')
  assert.equal(f.networkCalls(), 0)
  assert.deepEqual(await fs.readFile(f.file), sourceBefore)
  assert.deepEqual(await fs.readFile(f.lyricFile), lyricsBefore)
  assert.deepEqual(await fs.readFile(indexPath), indexBefore)
  assert.equal(JSON.stringify(f.store.index), memoryBefore)
})

test('lyrics GET automatically tries online sources when local timed lyrics are missing', async t => {
  const f = await fixture(t, { sidecar: false })
  const result = await f.request()
  assert.equal(result.status, 200); assert.equal(result.json.status, 'error')
  assert.ok(f.networkCalls() > 0)
  assert.equal(result.json.trackId, f.track.id)
  assert.equal(result.text.includes(f.temporary), false)
})

function syntheticOnlineResponse(url, found) {
  const lrcSource = ['lrclib.net', 'api.amll.dev'].includes(url.hostname)
  const payload = lrcSource ? found ? [{
    id: 123, trackName: 'Synthetic Track', artistName: 'Synthetic Artist',
    albumName: 'A different compilation', duration: .01, instrumental: false,
    syncedLyrics: '[00:00.00]Generated online first line\n[00:00.005]Generated online second line', plainLyrics: '',
  }] : [] : { code: 200, result: { songs: [] }, data: { song: { list: [] } } }
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
}

test('automatic GET returns timed online lyrics, uses indexed metadata and caches without changing files', async t => {
  const f = await fixture(t, { sidecar: false, provider: url => syntheticOnlineResponse(url, true) })
  const indexFile = path.join(f.dataDir, 'library-index.json')
  const before = await fs.readFile(indexFile), audioBefore = await fs.readFile(f.file)
  const result = await f.request(`${f.route}?title=Injected&artist=Injected&url=https://example.invalid`)
  assert.equal(result.status, 200); assert.equal(result.json.status, 'synced')
  assert.equal(result.json.source.kind, 'online'); assert.equal(result.json.trackId, f.track.id)
  assert.equal(result.json.lines[1].time, .005)
  assert.ok(f.networkCalls() > 0)
  assert.ok(f.queries.every(query => !query.includes('Injected') && !query.includes('example.invalid')))
  const count = f.networkCalls()
  assert.equal((await f.request()).json.status, 'synced')
  assert.equal(f.networkCalls(), count, 'the current song can reuse a successful result')
  assert.deepEqual(await fs.readFile(indexFile), before)
  assert.deepEqual(await fs.readFile(f.file), audioBefore)
  assert.equal(await fs.stat(f.lyricFile).then(() => true, () => false), false, 'lookup never writes a sidecar')
})

test('POST retries a previous missing result while a newly added local LRC always wins', async t => {
  let found = false
  const f = await fixture(t, { sidecar: false, provider: url => syntheticOnlineResponse(url, found) })
  assert.equal((await f.request()).json.status, 'not-found')
  const count = f.networkCalls()
  found = true
  assert.equal((await f.request()).json.status, 'not-found')
  assert.equal(f.networkCalls(), count, 'missing responses are cached for ordinary reads')
  const retry = await f.request(f.route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"online":true}' })
  assert.equal(retry.json.status, 'synced'); assert.ok(f.networkCalls() > count)
  const afterRetry = f.networkCalls()
  await fs.writeFile(f.lyricFile, '[00:00]New local synthetic line')
  const local = await f.request()
  assert.equal(local.json.source.kind, 'sidecar'); assert.equal(local.json.lines[0].text, 'New local synthetic line')
  assert.equal(f.networkCalls(), afterRetry)
})

test('closing a lyric request cancels provider work and a new request can recover', { timeout: 8000 }, async t => {
  let started
  const pending = new Promise(resolve => { started = resolve })
  const providerSignals = []
  let slow = true
  const f = await fixture(t, { sidecar: false, provider: (url, options) => {
    if (!slow) return syntheticOnlineResponse(url, true)
    providerSignals.push(options.signal)
    started()
    return new Promise((resolve, reject) => {
      const stop = () => reject(options.signal.reason)
      if (options.signal.aborted) stop()
      else options.signal.addEventListener('abort', stop, { once: true })
    })
  } })
  const controller = new AbortController()
  const outgoing = f.request(f.route, { signal: controller.signal })
  const rejected = assert.rejects(outgoing, { name: 'AbortError' })
  await pending
  controller.abort()
  await rejected
  await Promise.all(providerSignals.map(signal => signal.aborted ? undefined : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))))
  assert.ok(providerSignals.length > 0 && providerSignals.every(signal => signal.aborted))
  slow = false
  assert.equal((await f.request()).json.status, 'synced', 'cancelled lookups must not populate a failure cache or block the next song')
})

test('lyrics POST requires exactly online:true and JSON content type', async t => {
  const f = await fixture(t)
  for (const body of ['{}', '{"online":false}', '{"online":"true"}', '{"online":1}', '{"online":true,"path":"/tmp/ignore-me"}', '{"online":true,"url":"https://example.invalid"}', '[]', 'null', '{broken']) {
    const result = await f.request(f.route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(result.status, 400, body)
  }
  const plain = await f.request(f.route, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"online":true}' })
  assert.equal(plain.status, 415)
  assert.equal(f.networkCalls(), 0)
})

test('lyrics HTTP routing rejects unknown/missing IDs and methods without consulting providers', async t => {
  const f = await fixture(t)
  for (const route of ['/api/lyrics/not-indexed', '/api/lyrics/', '/api/lyrics', '/api/lyrics/%2E%2E%2Foutside', '/api/lyrics/%2Ftmp%2Foutside.lrc']) {
    const result = await f.request(route)
    assert.equal(result.status, 404, route)
    assert.equal(result.json.lines, undefined)
  }
  assert.equal((await f.request(f.route, { method: 'PUT' })).status, 404)
  assert.equal((await f.request('/api/lyrics/not-indexed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"online":true}' })).status, 404)
  assert.equal(f.networkCalls(), 0)
})

test('lyrics endpoints retain loopback Host and same-origin checks on GET and POST', async t => {
  const f = await fixture(t)
  for (const method of ['GET', 'POST']) {
    const options = { method, ...(method === 'POST' ? { body: '{"online":true}' } : {}) }
    assert.equal((await f.request(f.route, { ...options, headers: { Host: 'evil.example', 'Content-Type': 'application/json' } })).status, 403)
    assert.equal((await f.request(f.route, { ...options, headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } })).status, 403)
    assert.equal((await f.request(f.route, { ...options, headers: { Origin: f.origin, 'Content-Type': 'application/json' } })).status, 200)
  }
  assert.equal((await f.request(f.route, { headers: { Origin: 'null' } })).status, 403)
  assert.equal(f.networkCalls(), 0)
})

test('client URL/path/metadata query parameters cannot replace the indexed file or override local lyrics', async t => {
  const f = await fixture(t)
  const outside = path.join(f.temporary, 'outside.lrc')
  await fs.writeFile(outside, '[00:00]Outside marker that must not be read')
  const query = new URLSearchParams({ path: outside, allowedRoot: f.temporary, url: 'https://example.invalid/lyrics', online: 'true', title: 'Injected title', artist: 'Injected artist' })
  const result = await f.request(`${f.route}?${query}`)
  assert.equal(result.status, 200); assert.equal(result.json.lines[0].text, 'Generated first test line')
  assert.equal(result.text.includes('Outside marker'), false)
  assert.equal(f.networkCalls(), 0)
})

test('out-of-root lyric symlink is rejected through the HTTP route and does not leak its target', async t => {
  const f = await fixture(t)
  const outside = path.join(f.temporary, 'outside.lrc')
  await fs.writeFile(outside, '[00:00]Outside marker that must not be read')
  await fs.rm(f.lyricFile); await fs.symlink(outside, f.lyricFile)
  const result = await f.request()
  assert.equal(result.status, 200); assert.equal(result.json.status, 'error')
  assert.equal(result.text.includes('Outside marker'), false); assert.equal(result.text.includes(f.temporary), false)
  assert.equal(f.networkCalls(), 0)
})

test('removing the configured music root revokes lyrics access for an existing ID', async t => {
  const f = await fixture(t)
  f.store.config.roots = []
  const result = await f.request()
  assert.equal(result.status, 404)
  assert.equal(f.networkCalls(), 0)
})
