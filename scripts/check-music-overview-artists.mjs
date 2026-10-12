import assert from 'node:assert/strict';
import { overviewArtists, overviewUsesArtistGrid } from '../src/music-overview-artists.ts';
import { musicArtistKey, orderMusicAlbums } from '../src/music-order.ts';
import { isPortraitViewport } from '../src/viewport-layout.ts';

const album = (id, artist, title = id, genreId = 'test') => ({
  id, artist, title, genreId, rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
});

for (const [width, height, expected] of [
  [600, 600, true], [629, 600, true], [630, 600, false],
  [1000, 1000, true], [1001, 1000, true], [1010, 1000, true],
  [1049, 1000, true], [1050, 1000, false],
  [999, 1000, true], [1280, 720, false], [430, 932, true], [320, 568, true],
  [0, 1000, false], [1000, 0, false], [-1, 1000, false], [1000, -1, false],
  [NaN, 1000, false], [1000, NaN, false], [Infinity, Infinity, false],
  [Infinity, 1000, false], [1000, Infinity, false],
]) {
  assert.equal(overviewUsesArtistGrid(width, height), expected,
    `Artist panel follows the shared portrait layout for a valid viewport: ${width} × ${height}`);
  const valid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  assert.equal(overviewUsesArtistGrid(width, height, false), valid && isPortraitViewport(width, height),
    'Disabling the override always uses the same portrait boundary as the scene and DOM');
  assert.equal(overviewUsesArtistGrid(width, height, true), valid,
    'Enabling all ratios includes every valid viewport without accepting invalid dimensions');
}

assert.deepEqual(overviewArtists([]), [], 'An empty library has no phantom artist');
const longName = '歌手 / Artist <script> & "名字" 🎹 '.repeat(20).trim();
const samples = [
  album('ten', 'Artist 10'),
  album('zhou', '周杰伦'),
  album('adele-b', '  ADELE  ', 'Beta', 'pop'),
  album('long', longName),
  album('two', 'Artist 2'),
  album('blank-a', '  \t\n '),
  album('adele-a', 'Adele', 'Alpha', 'soul'),
  album('zhang', '张学友'),
  album('unknown', '未知歌手'),
  album('wide', 'Ａｄｅｌｅ', 'Gamma'),
  album('blank-b', '', 'Blank B'),
  album('double-a', 'A  B', 'First'),
  album('double-b', 'a\t b', 'Second'),
  album('accent-a', 'Beyoncé', 'First'),
  album('accent-b', 'Beyonce\u0301', 'Second'),
  album('similar', 'Beyonce', 'Third'),
];
const original = structuredClone(samples);
const catalog = overviewArtists(samples);
assert.deepEqual(samples, original, 'Catalog derivation must not change library data or album order');
const byKey = new Map(catalog.map(artist => [artist.key, artist]));
assert.equal(catalog.length, new Set(samples.map(musicArtistKey)).size,
  'Every unique normalized album artist is present exactly once');
assert.deepEqual([...byKey.keys()], [...new Set(orderMusicAlbums(samples, 'artist').map(musicArtistKey))],
  'Artist panel uses the same pinyin/numeric order as the existing artist browser');
assert.ok(catalog.indexOf(byKey.get('artist 2')) < catalog.indexOf(byKey.get('artist 10')),
  'Natural numeric ordering puts Artist 2 before Artist 10');
assert.ok(catalog.indexOf(byKey.get('张学友')) < catalog.indexOf(byKey.get('周杰伦')),
  'Chinese artist names follow pinyin ordering');
assert.deepEqual(byKey.get('adele'), { key: 'adele', name: 'Adele', albumIds: ['adele-a', 'adele-b', 'wide'] },
  'Nonadjacent artists across genres, case and fullwidth variants share one catalog item');
assert.deepEqual(byKey.get('a b').albumIds, ['double-a', 'double-b'],
  'Whitespace normalization matches scene grouping');
assert.deepEqual(byKey.get('beyoncé').albumIds, ['accent-a', 'accent-b'],
  'Canonical Unicode variants group together');
assert.deepEqual(byKey.get('beyonce').albumIds, ['similar'],
  'Locale-equivalent but distinct normalized artist keys must remain separate');
assert.equal(byKey.get('').name, '未知歌手');
assert.deepEqual(new Set(byKey.get('').albumIds), new Set(['blank-a', 'blank-b']));
assert.deepEqual(byKey.get('未知歌手').albumIds, ['unknown'],
  'A blank artist keeps the actual blank key, distinct from the literal fallback name');
assert.equal(byKey.get(musicArtistKey(samples[3])).name, longName,
  'Long names and markup-like metadata stay complete as literal text for the UI');
assert.deepEqual(new Set(catalog.flatMap(artist => artist.albumIds)), new Set(samples.map(item => item.id)),
  'The panel can reach every album, including artists outside the scene projection');
assert.deepEqual(overviewArtists([...samples, samples[2]]), catalog,
  'Repeated album records cannot inflate a displayed artist album count');

for (const view of [
  [...samples].reverse(),
  [...samples.slice(7), ...samples.slice(0, 7)],
  orderMusicAlbums(samples, 'genre'),
  orderMusicAlbums(samples, 'album'),
  orderMusicAlbums(samples, 'artist'),
]) {
  assert.deepEqual(overviewArtists(view), catalog,
    'Catalog names, membership and ordering do not depend on current scene sort or original order');
}

// A long library must remain complete; no viewport label limit may leak into the catalog.
const many = Array.from({ length: 200 }, (_, index) => album(`album-${index}`, `Artist ${index}`));
const allArtists = overviewArtists(many.reverse());
assert.equal(allArtists.length, 200);
assert.equal(allArtists[0].name, 'Artist 0');
assert.equal(allArtists.at(-1).name, 'Artist 199');
assert.equal(allArtists.flatMap(artist => artist.albumIds).length, many.length);
console.log('Overview artist catalog: shared portrait threshold, all-ratios override with dimension validation, all-library completeness, stable pinyin/numeric ordering, normalization, blank keys, duplicate counts and literal long/Unicode names passed.');
