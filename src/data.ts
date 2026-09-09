import content from "../content/archives.json" with { type: "json" };
import type { MusicAlbum, MusicGenre } from "./music-types";

export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  album?: MusicAlbum;
}

export let records: ArchiveRecord[] = content.records;
export let categories = ["全部档案", ...content.categories];
export let archiveColumns = content.columns;
export let musicLibrary = false;
export let slotStride = 32;
let filesByColumn = archiveColumns.map((name) => records.flatMap((record, index) => record.category === name ? [index] : []));

/** Replace the view model atomically; audio files and their metadata stay intact. */
export function setMusicAlbums(albums: MusicAlbum[], genres: MusicGenre[] = []) {
  musicLibrary = true;
  const usedGenres = new Set(albums.map((album) => album.genreId));
  const names = new Map(genres.map((genre) => [genre.id, genre.name]));
  const genreIds = [...genres.map((genre) => genre.id).filter((id) => usedGenres.has(id)), ...usedGenres].filter((id, index, all) => all.indexOf(id) === index);
  archiveColumns = genreIds.map((id) => names.get(id) ?? id ?? "未分类");
  categories = ["全部专辑", ...archiveColumns];
  records = albums.map((album) => ({
    id: album.id, title: album.title, en: album.artist, department: album.artist,
    category: names.get(album.genreId) ?? album.genreId ?? "未分类",
    date: album.year ? String(album.year) : "年份未知", lead: album.artist,
    clearance: album.offline ? "音乐库离线" : `${album.tracks.length} 首歌曲`,
    abstract: album.folder, findings: album.rawGenres,
    source: album.online?.sourceUrl ?? "本地音乐库", album,
  }));
  // Index by stable genre ids, even if two custom genres share a display name.
  filesByColumn = genreIds.map((id) => albums.flatMap((album, index) => album.genreId === id ? [index] : []));
  slotStride = Math.max(32, ...filesByColumn.map((files) => files.length + 12));
}

export function columnFiles(lane: number) {
  return filesByColumn[lane] ?? [];
}
export function fileLocation(index: number) {
  const lane = Math.max(0, filesByColumn.findIndex((files) => files.includes(index)));
  const row = 12 + Math.max(0, columnFiles(lane).indexOf(index));
  return { lane, row, slot: lane * slotStride + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / slotStride));
  return files[Math.max(0, Math.min(files.length - 1, (slot % slotStride) - 12))] ?? -1;
}
