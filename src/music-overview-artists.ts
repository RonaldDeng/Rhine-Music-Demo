import { musicArtistKey, orderMusicAlbums } from "./music-order.ts";
import type { MusicAlbum } from "./music-types";
import { isPortraitViewport } from "./viewport-layout.ts";

export interface OverviewArtist {
  key: string;
  name: string;
  albumIds: string[];
}

/** A complete artist catalog, independent of the current scene columns or sort. */
export function overviewArtists(albums: readonly MusicAlbum[]): OverviewArtist[] {
  const artists = new Map<string, OverviewArtist>();
  for (const album of orderMusicAlbums(albums, "artist")) {
    const key = musicArtistKey(album);
    let artist = artists.get(key);
    if (!artist) {
      artist = {
        key,
        name: album.artist.trim().replace(/\s+/g, " ") || "未知歌手",
        albumIds: [],
      };
      artists.set(key, artist);
    }
    if (!artist.albumIds.includes(album.id)) artist.albumIds.push(album.id);
  }
  return [...artists.values()];
}

/** Follow the shared portrait layout unless the user enables the grid everywhere. */
export function overviewUsesArtistGrid(width: number, height: number, allRatios = false): boolean {
  return Number.isFinite(width) && Number.isFinite(height) &&
    width > 0 && height > 0 && (allRatios || isPortraitViewport(width, height));
}
