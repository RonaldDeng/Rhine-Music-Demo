import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

export const INTRODUCTION_EXCHANGE_LIMIT = 4 * 1024 * 1024
const TASK_FORMAT = 'rhine-album-introductions-task'
const RESULT_FORMAT = 'rhine-album-introductions-result'
const sourceKeys = ['name', 'url', 'author', 'publishedAt', 'kind', 'license']
export const INTRODUCTION_HISTORY_LIMITS = { revisions: 10000, backups: 32, directoryEntries: 4096, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 }
const backupName = /^library-index\.before-introductions-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/u
const failure = (message) => Object.assign(new Error(message), { status: 400 })
const hasIntroduction = (album) => typeof album.description === 'string' && album.description.trim() && album.descriptionSource?.url
export const hasExternalIntroduction = (album) => album.descriptionSource?.method === 'external-ai' || album.introduction?.method === 'external-ai'

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw failure(`${label} 格式不正确或含有不支持的字段`)
}

function plainText(value, limit, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw failure(`${label} 必须是 1–${limit} 字符的纯文字`)
  if (/<\/?[a-z][^>]*>/iu.test(value) || /!?\[[^\]]*\]\s*(?:\(|\[)/u.test(value) || /<\s*(?:https?:|javascript:|data:)/iu.test(value)) throw failure(`${label} 不接受 HTML 或 Markdown 链接，请将网址放入 sources`)
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
}

function source(value) {
  object(value, sourceKeys, '来源')
  const result = { name: plainText(value.name, 200, '来源名称'), url: plainText(value.url, 2048, '来源网址') }
  let parsed
  try { parsed = new URL(result.url) } catch { throw failure('来源网址必须是完整 HTTPS 地址') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || /\s/u.test(result.url)) throw failure('来源网址必须是无账号密码的 HTTPS 地址')
  for (const key of ['author', 'publishedAt', 'license']) {
    const text = plainText(value[key], key === 'publishedAt' ? 100 : 300, `来源 ${key}`, { optional: true })
    if (text !== undefined) result[key] = text
  }
  if (value.kind !== undefined) {
    if (!['official', 'editorial', 'reference'].includes(value.kind)) throw failure('来源 kind 必须是 official、editorial 或 reference')
    result.kind = value.kind
  }
  return result
}

function yearOf(album) { return Number.isInteger(album.year) ? album.year : null }
function researchTracks(album) {
  return (album.tracks ?? []).map((track) => ({
    title: String(track.title ?? ''),
    ...(Number.isInteger(track.discNumber) && track.discNumber > 0 ? { discNumber: track.discNumber } : {}),
    ...(Number.isInteger(track.trackNumber) && track.trackNumber > 0 ? { trackNumber: track.trackNumber } : {}),
    ...(Number.isFinite(track.duration) && track.duration >= 0 ? { duration: track.duration } : {}),
  }))
}

/** Deliberately excludes files, artwork, credentials, local notes and playback URLs. */
function researchSources(album) {
  const candidates = album.descriptionSource?.references ?? [album.descriptionSource]
  return (Array.isArray(candidates) ? candidates : []).slice(0, 8).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    try { return [source(Object.fromEntries(sourceKeys.filter((key) => candidate[key] !== undefined).map((key) => [key, candidate[key]])))] }
    catch { return [] }
  })
}

function researchEdition(album) {
  return { id: album.id, title: album.title, artist: album.artist, year: yearOf(album), tracks: researchTracks(album) }
}

export function introductionEditionRevision(album) {
  return createHash('sha256').update(JSON.stringify(researchEdition(album))).digest('hex')
}

export function introductionRevision(album) {
  // A result is bound to this edition's identity, track sequence, and prior text.
  // Genre/producer refreshes do not invalidate otherwise valid research work.
  return createHash('sha256').update(JSON.stringify({
    ...researchEdition(album),
    description: album.description ?? null, descriptionSource: album.descriptionSource ?? null,
    introduction: album.introduction ?? null,
  })).digest('hex')
}

export function validateReconciliationResult(value) {
  const results = validateIntroductionResult(value)
  if (new Set(results.map((entry) => entry.id)).size !== results.length) throw failure('重新核对不接受重复专辑 ID；请每张只保留一项')
  return results
}

/** Only prior exports or our own pre-import backups can attest an old edition. */
export function reconcileIntroductionResult(albums, value, proofs) {
  const results = validateReconciliationResult(value)
  const current = new Map(albums.map((album) => [album.id, album]))
  const result = structuredClone(value)
  const unresolved = []
  let rebound = 0
  for (let index = 0; index < results.length; index += 1) {
    const entry = results[index]
    const album = current.get(entry.id)
    const reject = (reason) => unresolved.push({ id: entry.id, reason })
    if (!album) { reject('专辑已不在当前音乐库中'); continue }
    if (album.title !== entry.title || album.artist !== entry.artist || yearOf(album) !== entry.year) { reject('专辑名称、歌手或年份已不同，不能沿用旧任务'); continue }
    const revision = introductionRevision(album)
    if (revision === entry.expectedRevision) continue
    if (entry.status !== 'matched') { reject('未找到或无法确认的旧条目保留原状；请重新导出，或从本批结果中移除'); continue }
    const priorEdition = proofs.get(entry.expectedRevision)
    if (!priorEdition) { reject('没有找到该旧修订的导出记录或可核验备份；请重新导出任务'); continue }
    if (priorEdition !== introductionEditionRevision(album)) { reject('曲目、顺序、时长或专辑身份已变化，不能沿用旧任务'); continue }
    result.albums[index].expectedRevision = revision
    rebound += 1
  }
  return { result, rebound, unresolved }
}

/** Reads only bounded, regular pre-import backup files; never traverses music roots. */
export async function readIntroductionRevisionProofs(dataDir, wanted) {
  const proofs = new Map()
  if (!wanted.size) return proofs
  const candidates = []
  let inspected = 0
  const directory = await fs.opendir(dataDir)
  for await (const entry of directory) {
    if (++inspected > INTRODUCTION_HISTORY_LIMITS.directoryEntries) break
    if (entry.isFile() && backupName.test(entry.name)) candidates.push(entry.name)
  }
  let totalBytes = 0
  for (const name of candidates.sort().reverse().slice(0, INTRODUCTION_HISTORY_LIMITS.backups)) {
    if (proofs.size === wanted.size) break
    let handle
    try {
      // O_NOFOLLOW also rejects a symlink swapped in after directory enumeration.
      handle = await fs.open(path.join(dataDir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > INTRODUCTION_HISTORY_LIMITS.fileBytes || totalBytes + before.size > INTRODUCTION_HISTORY_LIMITS.totalBytes) continue
      totalBytes += before.size
      const bytes = Buffer.alloc(before.size + 1)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
        if (!bytesRead) break
        read += bytesRead
      }
      const after = await handle.stat()
      if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue
      const saved = JSON.parse(bytes.subarray(0, read).toString('utf8'))
      if (saved?.version !== 1 || !Array.isArray(saved.albums) || saved.albums.length > 10000) continue
      for (const album of saved.albums) {
        if (!album || typeof album !== 'object' || !Array.isArray(album.tracks) || album.tracks.length > 10000 || !album.tracks.every((track) => track && typeof track === 'object')) continue
        const revision = introductionRevision(album)
        if (wanted.has(revision)) proofs.set(revision, introductionEditionRevision(album))
      }
    } catch {
      // A missing, unreadable, malformed or changed backup cannot prove identity.
      // Leave that result unresolved instead of guessing or modifying history.
    } finally { await handle?.close() }
  }
  return proofs
}

export function createIntroductionTask(albums, { scope = 'missing', albumId } = {}) {
  if (!['missing', 'all', 'selected'].includes(scope)) throw failure('scope 必须是 missing、all 或 selected')
  if (scope === 'selected' && (typeof albumId !== 'string' || !albums.some((album) => album.id === albumId))) throw failure('所选专辑已不在当前音乐库中')
  const selected = albums.filter((album) => scope === 'all' || (scope === 'selected' ? album.id === albumId : !hasIntroduction(album)))
  return {
    format: TASK_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    albums: selected.map((album) => ({
      id: album.id, title: album.title, artist: album.artist, year: yearOf(album), expectedRevision: introductionRevision(album),
      trackCount: album.tracks?.length ?? 0, tracks: researchTracks(album),
      ...(hasIntroduction(album) ? { existingIntroduction: { description: album.description, sources: researchSources(album) } } : {}),
    })),
  }
}

export function validateIntroductionResult(value) {
  let bytes
  try { bytes = Buffer.byteLength(JSON.stringify(value)) } catch { throw failure('结果必须是有效 JSON') }
  if (bytes > INTRODUCTION_EXCHANGE_LIMIT) throw Object.assign(failure('结果超过 4 MiB，请分批导入'), { status: 413 })
  object(value, ['format', 'version', 'albums'], '结果文件')
  if (value.format !== RESULT_FORMAT || value.version !== 1 || !Array.isArray(value.albums) || value.albums.length > 10000) throw failure('需要 rhine-album-introductions-result、version: 1 和 albums 数组（最多 10000 项）')
  return value.albums.map((entry) => {
    object(entry, ['id', 'title', 'artist', 'year', 'expectedRevision', 'status', 'description', 'sources', 'notes'], '专辑结果')
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9-]{1,160}$/u.test(entry.id)) throw failure('专辑 ID 格式不正确')
    // Keep identity fields verbatim: even whitespace changes need a new task export.
    // Existing album tags may themselves contain brackets or angle symbols;
    // they are compared exactly and never treated as markup or instructions.
    for (const key of ['title', 'artist']) if (typeof entry[key] !== 'string' || !entry[key].trim() || entry[key].length > 2000) throw failure(`${key} 必须原样保留任务中的名称`)
    if (entry.year !== null && (!Number.isInteger(entry.year) || entry.year < 1 || entry.year > 9999)) throw failure('year 必须是年份整数或 null，不能省略')
    if (typeof entry.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.expectedRevision)) throw failure('expectedRevision 必须原样保留任务中的 64 位修订标识')
    if (!['matched', 'not-found', 'uncertain'].includes(entry.status)) throw failure('status 必须是 matched、not-found 或 uncertain')
    const result = { id: entry.id, title: entry.title, artist: entry.artist, year: entry.year, expectedRevision: entry.expectedRevision, status: entry.status }
    const notes = plainText(entry.notes, 2000, 'notes', { optional: true })
    if (notes !== undefined) result.notes = notes
    if (entry.status === 'matched') {
      result.description = plainText(entry.description, 8000, '专辑介绍')
      if (!Array.isArray(entry.sources) || entry.sources.length < 1 || entry.sources.length > 8) throw failure('matched 介绍必须附带 1–8 个来源')
      result.sources = entry.sources.map(source)
      if (new Set(result.sources.map((item) => item.url)).size !== result.sources.length) throw failure('同一介绍的来源网址不可重复')
    } else if (entry.description !== undefined || entry.sources !== undefined) {
      throw failure('未找到或无法确认的条目仅填写 notes，不得附带待写入的介绍或来源')
    }
    return result
  })
}

export function previewIntroductionImport(albums, value, { allowReplace = false } = {}) {
  if (typeof allowReplace !== 'boolean') throw failure('allowReplace 必须为布尔值')
  const results = validateIntroductionResult(value)
  const current = new Map(albums.map((album) => [album.id, album]))
  const frequencies = new Map()
  for (const result of results) frequencies.set(result.id, (frequencies.get(result.id) ?? 0) + 1)
  const entries = results.map((result) => {
    const album = current.get(result.id)
    const entry = { id: result.id, title: result.title, artist: result.artist }
    const conflict = (reason) => ({ ...entry, action: 'conflict', reason })
    if (frequencies.get(result.id) !== 1) return conflict('结果中专辑 ID 重复；请每张只保留一项')
    if (!album) return conflict('专辑已不在当前音乐库中；请重新导出任务')
    if (album.title !== result.title || album.artist !== result.artist || yearOf(album) !== result.year) return conflict('名称、歌手或年份与任务身份不符')
    if (introductionRevision(album) !== result.expectedRevision) return conflict('专辑或现有介绍已变化；请重新导出任务')
    if (result.status !== 'matched') return { ...entry, action: 'skip', reason: result.notes ?? (result.status === 'not-found' ? '未找到可靠来源，保留原状' : '身份或资料无法确认，保留原状') }
    if (hasIntroduction(album) && !allowReplace) return { ...entry, action: 'skip', reason: '已有介绍；需明确开启替换后才能写入' }
    return { ...entry, action: hasIntroduction(album) ? 'replace' : 'add', reason: hasIntroduction(album) ? '替换已有介绍（写入前自动备份）' : '新增已整理的介绍', description: result.description, sources: result.sources,
      ...(hasIntroduction(album) ? { existingDescription: album.description, existingSources: researchSources(album) } : {}),
    }
  })
  const counts = { add: 0, replace: 0, skip: 0, conflict: 0 }
  for (const entry of entries) counts[entry.action] += 1
  return { canApply: counts.conflict === 0 && counts.add + counts.replace > 0, counts, entries }
}
