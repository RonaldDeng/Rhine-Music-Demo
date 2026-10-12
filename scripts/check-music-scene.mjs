import assert from 'node:assert/strict';
import { setMusicAlbums, records, archiveColumns, columnFiles, fileAtSlot, fileLocation } from '../src/data.ts';
import { fileAtCell, selectionCell, visibleCell, cellKey, LOOP_COLUMNS, LOOP_ROWS, MUSIC_LOOP_ROWS, wrap } from '../src/archive-loop.ts';
import { containCover } from '../src/cover-atlas.ts';
import { musicFogDistances } from '../src/music-atmosphere.ts';
import { MUSIC_MODEL } from '../src/music-model.ts';

for (const genreCount of [1, 2, 7]) for (const albumCount of [1, 3, 40]) {
  const genres = Array.from({ length: genreCount }, (_, i) => ({ id: `g${i}`, name: `流派 ${i}` }));
  const albums = genres.flatMap((genre) => Array.from({ length: albumCount }, (_, i) => ({ id: `${genre.id}-${i}`, title: `${genre.name} / ${i}`, artist: '测试', genreId: genre.id, rawGenres: [], folder: '', tracks: [], producers: [], offline: false })));
  setMusicAlbums(albums, genres);
  assert.equal(archiveColumns.length, genreCount);
  for (let index = 0; index < records.length; index++) {
    const location = fileLocation(index);
    assert.equal(fileAtSlot(location.slot), index, 'slots must not collide for > 20 albums');
    assert.equal(fileAtCell(location), index);
    for (const direction of [-1, 1]) {
      const files = columnFiles(location.lane);
      const nextIndex = files[wrap(files.indexOf(index) + direction, files.length)];
      const next = selectionCell(nextIndex, location, { axis: 'row', direction });
      assert.equal(next.row - location.row, direction, 'boundary crossing preserves motion direction');
      assert.equal(fileAtCell(next), nextIndex);
      const nextLane = wrap(location.lane + direction, genreCount);
      const targetIndex = columnFiles(nextLane)[0];
      const laneCell = selectionCell(targetIndex, location, { axis: 'lane', direction });
      assert.equal(laneCell.lane - location.lane, direction);
      assert.equal(fileAtCell(laneCell), targetIndex);
    }
  }
  for (const rows of [LOOP_ROWS, MUSIC_LOOP_ROWS]) for (const center of [{ lane: -300.3, row: -111.2 }, { lane: 0, row: 12 }, { lane: 301.6, row: 10000.8 }]) {
    const cells = Array.from({ length: LOOP_COLUMNS * rows }, (_, i) => visibleCell(i, center, rows));
    assert.equal(new Set(cells.map(cellKey)).size, LOOP_COLUMNS * rows);
    assert.ok(cells.every((cell) => Number.isInteger(cell.row) && records[fileAtCell(cell)]));
  }
}
setMusicAlbums([], []);
assert.equal(records.length, 0);
assert.equal(fileAtCell({ lane: -1, row: -1 }), -1);
assert.equal(fileAtSlot(12), -1);
assert.ok(Object.values(selectionCell(0, { lane: 0, row: 12 })).every(Number.isFinite));
for (const [width, height] of [[1000, 1000], [600, 1000], [1200, 500]]) {
  const box = containCover(width, height, 1024, 768);
  assert.ok(Math.abs(box.width / box.height - width / height) < 1e-10);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 768);
}
// Fog uses the camera that was actually rendered, so entry/reversal cannot
// temporarily place the inspected art inside a white haze. Even the furthest
// corner of the unchanged case remains ahead of the daytime near boundary.
const caseRadius = Math.hypot(MUSIC_MODEL.width, MUSIC_MODEL.height, MUSIC_MODEL.depth) / 2;
for (const distance of [10, 40, 85, 140]) for (const detail of [0, 0.1, 0.5, 0.9, 1]) {
  const night = musicFogDistances(distance, detail, 0);
  assert.ok(Math.abs(night.near - (distance + (1 - detail) * 5 - detail)) < 1e-12,
    'Night/dusk retain the original rendered-camera near boundary');
  assert.ok(Math.abs(night.far - (distance + (1 - detail) * 25 + detail * 12)) < 1e-12,
    'Night/dusk retain the original far boundary');
  const day = musicFogDistances(distance, detail, 1);
  assert.equal(day.near, distance + 10, 'Day extraction cannot sweep the near white fog boundary through background albums');
  assert.equal(day.far, distance + 40, 'Day extraction keeps the glass background capture at a stable fog density');
  assert.ok(day.near > distance + caseRadius,
    'The complete inspected case stays clear of daytime fog at every view angle');
  for (const progress of [0, 0.01, 0.25, 0.5, 0.99, 1]) {
    const frame = musicFogDistances(distance, detail, progress);
    assert.ok(frame.near >= night.near && frame.near <= day.near);
    assert.ok(frame.far >= night.far && frame.far <= day.far);
    assert.ok(frame.far > frame.near, 'Animated theme changes retain a valid fog interval');
    const moved = musicFogDistances(distance + 7, detail, progress);
    assert.ok(Math.abs(moved.near - frame.near - 7) < 1e-12);
    assert.ok(Math.abs(moved.far - frame.far - 7) < 1e-12);
  }
}
console.log('Music scene checks passed: library loops, empty library, uncropped covers, clear daytime inspection, unchanged night fog and continuous camera/theme anchoring.');
