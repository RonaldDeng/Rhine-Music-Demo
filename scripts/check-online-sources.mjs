import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  InternetArchiveSource, OnlineLibrary, SubsonicSource, luceneTerms, normalizeSubsonicConfig, onlineAlbumId, onlineTrackId,
} from './online-sources.mjs'

// Everything below talks to fake servers on 127.0.0.1; no test touches the real internet.
const AUDIO = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }))
  })
}
const close = (fake) => new Promise((resolve) => { fake.server.close(resolve); fake.server.closeAllConnections() })
const sendJson = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }

function serveAudio(request, response) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (!range) {
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes' })
    return response.end(AUDIO)
  }
  const start = Number(range[1])
  const end = range[2] ? Number(range[2]) : AUDIO.length - 1
  response.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`, 'Accept-Ranges': 'bytes' })
  response.end(AUDIO.subarray(start, end + 1))
}

function fakeArchive() {
  const seen = []
  return listen((request, response) => {
    const url = new URL(request.url, 'http://x')
    seen.push({ path: url.pathname, query: url.searchParams, headers: request.headers })
    if (url.pathname === '/advancedsearch.php') {
      return sendJson(response, { response: { numFound: 3, docs: [
        { identifier: 'jazz-night', title: 'Jazz Night', creator: ['Ann', 'Bob'], year: '1959', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
        { identifier: '../escape', title: 'Bad id' },
        { identifier: 'quiet-piece', title: ['Quiet Piece'] },
      ] } })
    }
    if (url.pathname === '/metadata/jazz-night') {
      return sendJson(response, {
        metadata: { title: 'Jazz Night', creator: 'Ann', year: '1959', description: '<p>Live &amp; direct</p><script>alert(1)</script>', subject: 'jazz; live', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
        files: [
          { name: 't2.mp3', format: 'VBR MP3', length: '03:35', title: 'Second', track: '2' },
          { name: 't2.ogg', format: 'Ogg Vorbis', length: '215.3' },
          { name: 't2.flac', format: 'Flac', length: '215.3' },
          { name: 't1.mp3', format: 'MP3', length: '61.5', title: 'First', track: '1/2' },
          { name: 'sub dir/t3.ogg', format: 'Ogg Vorbis', length: '10' },
          { name: 'cover.png', format: 'PNG' },
          { name: 'secret.mp3', format: 'VBR MP3', private: 'true' },
          { name: 'notes.xml', format: 'Metadata' },
        ],
      })
    }
    if (url.pathname === '/metadata/restricted') return sendJson(response, { metadata: { title: 'Lending', 'access-restricted-item': 'true' }, files: [{ name: 'a.mp3', format: 'VBR MP3' }] })
    if (url.pathname === '/metadata/silent') return sendJson(response, { metadata: { title: 'Silent' }, files: [{ name: 'a.png', format: 'PNG' }] })
    if (url.pathname.startsWith('/metadata/')) return sendJson(response, {})
    if (url.pathname.startsWith('/download/jazz-night/')) {
      response.writeHead(302, { Location: `/storage/${url.pathname.slice('/download/jazz-night/'.length)}` })
      return response.end()
    }
    if (url.pathname.startsWith('/storage/')) return serveAudio(request, response)
    if (url.pathname === '/download/evil/a.mp3') {
      response.writeHead(302, { Location: `http://localhost:${request.socket.localPort}/storage/a.mp3` })
      return response.end()
    }
    if (url.pathname === '/download/html/a.mp3') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      return response.end('<script>alert(1)</script>')
    }
    if (url.pathname === '/services/img/jazz-night') {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      return response.end(PNG)
    }
    if (url.pathname === '/services/img/html') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      return response.end('<svg onload="alert(1)"/>')
    }
    response.writeHead(404).end()
  }).then((fake) => Object.assign(fake, { seen }))
}

function fakeSubsonic({ password = 'secret' } = {}) {
  const seen = []
  return listen((request, response) => {
    const url = new URL(request.url, 'http://x')
    seen.push(url)
    const salt = url.searchParams.get('s') ?? ''
    const ok = url.searchParams.get('u') === 'me' && url.searchParams.get('t') === createHash('md5').update(password + salt).digest('hex')
    const wrap = (body) => sendJson(response, { 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'fake', ...body } })
    if (url.pathname === '/music/rest/ping.view') return ok ? wrap({}) : sendJson(response, { 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } })
    if (!ok) return sendJson(response, { 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } })
    if (url.pathname === '/music/rest/search3.view') return wrap({ searchResult3: { album: [{ id: 'al-1', name: 'Home Album', artist: 'Me', year: 2001 }] } })
    if (url.pathname === '/music/rest/getAlbum.view') {
      return wrap({ album: { id: 'al-1', name: 'Home Album', artist: 'Me', year: 2001, coverArt: 'cv-1', genre: 'Rock', song: [
        { id: 's-2', title: 'Two', track: 2, suffix: 'wma', duration: 100 },
        { id: 's-1', title: 'One', track: 1, suffix: 'flac', duration: 200.4, contentType: 'audio/flac' },
      ] } })
    }
    if (url.pathname === '/music/rest/stream.view') {
      response.writeHead(200, { 'Content-Type': url.searchParams.get('format') === 'mp3' ? 'audio/mpeg' : 'audio/flac' })
      return response.end(AUDIO.subarray(0, 64))
    }
    if (url.pathname === '/music/rest/getCoverArt.view') {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      return response.end(PNG)
    }
    response.writeHead(404).end()
  }).then((fake) => Object.assign(fake, { seen }))
}

async function withTemp(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-'))
  try { return await run(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('luceneTerms strips query syntax and rejects an empty search', () => {
  assert.deepEqual(luceneTerms('  miles AND davis  "kind of blue" -(x) OR creator:evil* '), ['miles', 'davis', 'kind', 'of', 'blue', 'x', 'creator', 'evil'])
  assert.throws(() => luceneTerms('  +-() "" '), /请输入搜索词/)
  assert.equal(luceneTerms('a b c d e f g h i j k').length, 8)
})

test('Internet Archive search builds a bounded query and drops malformed identifiers', async () => {
  const archive = await fakeArchive()
  try {
    const source = new InternetArchiveSource({ baseUrl: archive.url })
    const result = await source.search('jazz night', { collection: 'netlabels', page: 2, limit: 10 })
    const request = archive.seen.find((entry) => entry.path === '/advancedsearch.php')
    assert.equal(request.query.get('q'), 'mediatype:audio AND collection:netlabels AND (jazz AND night)')
    assert.equal(request.query.get('rows'), '10')
    assert.equal(request.query.get('page'), '2')
    assert.match(request.headers['user-agent'], /RhineMusicDemo/)
    assert.equal(result.total, 3)
    assert.deepEqual(result.items.map((item) => item.ref), ['jazz-night', 'quiet-piece'])
    assert.equal(result.items[0].artist, 'Ann / Bob')
    assert.equal(result.items[0].year, 1959)
    assert.equal(result.items[1].artist, '未知艺术家')
    await assert.rejects(source.search('x', { collection: 'a b;c' }), /不支持的合集/)
  } finally { await close(archive) }
})

test('Internet Archive album keeps one playable file per track, preferring MP3, and cleans metadata', async () => {
  const archive = await fakeArchive()
  try {
    const source = new InternetArchiveSource({ baseUrl: archive.url })
    const album = await source.album('jazz-night')
    assert.deepEqual(album.tracks.map((track) => [track.ref, track.title, track.format, track.duration, track.mime]), [
      ['t1.mp3', 'First', 'MP3', 61.5, 'audio/mpeg'],
      ['t2.mp3', 'Second', 'MP3', 215, 'audio/mpeg'],
      ['sub dir/t3.ogg', 't3', 'OGG', 10, 'audio/ogg'],
    ])
    assert.equal(album.tracks[0].trackNumber, 1)
    assert.equal(album.description, 'Live & direct\nalert(1)')
    assert.deepEqual(album.genres, ['jazz', 'live'])
    assert.equal(album.year, 1959)
    assert.equal(album.license, 'https://creativecommons.org/licenses/by/4.0/')
    assert.ok(!album.description.includes('<'))
    assert.equal(source.audioRequest(album, album.tracks[2]).url, `${archive.url}/download/jazz-night/sub%20dir/t3.ogg`)
    assert.equal(source.coverRequest(album).url, `${archive.url}/services/img/jazz-night`)
    await assert.rejects(source.album('restricted'), (error) => error.status === 403)
    await assert.rejects(source.album('silent'), (error) => error.status === 422)
    await assert.rejects(source.album('nothing-here'), (error) => error.status === 404)
    await assert.rejects(source.album('../etc'), (error) => error.status === 400)
  } finally { await close(archive) }
})

test('the Internet Archive host allow-list accepts only archive.org and its subdomains over https', () => {
  const source = new InternetArchiveSource()
  for (const good of ['https://archive.org/download/a/b.mp3', 'https://ia800000.us.archive.org/1/items/a/b.mp3', 'https://dn721801.ca.archive.org/0/items/a/b.mp3'])
    assert.equal(source.allow(new URL(good)), true, good)
  for (const bad of ['http://archive.org/x', 'https://evilarchive.org/x', 'https://archive.org.evil.com/x', 'https://archive.org:8443/x', 'https://user:pw@archive.org/x', 'https://127.0.0.1/x', 'https://notarchive.org/x'])
    assert.equal(source.allow(new URL(bad)), false, bad)
})

test('Subsonic configuration is normalised and never accepts credentials inside the address', () => {
  assert.deepEqual(normalizeSubsonicConfig({ baseUrl: ' http://192.168.1.2:4533/music/?x=1#y ', username: ' me ', password: 'p' }), { baseUrl: 'http://192.168.1.2:4533/music', username: 'me', password: 'p' })
  assert.throws(() => normalizeSubsonicConfig({ baseUrl: 'ftp://host', username: 'me' }), /http/)
  assert.throws(() => normalizeSubsonicConfig({ baseUrl: 'http://me:pw@host', username: 'me' }), /分开填写/)
  assert.throws(() => normalizeSubsonicConfig({ baseUrl: 'nonsense', username: 'me' }), /服务地址/)
  assert.throws(() => normalizeSubsonicConfig({ baseUrl: 'http://host', username: ' ' }), /账号/)
})

test('Subsonic source authenticates with a salted token, maps albums and transcodes unsupported formats', async () => {
  const fake = await fakeSubsonic()
  try {
    const source = new SubsonicSource({ baseUrl: `${fake.url}/music`, username: 'me', password: 'secret' })
    assert.equal((await source.ping()).server, 'fake')
    const result = await source.search('home')
    assert.deepEqual(result.items, [{ ref: 'al-1', title: 'Home Album', artist: 'Me', year: 2001 }])
    const album = await source.album('al-1')
    assert.deepEqual(album.tracks.map((track) => [track.ref, track.format, track.lossless, !!track.transcode]), [['s-1', 'FLAC', true, false], ['s-2', 'MP3', false, true]])
    assert.deepEqual(album.genres, ['Rock'])
    assert.equal(new URL(source.audioRequest(album, album.tracks[1]).url).searchParams.get('format'), 'mp3')
    assert.equal(new URL(source.audioRequest(album, album.tracks[0]).url).searchParams.get('format'), null)
    assert.equal(new URL(source.coverRequest(album).url).searchParams.get('id'), 'cv-1')
    for (const url of fake.seen) assert.equal(url.searchParams.get('p'), null, 'plain password must never be sent')
    const wrong = new SubsonicSource({ baseUrl: `${fake.url}/music`, username: 'me', password: 'nope' })
    await assert.rejects(wrong.ping(), (error) => error.status === 401)
    assert.equal(source.allow(new URL(`${fake.url}/anything`)), true)
    assert.equal(source.allow(new URL('http://localhost:1/x')), false)
  } finally { await close(fake) }
})

test('the online shelf saves album snapshots, exposes the local-library JSON shape and survives a restart', async () => {
  const archive = await fakeArchive()
  try {
    await withTemp(async (dir) => {
      const online = new OnlineLibrary({ dataDir: dir, internetArchiveUrl: archive.url })
      assert.deepEqual((await online.snapshot()).albums, [])
      const search = await online.search('internetarchive', 'jazz')
      assert.deepEqual(search.items.map((item) => item.added), [false, false])
      const added = await online.add('internetarchive', 'jazz-night')
      assert.equal(added.id, onlineAlbumId('internetarchive', 'jazz-night'))
      assert.equal(added.tracks, 3)
      assert.equal((await online.search('internetarchive', 'jazz')).items[0].added, true)
      await online.add('internetarchive', 'jazz-night')
      const snapshot = await online.snapshot()
      assert.equal(snapshot.albums.length, 1)
      const [album] = snapshot.albums
      assert.equal(album.genreId, 'online-internetarchive')
      assert.deepEqual(snapshot.genres, [{ id: 'online-internetarchive', name: 'Internet Archive', albumCount: 1 }])
      assert.equal(album.coverUrl, `/api/online/artwork/${album.id}`)
      assert.equal(album.tracks[0].audioUrl, `/api/online/audio/${onlineTrackId(album.id, 't1.mp3')}`)
      assert.equal(album.tracks[0].albumId, album.id)
      assert.equal(album.tracks.every((track) => track.browserPlayable), true)
      assert.match(album.localNote, /Internet Archive/)
      assert.equal(album.descriptionSource.license, 'https://creativecommons.org/licenses/by/4.0/')
      assert.deepEqual(snapshot.roots, [])
      assert.equal(snapshot.scan.running, false)
      const json = JSON.stringify(snapshot)
      // The item page is a deliberate attribution link; stream and cover addresses must stay on the server.
      assert.ok(!json.includes('/download/') && !json.includes('/services/img/'), 'remote media addresses must not leak into the browser-facing snapshot')

      const again = new OnlineLibrary({ dataDir: dir, internetArchiveUrl: archive.url })
      assert.equal((await again.snapshot()).albums.length, 1)
      assert.ok((await again.trackTarget(album.tracks[1].id)).target.url.endsWith('/download/jazz-night/t2.mp3'))
      assert.equal(await again.trackTarget('onlinetrack-unknown'), null)
      assert.ok((await again.coverTarget(album.id)).target.url.endsWith('/services/img/jazz-night'))
      await assert.rejects(again.remove('online-nothing'), (error) => error.status === 404)
      await again.remove(album.id)
      assert.deepEqual((await new OnlineLibrary({ dataDir: dir }).snapshot()).albums, [])
    })
  } finally { await close(archive) }
})

test('a damaged online.json is reported and treated as empty, not as a crash', async () => {
  await withTemp(async (dir) => {
    await fs.writeFile(path.join(dir, 'online.json'), '{ not json')
    const online = new OnlineLibrary({ dataDir: dir })
    assert.deepEqual((await online.snapshot()).albums, [])
    assert.match((await online.sources()).error, /在线曲库文件无法读取/)
  })
})

test('the Subsonic password is stored only in the data directory and is never returned', async () => {
  const fake = await fakeSubsonic()
  try {
    await withTemp(async (dir) => {
      const online = new OnlineLibrary({ dataDir: dir })
      await assert.rejects(online.search('subsonic', 'x'), (error) => error.status === 409)
      const config = { baseUrl: `${fake.url}/music`, username: 'me', password: 'secret' }
      assert.equal((await online.testSubsonic(config)).server, 'fake')
      const saved = await online.configureSubsonic(config)
      assert.deepEqual(saved.subsonic, { baseUrl: `${fake.url}/music`, username: 'me', passwordSet: true })
      assert.ok(!JSON.stringify(saved).includes('secret'))
      // Saving again with an empty password keeps the stored one, but only for the same address and account.
      await online.configureSubsonic({ baseUrl: `${fake.url}/music`, username: 'me', password: '' })
      assert.equal((await online.testSubsonic({ baseUrl: `${fake.url}/music`, username: 'me', password: '' })).server, 'fake')
      await assert.rejects(online.testSubsonic({ baseUrl: `${fake.url}/music`, username: 'other', password: '' }), (error) => error.status === 401)
      const added = await online.add('subsonic', 'al-1')
      const snapshot = await online.snapshot()
      assert.equal(snapshot.albums[0].id, added.id)
      assert.equal(snapshot.albums[0].genreId, 'online-subsonic')
      assert.equal(JSON.stringify(snapshot).includes('secret'), false)
      assert.equal(JSON.stringify(snapshot).includes(fake.url), false)
      assert.match(await fs.readFile(path.join(dir, 'online.json'), 'utf8'), /secret/)
      assert.equal((await online.configureSubsonic({ clear: true })).subsonic, undefined)
    })
  } finally { await close(fake) }
})

// The HTTP surface needs the full server (music-metadata and friends), so it only runs where dependencies are installed.
let createMusicServer
try { ({ createMusicServer } = await import('./music-server.mjs')) } catch { /* dependencies missing */ }

test('the local server proxies audio and covers, honours Range and refuses untrusted redirects', { skip: !createMusicServer && 'music-server dependencies are not installed' }, async () => {
  const archive = await fakeArchive()
  await withTemp(async (dir) => {
    const online = new OnlineLibrary({ dataDir: dir, internetArchiveUrl: archive.url })
    const { server } = await createMusicServer({ store: {}, online, autoScan: false })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    try {
      assert.equal((await (await fetch(`${base}/api/online/library`)).json()).albums.length, 0)
      const search = await (await fetch(`${base}/api/online/search?source=internetarchive&q=jazz`)).json()
      assert.equal(search.items[0].ref, 'jazz-night')
      assert.equal((await fetch(`${base}/api/online/search?source=internetarchive&q=%20`)).status, 400)
      assert.equal((await fetch(`${base}/api/online/search?source=nope&q=a`)).status, 400)
      assert.equal((await fetch(`${base}/api/online/search?source=subsonic&q=a`)).status, 409)

      assert.equal((await post('/api/online/albums', { source: 'internetarchive', ref: 'jazz-night' }, { Origin: 'http://evil.example' })).status, 403, 'cross-site writes are refused')
      assert.equal((await fetch(`${base}/api/online/albums`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
      assert.equal((await post('/api/online/albums', { source: 'internetarchive', ref: 5 })).status, 400)
      const added = await post('/api/online/albums', { source: 'internetarchive', ref: 'jazz-night' })
      assert.equal(added.status, 200)
      const [album] = (await (await fetch(`${base}/api/online/library`)).json()).albums

      const whole = await fetch(base + album.tracks[0].audioUrl)
      assert.equal(whole.status, 200)
      assert.equal(whole.headers.get('content-type'), 'audio/mpeg')
      assert.equal(whole.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(Buffer.from(await whole.arrayBuffer()), AUDIO)
      const part = await fetch(base + album.tracks[0].audioUrl, { headers: { Range: 'bytes=100-199' } })
      assert.equal(part.status, 206)
      assert.equal(part.headers.get('content-range'), `bytes 100-199/${AUDIO.length}`)
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), AUDIO.subarray(100, 200))
      assert.equal((await fetch(base + album.tracks[0].audioUrl, { method: 'HEAD' })).status, 200)

      const cover = await fetch(base + album.coverUrl)
      assert.equal(cover.headers.get('content-type'), 'image/png')
      assert.deepEqual(Buffer.from(await cover.arrayBuffer()), PNG)
      assert.equal((await fetch(`${base}/api/online/audio/onlinetrack-unknown`)).status, 404)

      // A hostile or broken upstream: foreign redirect, non-audio body, non-image cover.
      for (const [name, ref, status] of [['evil', 'evil', 502], ['html', 'html', 502]]) {
        online.state.albums.push({ id: `online-${name}`, source: 'internetarchive', addedAt: '', album: { ref, title: name, artist: 'x', coverRef: ref, tracks: [{ ref: 'a.mp3', title: 'a', artist: 'x', mime: 'audio/mpeg' }] } })
        const track = (await online.snapshot()).albums.find((entry) => entry.id === `online-${name}`).tracks[0]
        assert.equal((await fetch(base + track.audioUrl)).status, status, name)
      }
      assert.equal((await fetch(`${base}/api/online/artwork/online-html`)).status, 502, 'svg covers are refused')

      assert.equal((await post('/api/online/albums/remove', { id: album.id })).status, 200)
      assert.equal((await post('/api/online/albums/remove', { id: album.id })).status, 404)
      assert.equal((await fetch(`${base}/api/online/unknown`)).status, 404)
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  }).finally(() => close(archive))
})
