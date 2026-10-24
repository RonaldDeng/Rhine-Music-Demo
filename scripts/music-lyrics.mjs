import path from 'node:path'
import { constants, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { parseStream } from 'music-metadata'
import { cleanLyricMetadata, rankLyricCandidates, queryLyricProvider, LYRIC_PROVIDERS } from './music-lyrics-providers.mjs'

// Provider attribution, protocol references and content rights: docs/LYRICS.md.
const { version } = createRequire(import.meta.url)('../package.json')
const CLIENT_ID = `RhineMusicDemo/${version} (https://github.com/RonaldDeng/Rhine-Music-Demo)`
export const LYRIC_TEXT_LIMIT = 256 * 1024
const RESPONSE_LIMIT = 2 * 1024 * 1024
const TAG_READ_LIMIT = 4 * 1024 * 1024
const MAX_LINES = 2000
const cleanMetadata = cleanLyricMetadata
const missing = (message = '没有找到可用的本地歌词。') => ({ status: 'not-found', lines: [], message })
const unknownArtist = (value) => !value || /^(?:unknown(?: artist)?|未知艺术家|未知藝術家|various artists)$/i.test(value)

class LyricsError extends Error {}
const abort = (signal) => { if (signal?.aborted) throw new LyricsError('歌词请求已取消。') }

function textPayload(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > LYRIC_TEXT_LIMIT) throw new LyricsError('歌词文本过大或格式无效。')
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** LRC multi-timestamps, millisecond offset, enhanced-LRC word tags, or plain text. */
export function parseLyricText(value) {
  const raw = textPayload(value)
  const offsetMatch = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/im)
  const offset = offsetMatch ? Math.max(-3600000, Math.min(3600000, Number(offsetMatch[1]))) / 1000 : 0
  const timed = []
  const plain = []
  let instrumental = false
  for (const row of raw.split('\n')) {
    if (/^\s*\[instrumental:\s*true\s*\]\s*$/i.test(row)) { instrumental = true; continue }
    if (/^\s*\[[a-z][a-z0-9_-]*:[^\]]*\]\s*$/i.test(row)) continue
    const stamps = [...row.matchAll(/\[(\d{1,4}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)]
    const text = row.replace(/\[\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?>/g, '').trim()
    if (text.length > 2048) throw new LyricsError('歌词单行过长。')
    if (stamps.length) {
      for (const stamp of stamps) {
        const seconds = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || '0'}`)
        if (seconds > 86400) throw new LyricsError('歌词时间戳超出支持范围。')
        timed.push({ time: Math.max(0, Math.round((seconds - offset) * 1000) / 1000), text })
      }
    } else if (text) plain.push({ time: null, text })
    if (timed.length + plain.length > MAX_LINES) throw new LyricsError('歌词行数超出支持范围。')
  }
  if (timed.some((line) => line.text)) {
    const seen = new Set()
    const lines = timed.sort((a, b) => a.time - b.time).filter((line) => {
      const key = JSON.stringify([line.time, line.text])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { status: 'synced', lines }
  }
  if (plain.length) return { status: 'plain', lines: plain }
  return instrumental ? { status: 'instrumental', lines: [] } : missing()
}

function decodeSidecar(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  if (bytes.includes(0)) throw new LyricsError('歌词文件不是可识别的文本。')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
}

function isInside(root, file) {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function safeAudio(descriptor) {
  if (!descriptor?.path || !descriptor?.allowedRoot) throw new LyricsError('歌曲不在已配置的音乐目录中。')
  const [file, root] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  if (!isInside(root, file)) throw new LyricsError('歌曲已移出配置的音乐目录。')
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw new LyricsError('歌曲文件当前不可用。')
  return { file, root, stat }
}

async function readSidecar(file, root) {
  let realFile
  try { realFile = await fs.realpath(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!isInside(root, realFile)) throw new LyricsError('歌词文件已移出配置的音乐目录。')
  const handle = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > LYRIC_TEXT_LIMIT) throw new LyricsError('歌词文件过大或不是普通文本文件。')
    // One extra byte detects a file growing during the read without unbounded allocation.
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > stat.size) throw new LyricsError('歌词文件正在变化，请稍后重试。')
    return decodeSidecar(buffer.subarray(0, size))
  } finally { await handle.close() }
}

export function readEmbeddedLyrics(metadata) {
  const tags = metadata?.common?.lyrics
  if (!Array.isArray(tags)) return missing()
  let fallback
  for (const tag of tags.slice(0, 16)) {
    if (typeof tag === 'string' || typeof tag?.text === 'string') {
      const result = parseLyricText(typeof tag === 'string' ? tag : tag.text)
      if (result.status === 'synced') return result
      if (result.status !== 'not-found') fallback ??= result
    }
    // ID3 TimestampFormat 2 is milliseconds; MPEG-frame timestamps (1) are not seconds.
    if (tag?.timeStampFormat === 2 && Array.isArray(tag.syncText) && tag.syncText.length <= MAX_LINES) {
      const lines = tag.syncText.filter((line) => Number.isFinite(line.timestamp) && line.timestamp >= 0 && line.timestamp <= 86_400_000 && typeof line.text === 'string')
        .map((line) => ({ time: line.timestamp / 1000, text: textPayload(line.text).trim() })).sort((a, b) => a.time - b.time)
      if (lines.some((line) => line.text)) {
        if (Buffer.byteLength(JSON.stringify(lines)) > LYRIC_TEXT_LIMIT) throw new LyricsError('内嵌歌词过大。')
        return { status: 'synced', lines }
      }
    }
  }
  return fallback ?? missing()
}

/** Compatibility helper; AMLL's duration is the last timestamp, not recording length. */
export function chooseLyricCandidate(metadata, candidates, options) {
  const best = rankLyricCandidates(metadata, candidates, options)[0]
  return best ? { song: best.song } : { message: '在线词库没有找到与歌曲及歌手匹配的歌词。' }
}

async function boundedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { await response.body?.cancel(); throw new LyricsError('在线歌词响应过大。') }
  if (!response.body) throw new LyricsError('在线歌词响应为空。')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (true) {
      abort(signal)
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > RESPONSE_LIMIT) throw new LyricsError('在线歌词响应过大。')
      chunks.push(value)
    }
    abort(signal)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { signal?.removeEventListener('abort', stop); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Read-only local lyrics, then on-demand online lookup; never scans or uploads a library. */
export class MusicLyricsService {
  constructor({ fetcher = globalThis.fetch, metadataParser = parseStream, timeoutMs = 24000, requestTimeoutMs = 4000, providerTimeoutMs = 7500, now = Date.now, cacheEntries = 64, providers = LYRIC_PROVIDERS } = {}) {
    this.fetcher = fetcher
    this.metadataParser = metadataParser
    this.timeoutMs = timeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.providerTimeoutMs = providerTimeoutMs
    this.now = now
    this.cacheEntries = Math.max(1, Math.min(128, cacheEntries))
    this.providers = providers.filter((provider) => LYRIC_PROVIDERS.includes(provider))
    this.localCache = new Map()
    this.onlineCache = new Map()
    this.inflight = new Map()
    this.providerCooldown = new Map()
    this.activeRequests = 0
    this.requestQueue = []
  }

  async acquire(signal) {
    abort(signal)
    if (this.activeRequests < 4) { this.activeRequests++; return }
    await new Promise((resolve, reject) => {
      const pending = { resolve: () => { signal?.removeEventListener('abort', cancel); resolve() } }
      const cancel = () => {
        this.requestQueue = this.requestQueue.filter((entry) => entry !== pending)
        reject(new LyricsError('歌词请求已取消。'))
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.requestQueue.push(pending)
    })
  }

  release() {
    const next = this.requestQueue.shift()
    if (next) next.resolve()
    else this.activeRequests--
  }

  remember(cache, key, result, ttl) {
    cache.delete(key)
    cache.set(key, { result, expires: this.now() + ttl })
    while (cache.size > this.cacheEntries) cache.delete(cache.keys().next().value)
  }

  cached(cache, key) {
    const entry = cache.get(key)
    if (!entry || entry.expires <= this.now()) { cache.delete(key); return null }
    return entry.result
  }

  async local(descriptor, signal) {
    const { file, root, stat } = await safeAudio(descriptor)
    abort(signal)
    const stem = path.join(path.dirname(file), path.parse(file).name)
    let fallback
    for (const extension of ['.lrc', '.LRC', '.txt', '.TXT']) {
      const text = await readSidecar(`${stem}${extension}`, root)
      if (text === null) continue
      const result = parseLyricText(text)
      if (result.status !== 'not-found') {
        const sourced = { ...result, source: { kind: 'sidecar', name: `本地 ${extension.toUpperCase().slice(1)}` } }
        if (result.status !== 'plain') return sourced
        fallback ??= sourced
      }
    }
    const key = JSON.stringify([file, stat.size, stat.mtimeMs, stat.ctimeMs])
    const cached = this.cached(this.localCache, key)
    if (cached) return cached.status === 'synced' || cached.status === 'instrumental' ? cached : fallback ?? cached
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    let stream
    let result
    try {
      stream = handle.createReadStream({ autoClose: false, start: 0, end: Math.max(0, Math.min(stat.size, TAG_READ_LIMIT) - 1) })
      const metadata = await this.metadataParser(stream, { mimeType: descriptor.mime, size: stat.size }, { duration: false, skipCovers: true, skipPostHeaders: true })
      result = readEmbeddedLyrics(metadata)
    } catch (error) {
      if (error instanceof LyricsError) throw error
      result = missing('没有找到可读取的本地歌词。')
    } finally { stream?.destroy(); await handle.close() }
    abort(signal)
    if (result.status !== 'not-found') result.source = { kind: 'embedded', name: '音频内嵌歌词' }
    this.remember(this.localCache, key, result, 60 * 60_000)
    return result.status === 'synced' || result.status === 'instrumental' ? result : fallback ?? result
  }

  async request(provider, url, signal) {
    abort(signal)
    if ((this.providerCooldown.get(provider) || 0) > this.now()) throw new LyricsError('在线歌词服务暂时限流，请稍后重试。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    const combined = AbortSignal.any([signal, controller.signal])
    let acquired = false
    try {
      await this.acquire(combined)
      acquired = true
      abort(combined)
      const response = await this.fetcher(url, { signal: combined, redirect: 'error', credentials: 'omit', headers: {
        Accept: 'application/json', 'User-Agent': CLIENT_ID,
        ...(provider === 'netease' ? { Referer: 'https://music.163.com/' } : {}),
      } })
      if (response.status === 404) { await response.body?.cancel(); return null }
      if (response.status === 429) {
        await response.body?.cancel()
        this.providerCooldown.set(provider, this.now() + 60_000)
        throw new LyricsError('在线歌词服务暂时限流，请一分钟后重试。')
      }
      if (!response.ok) { await response.body?.cancel(); throw new LyricsError('在线歌词服务暂时不可用，请稍后重试。') }
      return await boundedJson(response, combined)
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new LyricsError('在线歌词请求超时，请稍后重试。')
      throw error
    } finally { clearTimeout(timeout); if (acquired) this.release() }
  }

  async online(metadata, signal) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let fallback
    let failure
    try {
      for (const provider of this.providers) {
        abort(requestSignal)
        const providerController = new AbortController()
        const providerTimeout = setTimeout(() => providerController.abort(), this.providerTimeoutMs)
        const providerSignal = AbortSignal.any([requestSignal, providerController.signal])
        try {
          const result = await queryLyricProvider(provider, metadata, (_provider, url) => this.request(provider, url, providerSignal), parseLyricText)
          if (result?.status === 'synced') return result
          fallback ??= result
        } catch (error) {
          if (requestSignal.aborted) throw error
          failure = providerController.signal.aborted ? '在线歌词请求超时，请稍后重试。' : error instanceof LyricsError ? error.message : '部分在线歌词来源暂时不可用，请稍后重试。'
        } finally { clearTimeout(providerTimeout) }
      }
      return fallback ?? (failure ? { status: 'error', lines: [], message: failure } : missing('已自动查询在线词库，暂未找到匹配的歌词。'))
    } catch {
      return { status: 'error', lines: [], message: signal?.aborted ? '歌词请求已取消。' : controller.signal.aborted ? '在线歌词请求超时，请稍后重试。' : '在线歌词请求失败，请检查网络后重试。' }
    } finally { clearTimeout(timeout) }
  }

  async sharedOnline(key, metadata, signal) {
    abort(signal)
    let task = this.inflight.get(key)
    if (!task) {
      const controller = new AbortController()
      task = { controller, consumers: 0, promise: null }
      const current = task
      task.promise = this.online(metadata, controller.signal).then((result) => {
        if (!controller.signal.aborted) this.remember(this.onlineCache, key, result, result.status === 'error' ? 10_000 : result.status === 'not-found' ? 60_000 : 12 * 60 * 60_000)
        return result
      }).finally(() => { if (this.inflight.get(key) === current) this.inflight.delete(key) })
      this.inflight.set(key, task)
    }
    task.consumers++
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = (callback, value) => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', cancel)
        task.consumers--
        callback(value)
      }
      const cancel = () => {
        finish(reject, new LyricsError('歌词请求已取消。'))
        if (!task.consumers) {
          task.controller.abort()
          if (this.inflight.get(key) === task) this.inflight.delete(key)
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      task.promise.then((result) => finish(resolve, result), (error) => finish(reject, error))
      if (signal?.aborted) cancel()
    })
  }

  async lookup({ track, album, descriptor }, { online = true, refresh = false, signal } = {}) {
    const trackId = String(track?.id ?? '')
    try {
      abort(signal)
      const local = await this.local(descriptor, signal)
      if (local.status === 'synced' || local.status === 'instrumental') return { ...local, trackId }
      const artist = cleanMetadata(track?.artist)
      const metadata = { title: cleanMetadata(track?.title), artist: unknownArtist(artist) ? cleanMetadata(album?.artist) : artist, album: cleanMetadata(album?.title), duration: Number.isFinite(track?.duration) && track.duration > 0 ? track.duration : 0 }
      const key = JSON.stringify(metadata)
      const cached = refresh ? null : this.cached(this.onlineCache, key)
      const select = (result) => ({ ...(local.status === 'plain' && result.status !== 'synced' ? local : result), trackId })
      if (cached) return select(cached)
      if (!online) return { ...local, trackId }
      if (!metadata.title || unknownArtist(metadata.artist)) return select(missing('歌曲名称或歌手标签不完整，未发起在线查询。'))
      return select(await this.sharedOnline(key, metadata, signal))
    } catch (error) {
      return { status: 'error', lines: [], trackId, message: error instanceof LyricsError ? error.message : '本地歌词暂时无法读取，请确认音乐目录可用。' }
    }
  }
}
