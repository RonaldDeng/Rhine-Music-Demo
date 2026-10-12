import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import { MusicOverviewMotion, overviewFraming, visibleOverviewLabels, overviewLabelMetrics, overviewLabelOpacity, overviewBoundaryClearance } from '../src/music-overview.ts';
import { isRealAlbumCell } from '../src/music-array-layout.ts';
import { visibleCell, MUSIC_LOOP_ROWS, LOOP_COLUMNS, ROW_SPACING } from '../src/archive-loop.ts';
import { setMusicAlbums, archiveColumns, columnFiles, musicLibrary } from '../src/data.ts';
import { MUSIC_MODEL, MUSIC_COLUMN_SPACING as COLUMN_SPACING } from '../src/music-model.ts';
import { musicOverviewColumnExtent } from '../src/music-overview-edge.ts';
import { MusicRealColumns } from '../src/music-real-columns.ts';
import { MusicArchiveMotion } from '../src/music-archive-motion.ts';

for (const fps of [20, 30, 60, 120]) {
  const motion = new MusicOverviewMotion();
  motion.active = true;
  let previous = 0;
  for (let i = 0; i < fps * 3; i++) {
    const value = motion.update(1 / fps, false);
    assert.ok(value >= previous && value <= 1);
    previous = value;
  }
  assert.ok(motion.value > .9999);
  motion.active = false;
  for (let i = 0; i < fps * 3; i++) motion.update(1 / fps, false);
  assert.ok(motion.value < .0001);
  motion.active = true;
  assert.equal(motion.update(0, true), 1);
  motion.reset(); assert.equal(motion.value, 0);
}
for (const [w, h] of [[390, 844], [1280, 720], [1920, 1080], [2560, 1080]]) {
  const framing = overviewFraming(w, h);
  assert.ok(framing.span >= 16.8);
  const columns = [
    {lane:0,name:'Selected',count:3,x:w/2,y:h/2,selected:true},
    {lane:1,name:'Overlap',count:9,x:w/2+60,y:h/2,selected:false},
    {lane:2,name:'Offscreen',count:1,x:-w,y:h/2,selected:false},
  ];
  const labels = visibleOverviewLabels(columns, w, h);
  assert.deepEqual(labels, [columns[0]], 'The safe selected projection wins a collision without relocating either column');
  const metrics = overviewLabelMetrics(w);
  assert.equal(labels[0].x, columns[0].x, 'Selection preserves the physical X projection');
  assert.equal(labels[0].y, columns[0].y, 'Selection preserves the physical Y projection');
  assert.ok(labels[0].x - metrics.width / 2 >= 12 &&
    labels[0].x + metrics.width / 2 + metrics.entry <= w - 12,
    'The complete card and future entry button fit inside the viewport');
  assert.ok(labels[0].y - metrics.height >= 115 && labels[0].y + metrics.stem <= h - 112,
    'The card and leader clear both the heading and controls');
  for (const clipped of [
    { ...columns[0], x: metrics.width / 2 + 11 },
    { ...columns[0], x: w - 11 - metrics.width / 2 - metrics.entry },
    { ...columns[0], y: 114 + metrics.height },
    { ...columns[0], y: h - 111 - metrics.stem },
  ]) {
    assert.equal(overviewLabelOpacity(clipped, w, h), 0, 'An edge-crossing full footprint is already transparent');
    assert.deepEqual(visibleOverviewLabels([clipped], w, h, new Set([0]), 0), [],
      'Retention or expansion cannot pin a clipped projection to the viewport edge');
  }
}
// Stopped edge columns cannot become permanently translucent interactive labels.
for (const [width, height] of [[390, 844], [1280, 720], [1863, 782]]) {
  const metrics = overviewLabelMetrics(width);
  const center = { lane: 0, physicalLane: 0, name: 'Selected', count: 1,
    x: width / 2, y: height / 2, selected: true };
  for (const extent of [.01, .3, .5, .98, .995])
    assert.deepEqual(visibleOverviewLabels([{ ...center, extent }], width, height), [],
      'Only an almost completely unfolded physical column may introduce its name');
  assert.equal(visibleOverviewLabels([{ ...center, extent: .99 }], width, height, new Set([0])).length, 1,
    'A retained near-full column uses extent hysteresis without a fractional-alpha name');
  assert.deepEqual(visibleOverviewLabels([{ ...center, extent: .98 }], width, height, new Set([0])), [],
    'The retained extent threshold schedules a finite exit');
  for (const distance of [0, 4, 4.001, 8, 8.001, 12]) {
    const edge = { ...center, x: 12 + metrics.width / 2 + distance };
    assert.ok(Math.abs(overviewBoundaryClearance(edge, width, height) - distance) < 1e-8);
    assert.equal(visibleOverviewLabels([edge], width, height).length, Number(distance > 8));
    assert.equal(visibleOverviewLabels([edge], width, height, new Set([0])).length, Number(distance > 4));
    assert.ok([0, 1].includes(overviewLabelOpacity(edge, width, height)),
      'Geometry safety must not assign a permanent intermediate opacity');
  }
}
// Future physical projections affect membership, never mutate or relocate the
// current anchor. The second look-ahead catches contact beyond the first one.
{
  const bounds = { top: 115, bottom: 608 };
  const a = { lane: 0, physicalLane: 0, name: 'Selected', count: 1, x: 400, y: 300, selected: true };
  const metrics = overviewLabelMetrics(1280), beside = gap => a.x + metrics.width + metrics.entry + gap;
  const b = { ...a, lane: 1, physicalLane: 1, name: 'Neighbour', x: beside(54), selected: false };
  const input = [a, b], original = structuredClone(input), retained = new Set([0, 1]);
  const forecast = changes => new Map(input.map(item => [item.lane, { ...item, ...changes[item.lane] }]));
  const one = forecast({ 1: { x: beside(24) } }), two = forecast({ 1: { x: beside(-6) } });
  assert.deepEqual(visibleOverviewLabels(input, 1280, 720, retained, null, bounds, [one]), input,
    'The nearer safe forecast alone does not retire a readable neighbour');
  assert.deepEqual(visibleOverviewLabels(input, 1280, 720, retained, null, bounds, [one, two]), [a],
    'A later predicted collision starts retirement before actual contact');
  for (const future of [{ ...a, x: 80 }, { ...a, extent: .98 }, { ...a, copyClearance: 0 }])
    assert.deepEqual(visibleOverviewLabels([a], 1280, 720, new Set([0]), null, bounds, [new Map([[0, future]])]), [],
      'Predicted boundary, folding or copy handoff retires the current name in advance');
  assert.deepEqual(input, original, 'Forecasting cannot rewrite actual projection coordinates');
}
// Use the actual finite render mask over the real 9 x 68 display pool.
for (const counts of [[1], [2,1], [0,1,7], [48,49,100]]) {
  for (const center of [{lane:0,row:12}, {lane:1,row:36}, {lane:2,row:96}]) {
    const rendered = Array.from({length:LOOP_COLUMNS*MUSIC_LOOP_ROWS}, (_,i)=>visibleCell(i,center,MUSIC_LOOP_ROWS))
      .filter(cell=>isRealAlbumCell(cell.lane,cell.row,counts));
    const identities=rendered.map(cell=>`${cell.lane}:${cell.row}`);
    assert.equal(new Set(identities).size, identities.length, 'No album is duplicated in real shelves');
    for (const cell of rendered) assert.ok(cell.row - 12 < counts[cell.lane]);
    if (counts.length===2 && center.row===12) assert.equal(rendered.length,3,'Two plus one albums render exactly three boxes');
  }
}
for (const [lane,row] of [[-1,12],[0,11],[0,14],[2,12],[0,12.5]])
  assert.equal(isRealAlbumCell(lane,row,[2,1]),false);

// Exercise ArchiveScene's actual projection and pool methods with a real Three
// camera, avoiding browser/WebGL construction. Extract method bodies and parameters
// unchanged from production, with the production library data view injected.
const source = ts.createSourceFile('scene.ts', await readFile(new URL('../src/scene.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const methodNames = ['getOverviewColumns', 'musicColumnRowOffset', 'visibleMusicCell', 'musicColumnExtent', 'applyMusicColumnExtent', 'setMusicOverview', 'setMusicArrayMode', 'rebaseCoordinates'];
const methodBodies = new Map();
function findMethods(node) {
  if (ts.isMethodDeclaration(node) && methodNames.includes(node.name.getText(source))) {
    assert.ok(node.body, `Production ${node.name.getText(source)} method must have a body`);
    methodBodies.set(node.name.getText(source), {
      parameters: node.parameters.map(parameter => parameter.getText(source)).join(', '),
      body: node.body.getText(source),
    });
  }
  ts.forEachChild(node, findMethods);
}
findMethods(source);
for (const name of methodNames) assert.ok(methodBodies.has(name), `Production ${name} method must exist`);
const methodsBody = ts.transpileModule(`return {${methodNames.map(name => {
  const method = methodBodies.get(name);
  return `${name}(${method.parameters}) ${method.body}`;
}).join(',')}}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const productionMethods = ({ music = musicLibrary } = {}) => new Function('THREE', 'archiveColumns', 'columnFiles',
  'ROW_SPACING', 'MUSIC_MODEL', 'musicLibrary', 'visibleCell', 'musicOverviewColumnExtent', methodsBody)(
  THREE, archiveColumns, columnFiles, ROW_SPACING, MUSIC_MODEL, music, visibleCell, musicOverviewColumnExtent);

function projectionFixture(counts, { selectedLane = 0, browsingRow = 12, mode = 'realistic', overview = 0, width = 1280, height = 720 } = {}) {
  const genres = counts.map((_, lane) => ({ id: `g${lane}`, name: `列 ${lane}` }));
  const albums = genres.flatMap((genre, lane) => Array.from({ length: counts[lane] }, (_, index) => ({
    id: `${genre.id}-${index}`, title: `专辑 ${index}`, artist: '测试歌手', genreId: genre.id,
    rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
  })));
  setMusicAlbums(albums, genres);
  const framing = overviewFraming(width, height), yaw = THREE.MathUtils.degToRad(framing.yaw), elevation = THREE.MathUtils.degToRad(framing.elevation);
  const target = new THREE.Vector3(framing.aimColumns * COLUMN_SPACING, -1.8, -1.5);
  const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(framing.span / (2 * framing.distance))), width / height, .1, 500);
  camera.position.copy(target).addScaledVector(direction, framing.distance);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const selectedRow = Math.max(12, Math.min(11 + (counts[selectedLane] || 1), browsingRow));
  const musicRealColumns = new MusicRealColumns();
  musicRealColumns.reset(counts, { lane: selectedLane, row: selectedRow });
  const host = {
    columnSpacing: COLUMN_SPACING, loaded: true, looping: true, container: { clientWidth: width, clientHeight: height }, camera,
    columnExtentOffset: new THREE.Vector3(), coordinateOrigin: { lane: 0, row: 0 },
    laneFocus: { value: selectedLane }, shoulder: { value: browsingRow },
    musicArchiveMotion: new MusicArchiveMotion(), outgoing: [], pulses: [], pendingPulse: null,
    columnCamera: { value: (selectedLane - 2) * COLUMN_SPACING },
    selectedCell: { lane: selectedLane, row: mode === 'realistic' ? selectedRow : browsingRow },
    rail: { value: -2.17 - (browsingRow - 15.5) * ROW_SPACING },
    musicArrayMode: mode, musicOverview: { value: overview }, musicRealColumns,
    get musicBrowseRow() { return (-this.rail.value - 2.17) / ROW_SPACING + 15.5; },
    musicColumnCounts: counts, poolRows: MUSIC_LOOP_ROWS,
    ...productionMethods(),
  };
  const project = host.getOverviewColumns;
  // Assert against the screen position of a known actual card, rather than
  // reimplementing the clamp/nearest-occurrence algorithm under test.
  const actualCardAnchor = (lane, row) => {
    const center = mode === 'realistic' ? musicRealColumns.row(lane, host.musicOverview.value) : browsingRow;
    const point = new THREE.Vector3((lane - selectedLane) * COLUMN_SPACING,
      -4.6 + MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 + .65,
      -2.17 + (row - center) * ROW_SPACING).project(camera);
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  const assertAnchor = (label, lane, row, message) => {
    assert.ok(label, `${message}: label exists`);
    const expected = actualCardAnchor(lane, row);
    assert.ok(Math.abs(label.x - expected.x) < 1e-8 && Math.abs(label.y - expected.y) < 1e-8,
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify({ x: label.x, y: label.y })}`);
  };
  return { host, project, actualCardAnchor, assertAnchor, labels: () => project.call(host), width, height };
}

// Moving the camera one column right must move the same selected identity into
// the old left-neighbour position. Even the narrowest layout must retain its
// selected label and leave room for the arrow after the two-step expansion.
for (const [width, height] of [[320, 568], [390, 844], [1280, 720], [2560, 1080]]) {
  for (const [mode, selectedLane] of [
    ['realistic', 0], ['realistic', 2], ['realistic', 4],
    ['filled', -7], ['filled', -1], ['filled', 0], ['filled', 7],
  ]) {
    const counts = [3, 1, 5, 2, 8];
    const f = projectionFixture(counts, { mode, selectedLane, browsingRow: 16, overview: 1, width, height });
    const identity = { ...f.host.selectedCell };
    const selectedIndex = ((selectedLane % counts.length) + counts.length) % counts.length;
    f.host.pointer = new THREE.Vector2(.8, -.4);
    f.host.setMusicOverview(true);
    assert.equal(f.host.musicOverview.active, true);
    assert.deepEqual(f.host.pointer.toArray(), [0, 0], 'Overview enters with a stable pointer offset');
    const labels = f.labels(), selected = labels.find(label => label.selected);
    assert.equal(labels.filter(label => label.selected).length, 1, 'Exactly one logical column remains selected');
    assert.equal(selected.lane, selectedIndex, 'Real columns and negative filled wraps retain the selected identity');
    assert.ok(selected.x < width / 2, 'The selected column is visibly left of the screen centre');
    const visible = visibleOverviewLabels(labels, width, height, new Set(), selectedIndex);
    assert.ok(visible.some(label => label.selected), 'The selected column and its expanded arrow remain visible');

    const legacyCamera = f.host.camera.clone();
    legacyCamera.position.x -= COLUMN_SPACING;
    legacyCamera.updateMatrixWorld(true);
    const legacyLeft = new THREE.Vector3(-COLUMN_SPACING,
      -4.6 + MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 + .65, -2.17).project(legacyCamera);
    assert.ok(Math.abs(selected.x - (legacyLeft.x + 1) * width / 2) < 1e-8 &&
      Math.abs(selected.y - (1 - legacyLeft.y) * height / 2) < 1e-8,
      'The selected column occupies exactly the legacy camera\'s left-neighbour position');

    f.host.setMusicOverview(false);
    assert.equal(f.host.musicOverview.active, false);
    assert.deepEqual(f.host.selectedCell, identity, 'Returning to close view never changes the selected album');
  }
}

// Execute the production geometry transform: it must preserve the local base
// through rotation while leaving cover width and depth unchanged.
{
  const f = projectionFixture([1, 1, 1, 1, 1], { overview: 1 });
  const bottom = MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2;
  for (const rotation of [0, .08, -.08]) for (const extent of [.001, .2, .5, 1]) {
    const object = new THREE.Object3D();
    object.position.set(5, -4.6, 2);
    object.rotation.set(rotation, .15, 0);
    object.updateMatrixWorld(true);
    const base = object.localToWorld(new THREE.Vector3(0, bottom, 0));
    f.host.applyMusicColumnExtent(object, extent);
    object.updateMatrixWorld(true);
    assert.ok(object.localToWorld(new THREE.Vector3(0, bottom, 0)).distanceTo(base) < 1e-10,
      'Overview unfolding keeps each rotated case base fixed');
    assert.deepEqual(object.scale.toArray(), [1, extent, 1], 'Only vertical extent changes');
  }
  const before = f.labels().find(label => label.lane === 4);
  f.host.musicOverview.value = 0;
  const full = f.labels().find(label => label.lane === 4);
  assert.ok(before.y > full.y, 'A label follows its partially unfolded edge column');
}

for (const [width, height] of [[2560, 1080], [3806, 1622]]) {
  const f = projectionFixture(Array(10).fill(1), { overview: 1, width, height });
  for (const distance of [4.01, 4.2, 4.49, 4.5]) {
    const centerLane = 4 - distance;
    f.host.columnCamera.value = (centerLane - 2) * COLUMN_SPACING;
    const label = f.labels().find(column => column.lane === 4);
    assert.ok(label, 'Wide-screen labels retain live projection after the previous four-column cutoff');
    const extent = f.host.musicColumnExtent(4);
    assert.equal(label.extent, extent, 'UI receives the same continuous visibility as the case');
    const object = new THREE.Object3D();
    object.position.set(distance * COLUMN_SPACING, -4.6, -2.17);
    f.host.applyMusicColumnExtent(object, extent);
    object.updateMatrixWorld(true);
    if (extent > 0) {
      const point = object.localToWorld(new THREE.Vector3(0,
        MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 + .65, 0)).project(f.host.camera);
      assert.ok(Math.abs(label.x - (point.x + 1) * width / 2) < 1e-8 &&
        Math.abs(label.y - (1 - point.y) * height / 2) < 1e-8,
      'The retiring label follows the actual unfolded column in both screen axes');
    }
  }
  f.host.columnCamera.value = (-.51 - 2) * COLUMN_SPACING;
  assert.ok(!f.labels().some(column => column.lane === 4), 'Projection retires only beyond the zero-height boundary');
}

for (const [width, height] of [[393,852], [1280,720], [2560,1080]]) {
  const f = projectionFixture([50,1], { browsingRow: 61, width, height });
  const labels = f.labels();
  assert.deepEqual(labels.map(label => [label.lane, label.count, label.selected]), [[0,50,true], [1,1,false]]);
  f.assertAnchor(labels[0], 0, 61, 'The current long column stays attached to its 50th album');
  f.assertAnchor(labels[1], 1, 12, 'The one-album neighbour stays attached to its only album');
  const actual = Array.from({length:LOOP_COLUMNS*MUSIC_LOOP_ROWS}, (_,i)=>f.host.visibleMusicCell(i,{lane:0,row:61}))
    .filter(cell=>isRealAlbumCell(cell.lane,cell.row,[50,1]));
  assert.equal(actual.filter(cell=>cell.lane===1).length, 1,
    'A short neighbour remains rendered while the current column reaches its last album');
  assert.ok(Math.abs(labels[1].y - f.actualCardAnchor(1, 12).y) < 1e-8,
    'The one-album label stays on its centered actual card at every viewport size');
}

{
  const f = projectionFixture([50,3,50], { browsingRow: 18 });
  const labels = f.labels();
  f.assertAnchor(labels.find(label=>label.lane===1), 1, 13, 'A short inactive neighbour uses its middle album');
  f.assertAnchor(labels.find(label=>label.lane===2), 2, 36.5, 'A long inactive neighbour keeps its geometric midpoint');
}
{
  const f = projectionFixture([50,3], { browsingRow: 10 });
  for (const label of f.labels()) f.assertAnchor(label, label.lane,
    label.lane === 0 ? 12 : 13,
    'A global rail before the first row cannot displace an independently centered neighbour');
}
for (const [selectedLane, physicalLanes] of [[5,[6,4,5]], [-1,[0,-2,-1]]]) {
  const f = projectionFixture([50,1,3], { selectedLane, browsingRow: 61, mode: 'filled' });
  const labels = f.labels();
  assert.deepEqual(labels.map(label=>label.selected), [false,false,true]);
  for (const label of labels) f.assertAnchor(label, physicalLanes[label.lane], 61,
    'Filled mode retains the nearest repeated column and its active row in both directions');
}

// Repeated logical labels keep the same physical occurrence through small
// camera oscillations at a copy midpoint. These call the production projection,
// including its cache, rather than a separately implemented nearest-copy helper.
for (const period of [2, 8, 13]) {
  const f = projectionFixture(Array(period).fill(1), { mode: 'filled', overview: 1, width: 2560, height: 1080 });
  const at = (center) => {
    f.host.columnCamera.value = (center - 2) * COLUMN_SPACING;
    const labels = f.labels();
    for (const label of labels) {
      assert.ok((label.physicalLane - label.lane) % period === 0,
        'Every projected identity is an actual repeated physical column');
      assert.equal(label.extent, f.host.musicColumnExtent(label.physicalLane));
    }
    assert.ok(f.host.musicOverviewCopies.lanes.size <= period, 'Copy cache is bounded by the current library');
    return f.host.musicOverviewCopies.lanes.get(0);
  };
  const midpoint = period / 2;
  assert.equal(at(midpoint - .2), 0);
  for (let frame = 0; frame < 160; frame++) {
    const center = midpoint + Math.sin(frame * 1.91) * .149;
    assert.equal(at(center), 0, `${period} columns: midpoint jitter preserves the original occurrence`);
  }
  assert.equal(at(midpoint + .151), period, 'Crossing the positive hysteresis boundary changes physical identity');
  for (let frame = 0; frame < 160; frame++) {
    const center = midpoint + Math.sin(frame * 1.91) * .149;
    assert.equal(at(center), period, 'Returning inside the dead band does not bounce back');
  }
  assert.equal(at(midpoint - .151), 0, 'Crossing the negative boundary returns to the original occurrence');
  assert.equal(at(-midpoint + .2), 0);
  assert.equal(at(-midpoint - .151), -period, 'Negative copy indices have symmetric hysteresis');
  assert.equal(at(-midpoint + .151), 0);
  assert.equal(at(period * 30 + .1), period * 30, 'A large navigation jump immediately chooses the nearby occurrence');
  // Compare the retained copy's distance to the nearest candidate throughout
  // ordinary travel. A ±.15 midpoint hold adds at most .3 lane of distance.
  for (let step = 0; step < 500; step++) {
    const center = -period * 2 + step * period / 100;
    const physical = at(center), nearest = Math.round(center / period) * period;
    assert.ok(Math.abs(physical - center) - Math.abs(nearest - center) <= .3 + 1e-8,
      'Hysteresis cannot pin a stale copy farther than its bounded midpoint margin');
  }
  assert.equal(at(midpoint - .2), 0);
  assert.equal(at(midpoint + .1), 0);
  // The actual mode setter invalidates even if two changes occur before the
  // next projection; unloaded avoids unrelated model/selection construction.
  f.host.loaded = false;
  f.host.setMusicArrayMode('realistic');
  f.host.setMusicArrayMode('filled');
  f.host.loaded = true;
  assert.equal(at(midpoint + .1), period, 'Mode changes restart from the nearest occurrence');
  f.host.musicArrayMode = 'realistic';
  at(0);
  assert.ok(f.labels().every(label => label.physicalLane === label.lane), 'Real shelves always expose their own physical identity');
  assert.ok(f.labels().every(label => label.copyClearance === undefined), 'Real shelves have no repeated-copy handoff deadline');
  f.host.musicArrayMode = 'filled';
  assert.equal(at(midpoint + .1), period, 'Projection also detects direct mode replacement');
}

// Two/three-column loops can replace a fully visible occurrence well before
// any screen edge or folding cue. Its real handoff margin must warn a timed
// fade during ordinary slow travel, and stay stable when travel stops/reverses.
for (const period of [2, 3]) for (const direction of [-1, 1]) {
  const f = projectionFixture(Array(period).fill(8), { mode: 'filled', overview: 1 });
  const sample = center => {
    f.host.columnCamera.value = (center - 2) * COLUMN_SPACING;
    return f.labels().find(label => label.lane === 0);
  };
  const dt = 1 / 60, speed = .5, horizon = .32;
  let previous = sample(0), warnedAt, changedAt, beforeChange;
  assert.equal(previous.physicalLane, 0);
  for (let frame = 1; frame < 300; frame++) {
    const current = sample(direction * frame * dt * speed);
    assert.ok(current, 'A small-loop handoff still has a real projected physical column');
    if (current.physicalLane !== previous.physicalLane) {
      changedAt = frame * dt;
      beforeChange = previous;
      assert.equal(current.physicalLane, direction * period);
      assert.ok(current.copyClearance > .29, 'The replacement has its own fresh handoff margin');
      break;
    }
    const velocity = (current.copyClearance - previous.copyClearance) / dt;
    if (warnedAt === undefined && current.copyClearance + velocity * horizon <= 0)
      warnedAt = frame * dt;
    assert.ok(current.copyClearance < previous.copyClearance,
      'Continuous movement toward replacement continuously consumes the occurrence margin');
    previous = current;
  }
  assert.ok(changedAt !== undefined && warnedAt !== undefined, 'Production projection exposes both warning and actual handoff');
  assert.ok(changedAt - warnedAt >= .24 && changedAt - warnedAt <= horizon + dt,
    'A 320 ms same-identity forecast gives the old copy a complete 240 ms exit before replacement');
  assert.equal(beforeChange.extent, 1, 'Copy handoff is independently predicted while the old physical column remains fully unfolded');
  if (direction === 1) assert.ok(overviewBoundaryClearance(beforeChange, 1280, 720) > 30,
    'Positive slow handoffs require warning despite ample screen-boundary clearance');

  const stopped = sample(direction * (period / 2 + .1));
  for (let frame = 0; frame < 30; frame++)
    assert.deepEqual(sample(direction * (period / 2 + .1)), stopped,
      'A stationary camera cannot consume copy lifetime or bounce between identities');
  const returning = sample(direction * (period / 2 + .12));
  assert.equal(returning.physicalLane, stopped.physicalLane);
  assert.ok(returning.copyClearance > stopped.copyClearance,
    'Movement back toward the retained replacement restores its available margin');
}

// Execute the production coordinate rebase, not an equivalent helper. Local
// coordinates may reset after prolonged browsing; an unchanged physical column
// must retain its external identity or the UI will recreate and fade every name.
for (const period of [2, 3, 8, 13]) for (const direction of [-1, 1]) {
  const f = projectionFixture(Array(period).fill(1), {
    mode: 'filled', selectedLane: direction * 2051, browsingRow: direction * 2055,
    overview: 1, width: 2560, height: 1080,
  });
  // Start with an existing world origin as well as zero-origin coverage elsewhere.
  f.host.coordinateOrigin = { lane: period * 100, row: 4096 };
  for (const target of [direction * 2051, -direction * 2067]) {
    const travel = target - f.host.selectedCell.lane;
    f.host.selectedCell.lane = target;
    f.host.laneFocus.value += travel;
    f.host.columnCamera.value += travel * COLUMN_SPACING;
    const before = f.labels(), cached = new Map(f.host.musicOverviewCopies.lanes);
    const oldOrigin = { ...f.host.coordinateOrigin };
    const worldSelected = { lane: f.host.selectedCell.lane + oldOrigin.lane,
      row: f.host.selectedCell.row + oldOrigin.row };
    assert.ok(before.length > 0, 'The long-running fixture contains actual projected columns');
    f.host.rebaseCoordinates();
    const after = f.labels(), shift = f.host.coordinateOrigin.lane - oldOrigin.lane;
    assert.notEqual(shift, 0, 'The production threshold actually triggers a local lane rebase');
    assert.ok(Math.abs(f.host.selectedCell.lane) < period + 4, 'The local lane range is reduced');
    assert.deepEqual({ lane: f.host.selectedCell.lane + f.host.coordinateOrigin.lane,
      row: f.host.selectedCell.row + f.host.coordinateOrigin.row }, worldSelected,
    'Rebasing preserves the selected world-space album identity');
    assert.deepEqual(after.map(label => [label.lane, label.physicalLane, label.selected]),
      before.map(label => [label.lane, label.physicalLane, label.selected]),
      `${period} columns, direction ${direction}: external physical identities cannot change at a coordinate rebase`);
    for (const old of before) {
      const current = after.find(label => label.lane === old.lane);
      assert.ok(Math.abs(current.x - old.x) < 1e-8 && Math.abs(current.y - old.y) < 1e-8,
        'A coordinate rebase leaves every label at the same screen projection');
      assert.ok(Math.abs(current.extent - old.extent) < 1e-10,
        'A coordinate rebase preserves each column’s physical visibility envelope');
      assert.ok(Math.abs(current.copyClearance - old.copyClearance) < 1e-10,
        'A coordinate rebase cannot consume or reset the predicted copy-handoff margin');
      assert.equal(current.physicalLane,
        f.host.musicOverviewCopies.lanes.get(current.lane) + f.host.coordinateOrigin.lane,
        'Only the external identity includes the accumulated world origin');
    }
    for (const [lane, physical] of cached)
      assert.equal(f.host.musicOverviewCopies.lanes.get(lane), physical - shift,
        'The hysteresis cache remains local and translates with the camera');
    const settledOrigin = { ...f.host.coordinateOrigin };
    f.host.rebaseCoordinates();
    assert.deepEqual(f.host.coordinateOrigin, settledOrigin, 'A second stationary frame cannot rebase again');
    assert.deepEqual(f.labels(), after, 'A stationary post-rebase frame preserves identities and projection');
  }
}

// Same-sized replacement libraries must not inherit the previous view's
// hysteresis, and changed/empty libraries must not retain orphaned cache keys.
{
  const f = projectionFixture([1, 1], { mode: 'filled', overview: 1 });
  const at = (center) => {
    f.host.columnCamera.value = (center - 2) * COLUMN_SPACING;
    f.host.getOverviewColumns();
    return f.host.musicOverviewCopies.lanes.get(0);
  };
  assert.equal(at(.8), 0);
  assert.equal(at(1.1), 0);
  for (const count of [2, 8, 13, 2]) {
    projectionFixture(Array(count).fill(1), { mode: 'filled' }); // Synthetic replacement data only.
    Object.assign(f.host, productionMethods());
    assert.equal(at(count / 2 + .1), count, 'New library identity discards the previous copy decision');
    assert.equal(f.host.musicOverviewCopies.lanes.size, count, 'No old logical keys survive a library change');
  }
  setMusicAlbums([], []);
  Object.assign(f.host, productionMethods());
  assert.deepEqual(f.host.getOverviewColumns(), []);
  assert.equal(f.host.musicOverviewCopies, undefined, 'An empty library releases the occurrence cache');
}
{
  const f = projectionFixture([1]);
  f.host.loaded = false;
  assert.deepEqual(f.labels(), [], 'An unloaded scene must not expose stale labels');
  setMusicAlbums([], []);
  f.host.loaded = true;
  assert.deepEqual(productionMethods().getOverviewColumns.call(f.host), [], 'An empty library must have no labels');
}
// Full overview centers each column's geometric midpoint. Odd counts align
// their middle album and even counts straddle that same line with the middle pair.
const centeredCounts = [1, 2, 3, 4, 49, 100];
for (const browsingRow of [10, 12, 18.25, 61, 111]) {
  const f = projectionFixture(centeredCounts, { selectedLane: 2, browsingRow, overview: 1 });
  const labels = f.labels();
  assert.equal(labels.length, centeredCounts.length);
  for (const [lane, count] of centeredCounts.entries()) {
    const midpoint = 12 + (count - 1) / 2;
    const offset = f.host.musicColumnRowOffset(lane);
    assert.ok(Math.abs(midpoint + offset - browsingRow) < 1e-10, 'Every column shares the same visual center');
    if (count % 2) {
      assert.ok(Number.isInteger(midpoint), 'Odd columns align an actual middle album');
    } else {
      const lower = Math.floor(midpoint) + offset - browsingRow;
      const upper = Math.ceil(midpoint) + offset - browsingRow;
      assert.ok(Math.abs(lower + .5) < 1e-10 && Math.abs(upper - .5) < 1e-10,
        'Even columns place their middle albums half a row either side of the center');
    }
    f.assertAnchor(labels.find(label => label.lane === lane), lane, midpoint,
      'Overview labels follow the shared center for both odd and even counts');
  }
}

// Test the production pool mapping throughout the transition, including long
// columns whose middle albums lie beyond the original display window.
for (const browsingRow of [10, 12, 18.25, 61, 111]) {
  for (const overview of [0, .2, .5, .9, 1]) {
    const f = projectionFixture(centeredCounts, { selectedLane: 2, browsingRow, overview });
    const center = { lane: 2, row: browsingRow };
    const cells = Array.from({ length: LOOP_COLUMNS * MUSIC_LOOP_ROWS }, (_, index) => f.host.visibleMusicCell(index, center));
    const actual = cells.filter(cell => isRealAlbumCell(cell.lane, cell.row, centeredCounts));
    const identities = actual.map(cell => `${cell.lane}:${cell.row}`);
    assert.equal(new Set(identities).size, identities.length, 'Moving each column window must never duplicate an album');
    for (const [lane, count] of centeredCounts.entries()) {
      const midpoint = 12 + (count - 1) / 2;
      const activeRow = f.host.selectedCell.row;
      const expectedCenter = lane === 2 ? activeRow * (1 - overview) + midpoint * overview : midpoint;
      const expectedOffset = browsingRow - expectedCenter;
      assert.ok(Math.abs(f.host.musicColumnRowOffset(lane) - expectedOffset) < 1e-10,
        'Inactive columns cancel the global rail throughout the overview transition');
      const rows = cells.filter(cell => cell.lane === lane).map(cell => cell.row).sort((a, b) => a - b);
      assert.equal(rows.length, MUSIC_LOOP_ROWS);
      assert.equal(rows.at(-1) - rows[0], MUSIC_LOOP_ROWS - 1, 'A column window stays contiguous');
      const windowCenter = browsingRow - expectedOffset;
      for (const row of rows) {
        assert.ok(Number.isInteger(row), 'Visual shifts retain integer logical album identities');
        assert.ok(row - windowCenter >= -MUSIC_LOOP_ROWS / 2 - 1e-10 &&
          row - windowCenter < MUSIC_LOOP_ROWS / 2 + 1e-10, 'The render pool follows the shifted column center');
      }
      if (overview === 1 || lane !== 2) assert.equal(actual.filter(cell => cell.lane === lane).length, Math.min(count, MUSIC_LOOP_ROWS),
        'Centered inactive columns show every album up to the finite pool capacity, also in close view');
    }
    if (overview === 0) for (const lane of [0, 1, 3, 4, 5]) {
      const midpoint = 12 + (centeredCounts[lane] - 1) / 2;
      assert.ok(Math.abs(f.host.musicRealColumns.row(lane) - midpoint) < 1e-10,
        'Returning to close view keeps every inactive column centered');
    }
  }
}

for (const overview of [0, .5, 1]) {
  const f = projectionFixture([1, 2, 49, 100], { selectedLane: 2, browsingRow: 61, mode: 'filled', overview });
  const center = { lane: 2, row: 61 };
  for (let index = 0; index < LOOP_COLUMNS * MUSIC_LOOP_ROWS; index++) {
    const cell = f.host.visibleMusicCell(index, center);
    assert.deepEqual(cell, visibleCell(index, center, MUSIC_LOOP_ROWS), 'Filled arrays preserve their existing looping window');
    assert.equal(f.host.musicColumnRowOffset(cell.lane), 0, 'Filled arrays never receive a real-column shift');
  }
  for (const label of f.labels()) f.assertAnchor(label, [4, 1, 2, 3][label.lane], 61,
    'Filled labels keep their nearest repeated column and existing row at all overview progress values');
}
{
  const f = projectionFixture([1, 100], { browsingRow: 61, overview: 1 });
  Object.assign(f.host, productionMethods({ music: false }));
  assert.equal(f.host.musicColumnRowOffset(0), 0, 'Original archive arrays must not receive music overview centering');
  assert.equal(f.host.musicColumnRowOffset(1), 0);
  for (const lane of [-1, 2]) {
    assert.ok(Number.isFinite(productionMethods().musicColumnRowOffset.call(f.host, lane)),
      'Missing physical columns retain finite pool coordinates');
    assert.equal(isRealAlbumCell(lane, 12, [1, 100]), false, 'Missing physical columns stay masked');
  }
}
console.log('Overview: camera convergence at 20/30/60/120 fps, responsive labels, exact real-column counts/no duplicates, production projection for unequal real columns and filled loops, 2/8/13-column occurrence hysteresis, advance warning for 2/3-column copy handoffs, world-stable identities and handoff margins through positive/negative coordinate rebases, and library/mode resets, independent close-view centering, odd/even midpoints, moving column pool windows, viewport culling, unloaded/empty state passed.');
