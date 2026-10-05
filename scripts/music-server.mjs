import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, createReadStream } from 'node:fs'
import { MusicLibraryStore, safeRootList } from './music-library.mjs'
import { canonicalPath, isWindows } from './platform.mjs'
import { OnlineLibrary, streamRemote } from './online-sources.mjs'

// Canonical form so the launcher's health probe matches regardless of drive-letter case or junctions.
const PROJECT_DIR = canonicalPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

// Online shelf API (see online-sources.mjs). Remote addresses never reach the browser: audio and covers are proxied.
async function onlineApi(online, request, response, route, url) {
  const get = request.method === 'GET' || request.method === 'HEAD'
  const post = request.method === 'POST'
  const text = (value, name) => {
    if (typeof value !== 'string' || !value || value.length > 300) throw Object.assign(new Error(`${name} 必须是字符串`), { status: 400 })
    return value
  }
  if (route === '/api/online/library' && get) return json(response, 200, await online.snapshot())
  if (route === '/api/online/sources' && get) return json(response, 200, await online.sources())
  if (route === '/api/online/subsonic' && post) return json(response, 200, await online.configureSubsonic(await bodyJson(request)))
  if (route === '/api/online/subsonic/test' && post) return json(response, 200, await online.testSubsonic(await bodyJson(request)))
  if (route === '/api/online/search' && get) {
    const aborter = new AbortController()
    response.once('close', () => aborter.abort())
    const page = Number(url.searchParams.get('page') ?? 1)
    const result = await online.search(url.searchParams.get('source') || 'internetarchive', url.searchParams.get('q') ?? '', { page, collection: url.searchParams.get('collection') || undefined, signal: aborter.signal })
    return json(response, 200, result)
  }
  if (route === '/api/online/albums' && post) {
    const value = await bodyJson(request)
    return json(response, 200, await online.add(text(value.source, 'source'), text(value.ref, 'ref')))
  }
  if (route === '/api/online/albums/remove' && post) return json(response, 200, await online.remove(text((await bodyJson(request)).id, 'id')))
  const audio = /^\/api\/online\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
  const artwork = /^\/api\/online\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
  if ((audio || artwork) && get) {
    const found = audio ? await online.trackTarget(audio[1]) : await online.coverTarget(artwork[1])
    if (!found) return json(response, 404, { error: '在线专辑架中没有此文件' })
    return await streamRemote(request, response, found.target, { allow: found.allow, kind: audio ? 'audio' : 'image', mime: found.mime, cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
  }
  return json(response, 404, { error: 'API 不存在或请求方法不支持' })
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请使用 application/json 请求体'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 请求体必须是对象')
  return value
}

/** Returns null for no Range; false for invalid or unsatisfiable single ranges. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  const headers = {
    'Content-Type': descriptor.mime ?? MIME[path.extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
  }
  if (range === false) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 })
    response.end()
    return
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = range.end - range.start + 1
  } else headers['Content-Length'] = stat.size
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

export async function createMusicServer({
  dataDir = process.env.MUSIC_DATA_DIR ?? path.join(PROJECT_DIR, '..', 'music-data-v3'),
  distDir = path.join(PROJECT_DIR, 'dist'),
  defaultRoots = process.env.MUSIC_ROOTS ? process.env.MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : [],
  store: providedStore,
  online: providedOnline,
  autoScan = true,
} = {}) {
  const store = providedStore ?? await new MusicLibraryStore({ dataDir, defaultRoots }).init()
  // Nothing is read or fetched until the online shelf is first used.
  const online = providedOnline ?? new OnlineLibrary({ dataDir: store.dataDir ?? dataDir })
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`)
      if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
      const url = new URL(request.url, host)
      if (request.headers.origin && request.headers.origin !== host.origin) return json(response, 403, { error: '不接受跨站点访问本地曲库' })
      const route = decodeURIComponent(url.pathname)
      // On Windows ':' would address NTFS alternate data streams (/index.html::$DATA) or other drives.
      if (route.includes('\0') || route.includes('\\') || (isWindows && route.includes(':'))) return json(response, 400, { error: '无效路径' })
      const get = request.method === 'GET' || request.method === 'HEAD'
      if (route === '/api/health' && get) return json(response, 200, { service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid })
      if (route === '/api/library' && get) {
        // A user or Codex can edit genre-rules.json while the player is running.
        await store.reloadRules()
        return json(response, 200, store.snapshot())
      }
      if (route === '/api/library/scan' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (store.scanPromise) return json(response, 202, store.snapshot())
        const roots = value.roots === undefined ? undefined : safeRootList(value.roots)
        void store.scan({ roots }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/genre-rules' && get) {
        await store.reloadRules()
        return json(response, 200, store.rules)
      }
      if (route === '/api/genre-rules' && request.method === 'POST') return json(response, 200, await store.updateRules(await bodyJson(request)))
      if (['/api/config', '/api/library/config'].includes(route)) {
        if (get) return json(response, 200, { ...store.config, musicBrainzConfigured: !!store.musicBrainzContact })
        if (request.method === 'POST') {
          const value = await bodyJson(request)
          if (value.roots !== undefined && store.scanPromise) return json(response, 409, { error: '正在扫描，请完成后再更改根目录' })
          return json(response, 200, { ...await store.updateConfig(value), musicBrainzConfigured: !!store.musicBrainzContact })
        }
      }
      if (route === '/api/library/enrich' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (!store.musicBrainzContact) return json(response, 400, { error: '在线资料库尚未配置：请在资料库设置填写自己的联系邮箱或项目网址。音乐仍可本地播放。' })
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        void store.enrich({ albumIds: value.albumIds, force: true }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/library/introductions' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        void store.updateIntroductions({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route.startsWith('/api/online/')) return await onlineApi(online, request, response, route, url)
      const audio = /^\/api\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
      const artwork = /^\/api\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
      if ((audio || artwork) && get) {
        const file = audio ? store.trackFile(audio[1]) : store.artworkFile(artwork[1])
        if (!file) return json(response, 404, { error: '索引中没有此文件' })
        return await serveFile(request, response, file, { cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
      }
      if (route === '/api/foobar/status' && get) return json(response, 200, { configured: !!store.config.foobarBaseUrl, baseUrl: store.config.foobarBaseUrl, connected: false, note: 'configured 仅代表已保存地址；连接状态需读取 /api/foobar/player 实际响应。' })
      if (route.startsWith('/api/foobar/')) {
        if (!store.config.foobarBaseUrl) return json(response, 503, { error: 'foobar2000 / Beefweb 尚未配置连接' })
        const suffix = route.slice('/api/foobar/'.length)
        if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(suffix) || !['GET', 'POST'].includes(request.method)) return json(response, 400, { error: '不支持的 Beefweb 请求' })
        const target = new URL(`/api/${suffix}`, store.config.foobarBaseUrl)
        target.search = url.search
        const payload = request.method === 'POST' ? JSON.stringify(await bodyJson(request)) : undefined
        const upstream = await fetch(target, { method: request.method, body: payload, headers: payload ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' })
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      if (route.startsWith('/api/')) return json(response, 404, { error: 'API 不存在或请求方法不支持' })
      if (!get) return json(response, 405, { error: '只接受 GET/HEAD' })
      const asset = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
      return await serveFile(request, response, { path: asset, allowedRoot: distDir }, { cache: route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400), { error: error.message })
      else response.destroy()
    }
  })
  server.requestTimeout = 30_000
  if (autoScan) server.once('listening', () => { void store.scan().catch(() => {}) })
  return { server, store, online }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 5173)
  const { server, store } = await createMusicServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Rhine Local Music  http://127.0.0.1:${port}/`)
    console.log(`音乐索引：${store.dataDir}`)
    console.log(`音乐目录：${store.config.roots.join('、') || '尚未配置，在界面添加目录'}`)
  })
  const close = () => { server.close(() => process.exit()); server.closeAllConnections() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  // Ctrl+Break and console close on Windows; SIGTERM is not delivered there.
  if (isWindows) process.once('SIGBREAK', close)
}
