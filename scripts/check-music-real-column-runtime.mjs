import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import * as motion from '../src/motion.ts';
import * as loop from '../src/archive-loop.ts';
import * as data from '../src/data.ts';
import { MusicRealColumns } from '../src/music-real-columns.ts';
import { isRealAlbumCell } from '../src/music-array-layout.ts';
import { musicOverviewColumnExtent } from '../src/music-overview-edge.ts';
import { MUSIC_MODEL, MUSIC_COLUMN_SPACING } from '../src/music-model.ts';
import { MusicOverviewMotion } from '../src/music-overview.ts';

// Execute production field, pool and matrix updates with actual Three objects.
// Material uploads and rendering are replaced; world transforms, cover slot IDs
// and ray intersections are measured rather than inferred from source strings.
const source = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('scene.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const methodNames = ['cellPosition', 'actualCell', 'musicColumnRowOffset', 'visibleMusicCell',
  'musicColumnExtent', 'applyMusicColumnExtent', 'musicRealColumnField'];
const methods = methodNames.map(name => {
  const node = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === name);
  assert.ok(node?.body, `Production ${name} exists`);
  return `${name}(${node.parameters.map(parameter => parameter.getText(tree)).join(',')}) ${node.body.getText(tree)}`;
});
const update = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'update');
const statements = [...update.body.statements];
const extractionScale = statements.find(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'extractionScale'));
assert.ok(extractionScale, 'Production overview extraction shares the camera progress');
const pool = statements.find(node => ts.isForStatement(node) && node.getText(tree).includes('this.cells[i] ='));
const outgoing = statements.find(node => ts.isForStatement(node) && node.getText(tree).includes('this.outgoing.length - 1'));
const hidden = statements.findIndex(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'hidden'));
const modelEnd = statements.findIndex((node, index) => index > hidden &&
  node.getText(tree).startsWith('this.applyMusicColumnExtent(this.model,'));
assert.ok(pool && outgoing && hidden >= 0 && modelEnd > hidden, 'Extract all production ownership/matrix paths');
const easeNode = tree.statements.find(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'ease'));
const compiled = ts.transpileModule(`
  ${easeNode.getText(tree)}
  return { ${methods.join(',\n')},
    render(dt, time, cinematic = undefined) {
      const musicIntro = false, detailNavigation = false, detail = 0, entryZ = 0;
      const overview = this.musicOverview.value;
      ${extractionScale.getText(tree)}
      const trackX = this.columnCamera.value;
      const center = { lane: trackX / this.columnSpacing + 2, row: this.musicBrowseRow };
      const selectedRow = this.selectedCell.row, selectedLane = this.selectedCell.lane;
      const chosen = this.cellPosition(this.selectedCell);
      const field = (row, lane) => this.musicRealColumnField(row, lane, time);
      ${pool.getText(tree)}
      ${outgoing.getText(tree)}
      ${statements.slice(hidden, modelEnd + 1).map(node => node.getText(tree)).join('\n')}
    }
  };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const close = (actual, expected, message, epsilon = 1e-6) => assert.ok(Number.isFinite(actual) &&
  Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

function fixture(selectedRow = 12) {
  const counts = [1, 2, 106, 49];
  const genres = counts.map((_, lane) => ({ id: `g${lane}`, name: `Column ${lane}` }));
  data.setMusicAlbums(genres.flatMap((genre, lane) => Array.from({ length: counts[lane] }, (_, row) => ({
    id: `${lane}:${row + 12}`, title: `Album ${row}`, artist: genre.name, genreId: genre.id,
    rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
  }))), genres);
  const count = loop.LOOP_COLUMNS * loop.MUSIC_LOOP_ROWS;
  const geometry = new THREE.BoxGeometry(MUSIC_MODEL.width, MUSIC_MODEL.height, MUSIC_MODEL.depth)
    .translate(0, MUSIC_MODEL.center.y, 0);
  const shell = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), count);
  const cover = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), count);
  const deps = { ...motion, ...loop, ...data, THREE, MUSIC_MODEL, isRealAlbumCell, musicOverviewColumnExtent,
    MUSIC_ALBUM_SWITCH_RATE: 9 };
  const methods = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  const host = {
    ...methods, columnSpacing: MUSIC_COLUMN_SPACING, loaded: true, looping: true, reduced: false, musicArrayMode: 'realistic',
    musicColumnCounts: counts, musicOverview: { value: 0 }, musicRealColumns: new MusicRealColumns(),
    selectedCell: { lane: 2, row: selectedRow }, coordinateOrigin: { lane: 0, row: 0 },
    poolRows: loop.MUSIC_LOOP_ROWS, cells: Array.from({ length: count }, (_, i) => loop.poolCell(i, loop.MUSIC_LOOP_ROWS)),
    positions: Array.from({ length: count }, () => new THREE.Vector3()),
    rail: { value: -2.17 - (selectedRow - 15.5) * loop.ROW_SPACING, velocity: 0 },
    columnCamera: { value: 0, velocity: 0 }, shoulder: { value: selectedRow, velocity: 0 }, laneFocus: { value: 2, velocity: 0 },
    dummy: new THREE.Object3D(), columnExtentOffset: new THREE.Vector3(), model: new THREE.Group(),
    instances: [shell], coverIds: [], covers: { array: cover, setSlot(i, record) { host.coverIds[i] = record?.id; } },
    scene: new THREE.Scene(), appearance: { apply() {}, setClarity() {}, dispose() {} },
    lift: { value: .9, velocity: 0 }, outgoing: [], rotation: 0, targetDetail: 0, targetReveal: 1,
    idleGain: 1, pulseGain: 1, scanBlend: 0, scanTime: 40, pulses: [], deferSelectionPulse: true,
    lastInteraction: -100, clock: 0,
    get musicBrowseRow() { return (-this.rail.value - 2.17) / loop.ROW_SPACING + 15.5; },
  };
  host.musicRealColumns.reset(counts, host.selectedCell);
  host.scene.add(host.model, shell);
  const matrices = () => new Map(host.cells.flatMap((cell, i) => {
    if (!host.actualCell(cell)) return [];
    const matrix = new THREE.Matrix4(); shell.getMatrixAt(i, matrix);
    const insert = new THREE.Matrix4(); cover.getMatrixAt(i, insert);
    assert.deepEqual(insert.elements, matrix.elements, 'Cover and shell receive the identical production matrix');
    assert.equal(host.coverIds[i], data.records[loop.fileAtCell(cell)]?.id, 'Cover ID follows the same logical cell as its matrix');
    if (matrix.elements[0] !== 0) close(matrix.elements[12],
      (cell.lane - 2) * MUSIC_COLUMN_SPACING - host.columnCamera.value,
      'Rendered shell and cover centers use the current music-column spacing');
    return [[loop.cellKey(cell), { matrix, index: i, cell }]];
  }));
  return { host, counts, matrices, shell };
}

// Measure the production selected/copy transforms, not only a desired lift
// target. A wide-array selection must occupy exactly the slot its instanced
// counterpart will own, and recover the normal preview on the camera clock.
{
  const f = fixture(60), host = f.host, time = 2;
  const selected = { ...host.selectedCell };
  const baseY = () => host.cellPosition(host.selectedCell).y +
    host.musicRealColumnField(host.selectedCell.row, host.selectedCell.lane, time);
  for (const progress of [0, .2, .5, 1, .8, .35, 0]) {
    host.musicOverview.value = progress;
    host.render(0, time);
    close(host.model.position.y - baseY(), .9 * (1 - progress),
      'Visible extraction follows overview progress through entry, reversal and return');
    assert.deepEqual(host.lift, { value: .9, velocity: 0 },
      'Overview rendering cannot reset the existing preview/inspection lift spring');
  }
  host.musicOverview.value = 1;
  host.render(0, time); host.model.updateMatrix();
  const selectedMatrix = host.model.matrix.clone();
  host.selectedCell = { lane: selected.lane, row: selected.row + 1 };
  host.render(0, time);
  const arrayMatrix = f.matrices().get(loop.cellKey(selected)).matrix;
  selectedMatrix.elements.forEach((value, index) => close(arrayMatrix.elements[index], value,
    'At full overview the formerly selected album has exactly the array position and tilt'));
  host.selectedCell = selected;
  const old = { group: new THREE.Group(), cell: { lane: selected.lane, row: selected.row - 1 }, slot: 0,
    lift: { value: .7, velocity: 0 }, returnY: null, clarity: 0 };
  host.outgoing.push(old); host.scene.add(old.group);
  host.render(0, time); old.group.updateMatrix();
  const outgoingMatrix = old.group.matrix.clone();
  old.lift.value = 0; host.render(0, time);
  const restoredMatrix = f.matrices().get(loop.cellKey(old.cell)).matrix;
  outgoingMatrix.elements.forEach((value, index) => close(restoredMatrix.elements[index], value,
    'A previous selection cannot pop out while its copy retires inside overview'));
  for (const lift of [.4, .9, 3.85]) {
    host.lift.value = lift;
    host.render(0, time, { musicIntro: true });
    close(host.model.position.y - baseY(), lift,
      'Cinematic/intro extraction remains authored even if overview state was previously nonzero');
    host.musicOverview.value = 0; host.render(0, time);
    close(host.model.position.y - baseY(), lift,
      'Normal preview and inspection extraction remain unchanged outside overview');
    host.musicOverview.value = 1;
  }
}
for (const hz of [30, 60, 120]) for (const speed of [.25, 1, 3]) {
  const host = fixture(60).host, motion = new MusicOverviewMotion();
  host.musicOverview.value = 1; motion.active = true; motion.update(0, true);
  motion.active = false;
  let previousLift = 0;
  for (let frame = 0; frame < Math.ceil(2 * hz / speed); frame++) {
    host.musicOverview.value = motion.update(speed / hz, false);
    host.render(0, 2);
    const baseY = host.cellPosition(host.selectedCell).y +
      host.musicRealColumnField(host.selectedCell.row, host.selectedCell.lane, 2);
    const lift = host.model.position.y - baseY;
    close(lift, .9 * (1 - motion.value), 'Rendered extraction stays on the real overview clock at every speed/frame rate');
    assert.ok(lift >= previousLift - 1e-9 && lift <= .9 + 1e-9,
      'Returning from overview restores preview extraction without a rebound or overshoot');
    previousLift = lift;
  }
  assert.ok(previousLift > .899, 'The normal preview height is fully restored after the return');
}

const baseline = fixture(), moving = fixture();
moving.host.selectedCell = { lane: 2, row: 110 };
moving.host.musicRealColumns.select(moving.host.selectedCell, { guided: true });
moving.host.shoulder.value = 110;
moving.host.idleGain = 0; // Global browsing suppresses this old shared gain.
moving.host.lastInteraction = 0;
moving.host.pulses = [{ row: 13, lane: 2, time: 0 }, { row: 110, lane: 2, time: 0 }];
let previousTime = 0;
for (const time of [0, .1, .35, .8, 1.4, 2.4, 3]) {
  moving.host.musicRealColumns.update(time - previousTime, false);
  previousTime = time;
  // Deliberately move the shared rail on a different schedule. Its translation
  // must cancel for every real column instead of producing a second scroll.
  moving.host.rail.value = -2.17 - (12 + Math.min(1, time / 2.4) * 98 - 15.5) * loop.ROW_SPACING;
  baseline.host.render(0, time); moving.host.render(0, time);
  const original = baseline.matrices(), current = moving.matrices();
  for (const [key, item] of original) if (item.cell.lane !== 2) {
    const after = current.get(key);
    assert.ok(after, 'An inactive album remains in its own centered pool while another column moves');
    item.matrix.elements.forEach((value, i) => close(after.matrix.elements[i], value,
      'Inactive shell position and tilt equal the idle-only frame at the same timestamp'));
    const midpoint = 12 + (moving.counts[item.cell.lane] - 1) / 2;
    close(after.matrix.elements[14], -2.17 + (item.cell.row - midpoint) * loop.ROW_SPACING,
      'Inactive world Z is independent of the shared rail');
  }
  assert.equal(new Set([...current.keys()]).size, current.size, 'No duplicate logical albums enter the pool');
  close(moving.host.model.position.z,
    -2.17 + (110 - moving.host.musicRealColumns.row(2)) * loop.ROW_SPACING,
    'The extracted model follows its own column transform');
  const single = current.get('0:12');
  assert.ok(single, 'The one-album neighbour stays visible');
  const point = new THREE.Vector3(0, MUSIC_MODEL.center.y, 0).applyMatrix4(single.matrix);
  const ray = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 0, 5)), new THREE.Vector3(0, 0, -1));
  moving.shell.updateMatrixWorld(true);
  const hit = ray.intersectObject(moving.shell)[0];
  assert.ok(hit, 'The rendered one-album neighbour remains pickable');
  assert.equal(loop.cellKey(moving.host.cells[hit.instanceId]), '0:12', 'Raycast identity matches the visible shell and cover');
}

const beforeSwitch = moving.matrices();
moving.host.selectedCell = { lane: 1, row: 13 };
moving.host.musicRealColumns.select(moving.host.selectedCell);
moving.host.render(0, 3);
const switchFrame = moving.matrices();
for (const [key, item] of beforeSwitch) {
  if (key === '2:110' || key === '1:13') continue; // Selected meshes exchange instance ownership.
  const after = switchFrame.get(key);
  assert.ok(after, 'Switching the active column does not immediately recycle its visible cells');
  item.matrix.elements.forEach((value, i) => close(after.matrix.elements[i], value,
    'Column selection preserves the complete zero-time rendered transform'));
}
moving.host.musicRealColumns.update(3, false);
moving.host.render(0, 6);
const centeredAgain = moving.matrices();
for (const { matrix, cell } of centeredAgain.values()) if (cell.lane === 2) {
  close(matrix.elements[14], -2.17 + (cell.row - 64.5) * loop.ROW_SPACING,
    'The previous active column returns to its own geometric midpoint');
  close(moving.host.musicRealColumnField(cell.row, 2, 6), motion.idleWave(cell.row, 2, 6),
    'The returned column relinquishes selected shoulders and ripples');
}

const elevationStatement = statements.find(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'navigationElevation'));
const elevationExpression = elevationStatement.declarationList.declarations[0].initializer.getText(tree);
const elevationInputs = new Function('musicLibrary', 'cinematic', 'detail', 'dt', 'ROW_SPACING',
  `return ${elevationExpression};`);
moving.host.musicCamera = { navigationElevation: (...args) => args };
moving.host.rail.velocity = 20;
const finiteInputs = elevationInputs.call(moving.host, true, undefined, 0, .016, loop.ROW_SPACING);
assert.equal(finiteInputs[0], 0, 'Independent column scrolling cannot tilt the shared archive camera');
moving.host.musicArrayMode = 'filled';
const filledInputs = elevationInputs.call(moving.host, true, undefined, 0, .016, loop.ROW_SPACING);
assert.equal(filledInputs[0], 20 / loop.ROW_SPACING, 'Filled-array navigation retains its previous camera response');

// Returning copies use the same column transform and hand ownership back to
// the array on the same frame; no old/global-rail position may leak through.
const returning = fixture(60);
const copy = { group: new THREE.Group(), cell: { lane: 2, row: 59 }, slot: 0,
  lift: { value: .5, velocity: 0 }, returnY: null, clarity: 0 };
returning.host.outgoing.push(copy); returning.host.scene.add(copy.group);
returning.host.rail.value -= 37;
returning.host.render(0, 1);
close(copy.group.position.z, -2.17 - loop.ROW_SPACING, 'A returning copy receives the current independent column offset');
assert.equal(returning.matrices().get('2:59').matrix.elements[0], 0, 'Returning-copy ownership hides its array instance');
copy.lift.value = 0;
returning.host.render(0, 1);
assert.equal(returning.host.outgoing.length, 0, 'The returning copy retires on reaching the array');
const restored = returning.matrices().get('2:59').matrix;
assert.ok(restored.elements[0] > 0, 'The array instance restores in the same ownership-handoff frame');
close(restored.elements[12], copy.group.position.x, 'Outgoing and restored instance X agree');
close(restored.elements[13], copy.group.position.y, 'Outgoing and restored instance Y agree');
close(restored.elements[14], copy.group.position.z, 'Outgoing and restored instance Z agree');

console.log('Real-column runtime passed: production pool/matrix paths, overview selection/copy extraction on the shared camera clock at 30/60/120 fps and .25/1/3 speed, unchanged cinematic/normal extraction, independent global-rail cancellation, idle-only neighbours, continuous column handoff/recentering, long/short identities, exact shell/cover transforms, actual raycast identity, returning-copy ownership and camera isolation. GPU pixels and browser interaction are verified separately.');
