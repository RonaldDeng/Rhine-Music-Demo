// Online music library for the separate "online shelf".
//
// A *source* is a small object that knows how to search a catalogue, describe one album and tell the
// local server which remote URL carries a track or a cover. The server never hands remote URLs to
// the browser: audio and covers are streamed through /api/online/audio|artwork, and every hop of
// every request is checked against the source's own host allow-list (`source.allow(url)`).
//
// Source contract (duck-typed):
//   id, name
//   allow(url: URL): boolean                          hosts this source may talk to (redirects included)
//   search(query, { page, limit, collection }):       { total, page, items: [{ ref, title, artist, year, license, url }] }
//   album(ref):                                       { ref, title, artist, year, description, license, url, genres, coverRef, tracks: [{ ref, title, artist, trackNumber, discNumber, duration, format, codec, lossless, mime }] }
//   audioRequest(album, track):                       { url, headers? }
//   coverRequest(album):                              { url, headers? } | null
//
// Built in: Internet Archive (public, per-item licences) and a Subsonic/OpenSubsonic client for the
// user's own server (Navidrome, Jellyfin with the Subsonic plugin, Airsonic ...).
// There is deliberately no resolver for commercial platforms: nothing here fetches audio the user
// has no right to stream.
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const USER_AGENT = 'RhineMusicDemo/0.3 (+https://github.com/MT-gar/Rhine-Music-Demo-Win-)'
export const ONLINE_LIMITS = { albums: 500, tracksPerAlbum: 300, searchRows: 20, jsonBytes: 12 * 1024 * 1024, connectTimeout: 15_000 }
const IA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SUBSONIC_ID = /^[\w.:@=+-]{1,200}$/
const IA_COLLECTIONS = /^[a-z0-9][a-z0-9_-]{0,59}$/i

export function httpError(status, message, cause) {
  return Object.assign(new Error(message), { status, ...(cause ? { cause } : {}) })
}

const sha1 = (...parts) => createHash('sha1').update(parts.join('\0')).digest('hex')
const first = (value) => Array.isArray(value) ? value[0] : value
const asArray = (value) => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
const clean = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const isIp = (host) => /^[\d.]+$/.test(host) || host.includes(':')

function plainText(html, max = 1500) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max)
}

function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (text.includes(':')) return text.split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0)
  const seconds = Number(text)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

function parseYear(value) {
  const match = /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(first(value) ?? ''))
  return match ? Number(match[1]) : undefined
}

/** fetch() that follows redirects by hand so that every hop is re-checked against `allow`. */
export async function guardedFetch(start, { headers = {}, allow, signal, timeout = ONLINE_LIMITS.connectTimeout, maxRedirects = 5 } = {}) {
  let url = new URL(start)
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!allow(url)) throw httpError(502, '来源返回了不受信任的地址，已拒绝连接')
    const timer = setTimeout(() => controller.abort(), timeout)
    let response
    try {
      response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'manual', signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw httpError(504, '连接来源超时', error)
      throw httpError(502, `无法连接来源（${error.cause?.code ?? error.message}）`, error)
    } finally {
      clearTimeout(timer)
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => {})
      url = new URL(response.headers.get('location'), url)
      continue
    }
    return { response, abort: () => controller.abort() }
  }
  throw httpError(502, '来源重定向次数过多')
}

async function fetchJson(url, { headers, allow, signal } = {}) {
  const { response } = await guardedFetch(url, { headers: { Accept: 'application/json', ...headers }, allow, signal })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw httpError(response.status === 404 ? 404 : 502, response.status === 404 ? '来源中没有找到这个条目' : `来源返回 ${response.status}`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > ONLINE_LIMITS.jsonBytes) throw httpError(502, '来源返回的数据过大')
  const text = await response.text()
  if (text.length > ONLINE_LIMITS.jsonBytes) throw httpError(502, '来源返回的数据过大')
  try { return JSON.parse(text) } catch { throw httpError(502, '来源返回的不是有效数据') }
}

// ---------------------------------------------------------------------------------------------
// Internet Archive
// ---------------------------------------------------------------------------------------------
const IA_AUDIO = [
  { test: (f) => /mp3$/i.test(f), rank: (f) => /^VBR MP3$/i.test(f) ? 0 : /^MP3$/i.test(f) ? 1 : 2, label: 'MP3', mime: 'audio/mpeg', codec: 'MP3', lossless: false },
  { test: (f) => /^Ogg Vorbis$/i.test(f), rank: () => 3, label: 'OGG', mime: 'audio/ogg', codec: 'Vorbis', lossless: false },
  { test: (f) => /^(24bit )?flac$/i.test(f), rank: () => 4, label: 'FLAC', mime: 'audio/flac', codec: 'FLAC', lossless: true },
]
const IA_EXT_MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }

export function luceneTerms(query) {
  const words = clean(query, 120)
    .replace(/[+\-!(){}[\]^"~*?:\\/&|<>=]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !/^(and|or|not|to)$/i.test(word))
    .slice(0, 8)
  if (!words.length) throw httpError(400, '请输入搜索词')
  return words
}

export class InternetArchiveSource {
  id = 'internetarchive'
  name = 'Internet Archive'

  constructor({ baseUrl = 'https://archive.org' } = {}) {
    this.base = new URL(baseUrl)
  }

  allow(url) {
    if (url.protocol !== this.base.protocol || url.username || url.password) return false
    if (url.hostname === this.base.hostname) return url.port === this.base.port
    return !isIp(this.base.hostname) && url.hostname.endsWith(`.${this.base.hostname}`) && url.port === ''
  }

  async search(query, { page = 1, limit = ONLINE_LIMITS.searchRows, collection, signal } = {}) {
    const terms = luceneTerms(query)
    if (collection && !IA_COLLECTIONS.test(collection)) throw httpError(400, '不支持的合集')
    page = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), 50)
    limit = Math.min(Math.max(1, Math.trunc(Number(limit)) || ONLINE_LIMITS.searchRows), 50)
    const q = ['mediatype:audio', collection ? `collection:${collection}` : '', `(${terms.join(' AND ')})`].filter(Boolean).join(' AND ')
    const url = new URL('/advancedsearch.php', this.base)
    url.searchParams.set('q', q)
    for (const field of ['identifier', 'title', 'creator', 'year', 'licenseurl', 'downloads']) url.searchParams.append('fl[]', field)
    url.searchParams.set('rows', String(limit))
    url.searchParams.set('page', String(page))
    url.searchParams.set('output', 'json')
    url.searchParams.append('sort[]', 'downloads desc')
    const data = await fetchJson(url, { allow: (u) => this.allow(u), signal })
    const docs = asArray(data?.response?.docs)
    return {
      total: Number(data?.response?.numFound) || docs.length,
      page,
      items: docs.filter((doc) => IA_ID.test(String(doc?.identifier ?? ''))).map((doc) => ({
        ref: doc.identifier,
        title: clean(first(doc.title)) || doc.identifier,
        artist: clean(asArray(doc.creator).slice(0, 3).join(' / ')) || '未知艺术家',
        year: parseYear(doc.year),
        license: clean(first(doc.licenseurl), 300) || undefined,
        url: new URL(`/details/${encodeURIComponent(doc.identifier)}`, this.base).href,
      })),
    }
  }

  async album(ref, { signal } = {}) {
    if (!IA_ID.test(String(ref))) throw httpError(400, '无效的条目标识')
    const data = await fetchJson(new URL(`/metadata/${encodeURIComponent(ref)}`, this.base), { allow: (u) => this.allow(u), signal })
    const meta = data?.metadata
    if (!meta || data.is_dark) throw httpError(404, '来源中没有找到这个条目')
    if (String(meta['access-restricted-item']).toLowerCase() === 'true') throw httpError(403, '这个条目是受限借阅内容，不能在此播放')
    const albumArtist = clean(asArray(meta.creator).slice(0, 3).join(' / ')) || '未知艺术家'
    const stems = new Map()
    for (const file of asArray(data.files)) {
      const name = String(file?.name ?? '')
      if (!name || String(file.private).toLowerCase() === 'true') continue
      const kind = IA_AUDIO.find((entry) => entry.test(String(file.format ?? '')))
      if (!kind) continue
      const stem = name.replace(/\.[^./]+$/, '').toLowerCase()
      const rank = kind.rank(file.format)
      const current = stems.get(stem)
      if (!current || rank < current.rank) stems.set(stem, { file, kind, rank })
    }
    const tracks = [...stems.values()].map(({ file, kind }, index) => {
      const stem = String(file.name).replace(/\.[^./]+$/, '').split('/').pop()
      const ext = path.extname(String(file.name)).toLowerCase()
      return {
        ref: String(file.name),
        title: clean(file.title) || clean(stem.replace(/[_]+/g, ' ')) || `Track ${index + 1}`,
        artist: clean(file.artist || file.creator) || albumArtist,
        trackNumber: Number.parseInt(String(file.track ?? ''), 10) || undefined,
        discNumber: 1,
        duration: parseDuration(file.length),
        format: kind.label, codec: kind.codec, lossless: kind.lossless,
        mime: IA_EXT_MIME[ext] ?? kind.mime,
      }
    })
    tracks.sort((a, b) => (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999) || a.ref.localeCompare(b.ref, 'en', { numeric: true }))
    if (!tracks.length) throw httpError(422, '这个条目没有可在浏览器播放的音频（MP3 / Ogg / FLAC）')
    return {
      ref,
      title: clean(first(meta.title)) || ref,
      artist: albumArtist,
      year: parseYear(meta.year) ?? parseYear(meta.date) ?? parseYear(meta.publicdate),
      description: plainText(asArray(meta.description).join('\n\n')) || undefined,
      license: clean(first(meta.licenseurl), 300) || undefined,
      url: new URL(`/details/${encodeURIComponent(ref)}`, this.base).href,
      genres: asArray(meta.subject).flatMap((value) => String(value).split(/[;,]/)).map((value) => clean(value, 40)).filter(Boolean).slice(0, 4),
      coverRef: ref,
      tracks: tracks.slice(0, ONLINE_LIMITS.tracksPerAlbum),
    }
  }

  audioRequest(album, track) {
    const file = String(track.ref).split('/').map(encodeURIComponent).join('/')
    return { url: new URL(`/download/${encodeURIComponent(album.ref)}/${file}`, this.base).href }
  }

  coverRequest(album) {
    return { url: new URL(`/services/img/${encodeURIComponent(album.ref)}`, this.base).href }
  }
}

// ---------------------------------------------------------------------------------------------
// Subsonic / OpenSubsonic (the user's own server)
// ---------------------------------------------------------------------------------------------
const BROWSER_SUFFIX = new Set(['mp3', 'ogg', 'oga', 'opus', 'flac', 'wav', 'm4a', 'aac'])
const LOSSLESS_SUFFIX = new Set(['flac', 'wav', 'alac', 'ape', 'wv'])

export function normalizeSubsonicConfig({ baseUrl, username, password }) {
  let url
  try { url = new URL(String(baseUrl ?? '').trim()) } catch { throw httpError(400, '请填写完整的服务地址，例如 http://192.168.1.10:4533') }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, '服务地址必须以 http:// 或 https:// 开头')
  if (url.username || url.password) throw httpError(400, '请不要把账号密码写进地址，分开填写')
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  const user = clean(username, 120)
  if (!user) throw httpError(400, '请填写账号')
  return { baseUrl: url.href.replace(/\/$/, ''), username: user, password: String(password ?? '').slice(0, 500) }
}

export class SubsonicSource {
  id = 'subsonic'
  name = '自有音乐服务'

  constructor(config) {
    const normalized = normalizeSubsonicConfig(config)
    this.base = new URL(`${normalized.baseUrl}/`)
    this.username = normalized.username
    this.password = normalized.password
  }

  allow(url) {
    return url.origin === this.base.origin && !url.username && !url.password
  }

  endpoint(method, params = {}) {
    const salt = randomBytes(8).toString('hex')
    const url = new URL(`rest/${method}.view`, this.base)
    url.search = new URLSearchParams({
      u: this.username, t: createHash('md5').update(this.password + salt).digest('hex'), s: salt,
      v: '1.16.1', c: 'rhine-music', f: 'json', ...params,
    }).toString()
    return url
  }

  async call(method, params, signal) {
    const data = await fetchJson(this.endpoint(method, params), { allow: (u) => this.allow(u), signal })
    const body = data?.['subsonic-response']
    if (!body) throw httpError(502, '这个地址不像 Subsonic 兼容服务')
    if (body.status !== 'ok') throw httpError(body.error?.code === 40 || body.error?.code === 41 ? 401 : 502, `服务返回错误：${clean(body.error?.message, 120) || '未知'}`)
    return body
  }

  async ping({ signal } = {}) {
    const body = await this.call('ping', {}, signal)
    return { version: clean(body.version, 20), server: clean(body.type, 40) || undefined }
  }

  async search(query, { page = 1, limit = ONLINE_LIMITS.searchRows, signal } = {}) {
    const text = clean(query, 120)
    if (!text) throw httpError(400, '请输入搜索词')
    page = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), 50)
    limit = Math.min(Math.max(1, Math.trunc(Number(limit)) || ONLINE_LIMITS.searchRows), 50)
    const body = await this.call('search3', { query: text, artistCount: '0', songCount: '0', albumCount: String(limit), albumOffset: String((page - 1) * limit) }, signal)
    const albums = asArray(body.searchResult3?.album).filter((album) => SUBSONIC_ID.test(String(album?.id ?? '')))
    return {
      total: null, page, hasMore: albums.length >= limit,
      items: albums.map((album) => ({ ref: String(album.id), title: clean(album.name ?? album.title) || String(album.id), artist: clean(album.artist) || '未知艺术家', year: parseYear(album.year) })),
    }
  }

  async album(ref, { signal } = {}) {
    if (!SUBSONIC_ID.test(String(ref))) throw httpError(400, '无效的专辑标识')
    const body = await this.call('getAlbum', { id: String(ref) }, signal)
    const album = body.album
    if (!album) throw httpError(404, '服务中没有找到这张专辑')
    const tracks = asArray(album.song).filter((song) => song?.id && SUBSONIC_ID.test(String(song.id)) && song.isVideo !== true).map((song, index) => {
      const suffix = String(song.suffix ?? '').toLowerCase()
      const playable = BROWSER_SUFFIX.has(suffix)
      return {
        ref: String(song.id),
        title: clean(song.title) || `Track ${index + 1}`,
        artist: clean(song.artist) || clean(album.artist) || '未知艺术家',
        trackNumber: Number(song.track) || undefined,
        discNumber: Number(song.discNumber) || 1,
        duration: parseDuration(song.duration),
        format: (playable ? suffix : 'MP3').toUpperCase(), codec: playable ? suffix.toUpperCase() : 'MP3 (转码)',
        lossless: playable && LOSSLESS_SUFFIX.has(suffix),
        transcode: !playable,
        mime: playable ? clean(song.contentType, 60) || undefined : 'audio/mpeg',
      }
    })
    tracks.sort((a, b) => a.discNumber - b.discNumber || (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999))
    if (!tracks.length) throw httpError(422, '这张专辑没有可播放的歌曲')
    return {
      ref: String(ref),
      title: clean(album.name ?? album.title) || String(ref),
      artist: clean(album.artist) || '未知艺术家',
      year: parseYear(album.year),
      url: undefined, license: undefined, description: undefined,
      genres: [...new Set([...asArray(album.genres).map((genre) => genre?.name ?? genre), album.genre].map((value) => clean(value, 40)).filter(Boolean))].slice(0, 4),
      coverRef: album.coverArt && SUBSONIC_ID.test(String(album.coverArt)) ? String(album.coverArt) : undefined,
      tracks: tracks.slice(0, ONLINE_LIMITS.tracksPerAlbum),
    }
  }

  audioRequest(album, track) {
    return { url: this.endpoint('stream', { id: track.ref, ...(track.transcode ? { format: 'mp3', maxBitRate: '320' } : {}) }).href }
  }

  coverRequest(album) {
    return album.coverRef ? { url: this.endpoint('getCoverArt', { id: album.coverRef, size: '800' }).href } : null
  }
}

// ---------------------------------------------------------------------------------------------
// Streaming proxy (audio and covers)
// ---------------------------------------------------------------------------------------------
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export async function streamRemote(request, response, target, { allow, kind, mime, cache }) {
  const controller = new AbortController()
  response.once('close', () => controller.abort())
  const headers = { ...(target.headers ?? {}) }
  if (kind === 'audio' && /^bytes=\d*-\d*$/.test(request.headers.range ?? '')) headers.Range = request.headers.range
  const { response: upstream } = await guardedFetch(target.url, { headers, allow, signal: controller.signal })
  const cancel = () => upstream.body?.cancel().catch(() => {})
  if (upstream.status === 404) { await cancel(); throw httpError(404, '来源中没有这个文件') }
  if (![200, 206, 416].includes(upstream.status)) { await cancel(); throw httpError(502, `来源返回 ${upstream.status}`) }
  const upstreamType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  let contentType
  if (kind === 'image') {
    if (!IMAGE_TYPES.has(upstreamType)) { await cancel(); throw httpError(502, '来源返回的封面不是图片') }
    contentType = upstreamType
  } else {
    if (!(upstreamType.startsWith('audio/') || ['application/ogg', 'application/octet-stream', 'video/ogg', 'binary/octet-stream'].includes(upstreamType))) {
      await cancel()
      throw httpError(502, '来源返回的不是音频')
    }
    contentType = mime || (upstreamType.startsWith('audio/') ? upstreamType : 'audio/mpeg')
  }
  const out = { 'Content-Type': contentType, 'Cache-Control': cache, 'Accept-Ranges': upstream.headers.get('accept-ranges') === 'bytes' ? 'bytes' : 'none' }
  for (const name of ['content-length', 'content-range']) if (upstream.headers.has(name)) out[name] = upstream.headers.get(name)
  response.writeHead(upstream.status, out)
  if (request.method === 'HEAD' || !upstream.body) { await cancel(); response.end(); return }
  try {
    await pipeline(Readable.fromWeb(upstream.body), response)
  } catch (error) {
    // The player seeks or skips constantly; a closed socket is routine, not a failure.
    if (!response.writableEnded && !response.destroyed) response.destroy()
  }
}

// ---------------------------------------------------------------------------------------------
// The user's online shelf: saved album snapshots + source settings (online.json in the data dir)
// ---------------------------------------------------------------------------------------------
export class OnlineLibrary {
  constructor({ dataDir, sources, internetArchiveUrl } = {}) {
    this.file = dataDir ? path.join(dataDir, 'online.json') : undefined
    this.state = { version: 1, albums: [], subsonic: undefined }
    this.override = sources
    this.internetArchive = new InternetArchiveSource(internetArchiveUrl ? { baseUrl: internetArchiveUrl } : undefined)
    this.loaded = undefined
    this.writeChain = Promise.resolve()
  }

  load() {
    this.loaded ??= (async () => {
      if (!this.file) return
      try {
        const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
        if (data && data.version === 1) {
          this.state.albums = asArray(data.albums).filter((item) => item?.id && item.source && item.album?.ref && asArray(item.album.tracks).length).slice(0, ONLINE_LIMITS.albums)
          if (data.subsonic?.baseUrl) this.state.subsonic = normalizeSubsonicConfig(data.subsonic)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this.loadError = `在线曲库文件无法读取，已按空曲库处理：${error.message}`
      }
    })()
    return this.loaded
  }

  save() {
    if (!this.file) return Promise.resolve()
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      await fs.rename(temp, this.file)
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }

  sourceFor(id) {
    if (this.override?.[id]) return this.override[id]
    if (id === 'internetarchive') return this.internetArchive
    if (id === 'subsonic') {
      if (!this.state.subsonic) throw httpError(409, '尚未配置自有音乐服务，请先在“音乐服务”中填写地址和账号')
      return new SubsonicSource(this.state.subsonic)
    }
    throw httpError(400, '不支持的在线来源')
  }

  async sources() {
    await this.load()
    const subsonic = this.state.subsonic
    return {
      sources: [
        { id: 'internetarchive', name: 'Internet Archive', configured: true },
        { id: 'subsonic', name: '自有音乐服务', configured: !!subsonic },
      ],
      subsonic: subsonic ? { baseUrl: subsonic.baseUrl, username: subsonic.username, passwordSet: !!subsonic.password } : undefined,
      error: this.loadError,
    }
  }

  /** An empty password keeps the saved one, but only for the same address and account. */
  reusePassword(value) {
    const config = normalizeSubsonicConfig(value)
    const previous = this.state.subsonic
    if (!config.password && previous && previous.baseUrl === config.baseUrl && previous.username === config.username) config.password = previous.password
    return config
  }

  async configureSubsonic(value) {
    await this.load()
    if (value.clear === true) this.state.subsonic = undefined
    else this.state.subsonic = this.reusePassword(value)
    await this.save()
    return this.sources()
  }

  /** Check a candidate Subsonic configuration without saving it. */
  async testSubsonic(value) {
    await this.load()
    return new SubsonicSource(this.reusePassword(value)).ping()
  }

  async search(sourceId, query, options = {}) {
    await this.load()
    const source = this.sourceFor(sourceId)
    const result = await source.search(query, options)
    const saved = new Set(this.state.albums.filter((item) => item.source === sourceId).map((item) => item.album.ref))
    return { ...result, source: sourceId, items: result.items.map((item) => ({ ...item, added: saved.has(item.ref) })) }
  }

  async add(sourceId, ref, options = {}) {
    await this.load()
    const source = this.sourceFor(sourceId)
    const id = onlineAlbumId(sourceId, ref)
    if (!this.state.albums.some((item) => item.id === id) && this.state.albums.length >= ONLINE_LIMITS.albums) throw httpError(409, `在线专辑架最多保存 ${ONLINE_LIMITS.albums} 张专辑，请先移除一些`)
    const album = await source.album(ref, options)
    const item = { id, source: sourceId, addedAt: new Date().toISOString(), album }
    const index = this.state.albums.findIndex((entry) => entry.id === id)
    if (index >= 0) this.state.albums[index] = { ...item, addedAt: this.state.albums[index].addedAt }
    else this.state.albums.push(item)
    await this.save()
    return { id, title: album.title, artist: album.artist, tracks: album.tracks.length, updated: index >= 0 }
  }

  async remove(id) {
    await this.load()
    const before = this.state.albums.length
    this.state.albums = this.state.albums.filter((item) => item.id !== id)
    if (this.state.albums.length === before) throw httpError(404, '在线专辑架中没有这张专辑')
    await this.save()
    return { id }
  }

  /** Same JSON shape as the local library, so the existing shelf renders it unchanged. */
  async snapshot() {
    await this.load()
    const counts = new Map()
    const names = { internetarchive: 'Internet Archive', subsonic: '自有音乐服务' }
    const albums = this.state.albums.map(({ id, source, album }) => {
      const genreId = `online-${source}`
      counts.set(genreId, (counts.get(genreId) ?? 0) + 1)
      const sourceName = names[source] ?? source
      return {
        id, title: album.title, artist: album.artist, year: album.year, discCount: Math.max(1, ...album.tracks.map((track) => track.discNumber ?? 1)),
        description: album.description, descriptionSource: album.description && album.url ? { name: sourceName, url: album.url, license: album.license } : undefined,
        localNote: [`来源：${sourceName}`, album.url, album.license ? `授权：${album.license}` : ''].filter(Boolean).join('\n'),
        genreId, rawGenres: asArray(album.genres),
        folder: sourceName,
        coverUrl: album.coverRef ? `/api/online/artwork/${id}` : undefined,
        tracks: album.tracks.map((track) => ({
          id: onlineTrackId(id, track.ref), albumId: id, title: track.title, artist: track.artist,
          trackNumber: track.trackNumber, discNumber: track.discNumber ?? 1, duration: track.duration || 0,
          format: track.format, codec: track.codec, lossless: !!track.lossless, browserPlayable: true,
          audioUrl: `/api/online/audio/${onlineTrackId(id, track.ref)}`, relativePath: track.ref,
        })),
        producers: [], offline: false, online: { status: 'unqueried' },
      }
    })
    const genres = [...counts].map(([id, albumCount]) => ({ id, name: names[id.slice('online-'.length)] ?? id, albumCount }))
    return {
      version: 1, albums, genres, roots: [], scan: { running: false }, onlineEnabled: false,
      enrich: { running: false, completed: 0, total: 0 }, introductions: { running: false, completed: 0, total: 0, updated: 0, notFound: 0, failed: 0 },
    }
  }

  async trackTarget(trackId) {
    await this.load()
    for (const item of this.state.albums) {
      const track = item.album.tracks.find((entry) => onlineTrackId(item.id, entry.ref) === trackId)
      if (!track) continue
      const source = this.sourceFor(item.source)
      return { target: source.audioRequest(item.album, track), allow: (url) => source.allow(url), mime: track.mime }
    }
    return null
  }

  async coverTarget(albumId) {
    await this.load()
    const item = this.state.albums.find((entry) => entry.id === albumId)
    if (!item) return null
    const source = this.sourceFor(item.source)
    const target = source.coverRequest(item.album)
    return target ? { target, allow: (url) => source.allow(url) } : null
  }
}

export const onlineAlbumId = (source, ref) => `online-${sha1(source, ref).slice(0, 20)}`
export const onlineTrackId = (albumId, ref) => `onlinetrack-${sha1(albumId, ref).slice(0, 20)}`
