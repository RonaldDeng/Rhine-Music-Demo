import OpenCC from 'opencc-js'

// Independent HTTP adapters; remote service licenses do not relicense lyric text.
// Protocols and credits: docs/LYRICS.md and NOTICE.md. No Folia/AMLL player code is bundled.
const simplify = OpenCC.Converter({ from: 'hk', to: 'cn' })
export const cleanLyricMetadata = (value) => typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : ''
const identity = (value) => simplify(cleanLyricMetadata(value)).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const edition = /\b(?:live|remix|acoustic|instrumental|karaoke|cover|sped|slowed|unplugged|mix|edit|demo|version|ver|arrange|piano|radio|tv|rerecorded|re-recorded)\b|现场|現場|伴奏|翻唱|混音|不插电|不插電|加速|减速|減速|粤语|粵語|国语|國語|英文版|日文版|钢琴|鋼琴|试听|試聽|重录|重錄/iu

function repeated(value) {
  const parts = cleanLyricMetadata(value).split(/\s+\/\s+/).filter(Boolean)
  return parts.length > 1 && parts.every((part) => identity(part) === identity(parts[0])) ? parts[0] : cleanLyricMetadata(value)
}

export function lyricSearchTitle(value) {
  return repeated(value)
    .replace(/^\s*(?:\d{1,2}[-.]\s+|\d{1,2}\s+[-–—]\s+)/u, '')
    .replace(/\s*[([{（【](?:feat\.?|ft\.?|featuring)\s+[^)\]}）】]+[)\]}）】]/giu, '')
    .replace(/\s+\b(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '')
    .replace(/[([{（【]([^\])}）】]*)[\])}）】]/gu, (all, content) => edition.test(content) ? all : '')
    .replace(/\s*[-–—]\s*(?:\d{4}\s*)?remaster(?:ed)?(?:\s+\d{4})?\s*$/iu, '').trim()
}

function artists(value) {
  return [...new Set(cleanLyricMetadata(value).split(/\s*(?:[,，;；/&、]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/iu).map(identity).filter(Boolean))]
}

/** Title and artist establish identity; album is a ranking hint, not a mandatory release match. */
export function rankLyricCandidates(metadata, candidates, { durationKind = 'last-line' } = {}) {
  if (!Array.isArray(candidates)) throw new Error('在线歌词响应格式已变化。')
  const targetTitle = identity(lyricSearchTitle(metadata.title))
  const targetArtists = artists(metadata.artist)
  const unique = new Set()
  return candidates.slice(0, 100).flatMap((song) => {
    if (!Number.isSafeInteger(song?.id) || song.id < 0 || unique.has(song.id)) return []
    unique.add(song.id)
    if (!targetTitle || identity(lyricSearchTitle(song.trackName ?? song.name)) !== targetTitle) return []
    const sourceArtists = artists(song.artistName)
    const wholeArtistMatches = identity(metadata.artist) === identity(song.artistName)
    if (!wholeArtistMatches && (!targetArtists.length || !sourceArtists.length || !sourceArtists.includes(targetArtists[0]) || !targetArtists.includes(sourceArtists[0]) || !targetArtists.every((artist) => sourceArtists.includes(artist)))) return []
    let score = 85
    if (metadata.album && identity(song.albumName) === identity(metadata.album)) score += 5
    if (metadata.duration > 0 && Number.isFinite(song.duration) && song.duration > 0) {
      if (durationKind === 'last-line') {
        if (song.duration > metadata.duration + 3) return []
      } else {
        const difference = Math.abs(song.duration - metadata.duration)
        if (difference > Math.max(8, Math.min(12, metadata.duration * 0.03))) return []
        score += Math.max(0, 15 - difference * 2)
      }
    }
    return [{ song, score }]
  }).sort((a, b) => b.score - a.score || Number(Boolean(b.song.syncedLyrics)) - Number(Boolean(a.song.syncedLyrics)) || a.song.id - b.song.id)
}

export const LYRIC_PROVIDERS = Object.freeze(['netease', 'lrclib', 'amll'])

function validResult(song, metadata, parse) {
  let result
  try {
    result = parse(song.syncedLyrics || '')
    if (result.status === 'not-found' && song.plainLyrics) result = parse(song.plainLyrics)
  } catch { return null }
  if (result.status === 'not-found' && song.instrumental === true) return { status: 'instrumental', lines: [] }
  if (metadata.duration > 0 && result.lines.some((line) => line.text && line.time !== null && line.time > metadata.duration + 3)) return null
  // Some providers append an empty closing cue beyond the actual audio duration.
  if (metadata.duration > 0) result.lines = result.lines.filter((line) => line.text || line.time === null || line.time <= metadata.duration + 3)
  return result.status === 'not-found' ? null : result
}

async function searchLibrary(provider, metadata, request, parse) {
  const amll = provider === 'amll'
  const base = amll ? 'https://api.amll.dev/v1/lrclib/' : 'https://lrclib.net/api/'
  const title = lyricSearchTitle(metadata.title)
  const primaryArtist = metadata.artist.split(/\s*(?:[,，;；/&、]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/iu)[0]
  const searches = [{ track_name: metadata.title, artist_name: metadata.artist }]
  if (title !== metadata.title) searches.push({ track_name: title, artist_name: metadata.artist })
  if (primaryArtist !== metadata.artist) searches.push({ track_name: title, artist_name: primaryArtist })
  searches.push({ q: `${title} ${primaryArtist}` })
  let fallback
  const seen = new Set()
  for (const query of searches) {
    const url = new URL('search', base)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    if (amll) url.searchParams.set('pageSize', '20')
    const data = await request(provider, url)
    if (data === null) continue
    for (const { song } of rankLyricCandidates(metadata, data, { durationKind: amll ? 'last-line' : 'recording' }).slice(0, 5)) {
      if (seen.has(song.id)) continue
      seen.add(song.id)
      const result = validResult(song, metadata, parse)
      if (!result) continue
      const withSource = { ...result, source: { kind: 'online', name: amll ? 'AMLL TTML DataBase' : 'LRCLIB', url: `${base}get/${song.id}` } }
      if (result.status === 'synced') return withSource
      fallback ??= withSource
    }
  }
  return fallback ?? null
}

async function searchNetEase(metadata, request, parse) {
  const title = lyricSearchTitle(metadata.title)
  const primaryArtist = metadata.artist.split(/\s*(?:[,，;；/&、]|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s)\s*/iu)[0]
  const keywords = [...new Set([`${metadata.title} ${metadata.artist}`, `${title} ${primaryArtist}`, title])]
  let fallback
  const seen = new Set()
  for (const keyword of keywords) {
    const searchUrl = new URL('https://music.163.com/api/search/get/web')
    searchUrl.search = new URLSearchParams({ s: keyword, type: '1', limit: '20', offset: '0' }).toString()
    const search = await request('netease', searchUrl)
    if (search === null) continue
    if (search.code !== 200) throw new Error('网易云歌词服务暂时不可用。')
    if (search.result?.songs !== undefined && !Array.isArray(search.result.songs)) throw new Error('在线歌词响应格式已变化。')
    const songs = (search.result?.songs || []).slice(0, 100).filter((song) => song && typeof song === 'object').map((song) => ({
      id: song.id, trackName: song.name, artistName: (Array.isArray(song.artists || song.ar) ? (song.artists || song.ar) : []).map((artist) => artist?.name || '').join(' / '),
      albumName: song.album?.name || song.al?.name || '', duration: (song.duration || song.dt || 0) / 1000,
    }))
    for (const { song } of rankLyricCandidates(metadata, songs, { durationKind: 'recording' }).slice(0, 3)) {
      if (seen.has(song.id)) continue
      seen.add(song.id)
      const lyricUrl = new URL('https://music.163.com/api/song/lyric')
      lyricUrl.search = new URLSearchParams({ id: String(song.id), lv: '-1', kv: '-1', tv: '-1' }).toString()
      const data = await request('netease', lyricUrl)
      if (data === null) continue
      if (data.code !== 200) continue
      const result = validResult({ ...song, syncedLyrics: data.lrc?.lyric, instrumental: data.nolyric === true }, metadata, parse)
      if (!result) continue
      const withSource = { ...result, source: { kind: 'online', name: '网易云音乐', url: `https://music.163.com/song?id=${song.id}` } }
      if (result.status === 'synced') return withSource
      fallback ??= withSource
    }
  }
  return fallback ?? null
}

export async function queryLyricProvider(provider, metadata, request, parse) {
  if (provider === 'netease') return searchNetEase(metadata, request, parse)
  if (provider === 'lrclib' || provider === 'amll') return searchLibrary(provider, metadata, request, parse)
  throw new Error('未知歌词来源。')
}
