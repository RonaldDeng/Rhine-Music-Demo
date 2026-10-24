import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { settlingWave, columnStrength } from '../src/motion.ts';
import * as motion from '../src/motion.ts';
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation } from '../src/music-camera.ts';
import { MusicArchiveMotion } from '../src/music-archive-motion.ts';
import { MusicRealColumns } from '../src/music-real-columns.ts';
import { MUSIC_COLUMN_SPACING } from '../src/music-model.ts';
import { ROW_SPACING } from '../src/archive-loop.ts';
import {
  MUSIC_INTRO_SHOT_START, MUSIC_INTRO_SAMPLE_RATE, MUSIC_INTRO_LAST_FRAME,
  MUSIC_INTRO_LANE_DELAY, musicIntroFrame, musicIntroPose,
  musicIntroLaneSettle, musicIntroWave, musicIntroLightRow,
} from '../src/music-intro-motion.ts';

const shotAt = frame => MUSIC_INTRO_SHOT_START + (frame - 1) / MUSIC_INTRO_SAMPLE_RATE;
const close = (actual, expected, message, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} vs ${expected}`);

close(musicIntroFrame(shotAt(1)), 1, 'First reference image uses sample 1');
close(musicIntroFrame(shotAt(120)), 120, '120 images cover 119 authored intervals');
close(shotAt(120) - shotAt(1), 4.76, 'Authored sweep duration');
close(musicIntroFrame(27.12), 131, 'Adapter leaves 0.44 seconds after sample 120');
assert.equal(MUSIC_INTRO_LANE_DELAY, 4);

// Test the whole delayed trajectory, including the gap between waves and the
// final blend. A row-only spatial phase shift would fail these equalities.
for (let frame = -20; frame <= 150; frame += 0.5) {
  for (let lane = -4; lane <= 4; lane++) {
    const shot = shotAt(frame);
    const shifted = shotAt(frame + lane * MUSIC_INTRO_LANE_DELAY);
    close(musicIntroLaneSettle(lane, shot), musicIntroLaneSettle(0, shifted),
      `Lane ${lane} keeps its complete settling delay at frame ${frame}`);
    for (const row of [-30, -12, 0, 7, 18, 31, 45]) {
      close(musicIntroWave(row, lane, shot), musicIntroWave(row, 0, shifted),
        `Lane ${lane} keeps its complete wave delay at frame ${frame}, row ${row}`);
    }
  }
}
assert.ok(musicIntroLaneSettle(4, shotAt(90)) > musicIntroLaneSettle(0, shotAt(90)));
assert.ok(musicIntroLaneSettle(0, shotAt(90)) > musicIntroLaneSettle(-4, shotAt(90)),
  'Far lanes settle before the near lanes, using the same fixed time offset');

function peak(frame) {
  let row = -60, value = -Infinity;
  for (let sample = -60; sample <= 70; sample += 0.1) {
    const height = musicIntroWave(sample, 0, shotAt(frame));
    if (height > value) { row = sample; value = height; }
  }
  return { row, value };
}
const forward = [20, 26, 32].map(peak);
assert.ok(forward[0].row < forward[1].row && forward[1].row < forward[2].row,
  'The first crest propagates along the positive row axis');
const returning = [54, 62, 72].map(peak);
assert.ok(returning[0].row > returning[1].row && returning[1].row > returning[2].row,
  'The later crest returns along the same axis');
assert.ok(forward.every(({ value }) => value > 1.4 && value <= 2.2));
assert.ok(returning.every(({ value }) => value > 0.7 && value < 1.7));

const endpoint = {
  yaw: 59, elevation: 25, span: 7.33, distance: 140,
  aimX: -1.091, aimY: -0.045, aimZ: 0.481, settle: 1, lift: 0.9,
};
for (let frame = MUSIC_INTRO_LAST_FRAME; frame <= 150; frame++) {
  for (const [key, expected] of Object.entries(endpoint)) {
    close(musicIntroPose(shotAt(frame))[key], expected, `Exact browsing endpoint ${key}`);
  }
  close(musicIntroLightRow(shotAt(frame)), 0, 'Lighting rests on the selected row');
  for (let lane = -4; lane <= 4; lane++) {
    close(musicIntroLaneSettle(lane, shotAt(frame)), 1, 'All nine lanes finish before the hold');
    for (const row of [-40, -12, 0, 12, 40])
      close(musicIntroWave(row, lane, shotAt(frame)), 0, 'No unobserved wave survives the final hold');
  }
}
close(musicIntroPose(shotAt(89)).lift, 0, 'Selection begins rising at sample 89');
assert.ok(musicIntroPose(shotAt(105)).lift > 0 && musicIntroPose(shotAt(105)).lift < 0.9);
assert.ok(musicIntroPose(shotAt(1)).aimZ - musicIntroPose(shotAt(15)).aimZ > 19,
  'Array entry is driven by a real axial camera displacement');
assert.ok(musicIntroPose(shotAt(32)).aimZ > musicIntroPose(shotAt(15)).aimZ,
  'The camera then follows the first crest along the row axis');

// Pure sampling must not acquire a frame-rate dependency or jump at authored
// segment boundaries. This covers replay/backward seeking as well as 30/120 Hz.
for (let frame = 1; frame <= 131; frame += 0.25) {
  const pose = musicIntroPose(shotAt(frame));
  for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
  assert.ok(pose.span >= 7.33 && pose.span <= 10.8 && pose.distance >= 38 && pose.distance <= 140);
  assert.ok(pose.lift >= 0 && pose.lift <= 0.9);
}
for (const frame of [1, 15, 32, 44, 45, 76, 80, 88, 89, 104, 112, 120]) {
  const before = musicIntroPose(shotAt(frame - 0.0001));
  const after = musicIntroPose(shotAt(frame + 0.0001));
  for (const key of Object.keys(endpoint))
    close(before[key], after[key], `Camera continuity at ${frame}: ${key}`, 0.002);
}
const at30 = Array.from({ length: 157 }, (_, index) => musicIntroPose(MUSIC_INTRO_SHOT_START + index / 30));
const at120 = Array.from({ length: 625 }, (_, index) => musicIntroPose(MUSIC_INTRO_SHOT_START + index / 120));
for (let index = 0; index < at30.length; index++) assert.deepEqual(at30[index], at120[index * 4]);
const replayOrder = [120, 30, 75, 1, 30, 120];
const replaySamples = replayOrder.map(frame => musicIntroPose(shotAt(frame)));
assert.deepEqual(replaySamples[0], replaySamples[5], 'Seeking backward preserves the same final pose');
assert.deepEqual(replaySamples[1], replaySamples[4], 'Seeking backward preserves intermediate poses');
console.log('Music intro reconstruction passed: shared four-sample lane delays across rise/return/settle, reversed crest travel, independent axial camera and lift, exact browsing hold, continuous and frame-rate-independent sampling.');

// Run the production field/entry expressions with real Three arithmetic. This
// catches integration that accidentally uses one global settle or logical row
// indices after independent finite columns have different physical origins.
const sceneSource = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const sceneTree = ts.createSourceFile('scene.ts', sceneSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sceneClass = sceneTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const update = sceneClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(sceneTree) === 'update');
const declarations = update.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]);
const fieldDeclaration = declarations.find(node => node.name.getText(sceneTree) === 'field');
const fieldCode = ts.transpileModule(`return function sceneField(row, lane, shot, selectedRow, selectedLane, time = 42, opening = true) {
  const motionTime = time;
  const musicIntro = opening, cinematic = opening ? { musicIntro: true } : undefined;
  const field = ${fieldDeclaration.initializer.getText(sceneTree)};
  return field(row, lane);
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const fieldDependencies = { THREE, musicIntroWave, musicIntroLaneSettle, musicLibrary: true, ...motion };
const sceneField = new Function(...Object.keys(fieldDependencies), fieldCode)(...Object.values(fieldDependencies));
for (const arrayMode of ['filled', 'realistic']) for (const selectedLane of [-8, 0, 2, 11]) {
  for (const selectedRow of [12, 47]) {
    const host = {
      musicArrayMode: arrayMode,
      idleGain: 1, reduced: false, coordinateOrigin: { row: 0, lane: 0 },
      musicColumnRowOffset: lane => arrayMode === 'filled' || lane === selectedLane ? 0 : (lane - selectedLane) * 7,
      musicRealColumnField: (row, lane) => .3 + .001 * (row - selectedRow) + .01 * (lane - selectedLane),
    };
    for (const frame of [20, 45, 76, 90, 104, 120, 131]) for (let relativeLane = -4; relativeLane <= 4; relativeLane++) {
      for (const physicalRow of [-20, 0, 10]) {
        const lane = selectedLane + relativeLane, shot = shotAt(frame);
        const row = selectedRow + physicalRow - host.musicColumnRowOffset(lane);
        const resting = arrayMode === 'realistic' ? host.musicRealColumnField(row, lane)
          : settlingWave(row - selectedRow, 26.56) * columnStrength(lane, selectedLane) + motion.idleWave(row, lane, 42);
        const expected = THREE.MathUtils.lerp(musicIntroWave(physicalRow, relativeLane, shot), resting,
          musicIntroLaneSettle(relativeLane, shot));
        close(sceneField.call(host, row, lane, shot, selectedRow, selectedLane), expected,
          'Production field follows physical rows and the lane-specific settling clock');
      }
    }
  }
}
const entryExpression = declarations.find(node => node.name.getText(sceneTree) === 'entryZ').initializer.getText(sceneTree);
const entryZ = new Function('musicIntro', 'cinematic', 'entranceTime', 'entry', `return ${entryExpression};`);
for (const progress of [0, .2, .7, 1]) {
  assert.equal(entryZ(true, {}, progress, progress), 0, 'The music camera dolly never also translates the shelf');
  close(entryZ(false, {}, progress, progress), -23 * (1 - progress) ** 2, 'The original film keeps its entry translation');
  close(entryZ(false, undefined, progress, progress), -28 * (1 - progress), 'Normal archive entry stays unchanged');
}
console.log('Music intro scene integration passed: physical row coordinates, independent lane settling, all selected origins, and isolated shelf-entry translation.');

// The handoff regression executes production mode changes, finish/skip methods,
// idle gating and the field itself. Only GPU/rendering and decryption are stubbed.
// Testing a standalone envelope would miss setMode resetting lastInteraction.
const methods = ['setMode', 'finishMusicIntro', 'showMusicArchiveImmediately', 'musicRealColumnField', 'cellPosition']
  .map(name => sceneClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(sceneTree) === name).getText(sceneTree));
const methodDependencies = {
  THREE, musicLibrary: true, ...motion, MusicCameraMotion, MusicPlacementMotion, MusicPresentation,
  MusicArchiveMotion, MUSIC_PREVIEW_LIFT: .9, ROW_SPACING,
  fileLocation: () => ({ row: 24, lane: 2 }), fileAtSlot: () => 0,
};
const methodCode = ts.transpileModule(`return { ${methods.join('\n')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const productionMethods = new Function(...Object.keys(methodDependencies), methodCode)(...Object.values(methodDependencies));
const idleDeclaration = declarations.find(node => node.name.getText(sceneTree) === 'idle');
const idleAssignment = update.body.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(sceneTree) === 'this.idleGain');
assert.ok(idleDeclaration && idleAssignment, 'Exercise the production idle eligibility and gain update');
const gainCode = ts.transpileModule(`return function advanceIdle(time, dt, opening) {
  const motionTime = time;
  const cinematic = opening ? { musicIntro: true } : undefined, musicIntro = opening;
  const aligningCopy = this.outgoing.some(o => o.returnY !== null);
  const idle = ${idleDeclaration.initializer.getText(sceneTree)};
  ${idleAssignment.getText(sceneTree)}
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const advanceIdle = new Function('THREE', 'musicLibrary', gainCode)(THREE, true);
function handoffFixture(arrayMode, reduced = false) {
  const real = new MusicRealColumns();
  const host = {
    ...productionMethods, loaded: true, reduced, musicArrayMode: arrayMode,
    musicColumnCounts: [6, 31, 60, 15, 93], selectedCell: { row: 24, lane: 2 }, selectedSlot: 0,
    musicRealColumns: real, musicOverview: { value: 0, active: false, reset() { this.value = 0; } },
    musicPresentation: new MusicPresentation(), musicCamera: new MusicCameraMotion(),
    musicPlacement: new MusicPlacementMotion(), musicArchiveMotion: new MusicArchiveMotion(),
    decryption: { enter() {}, leave() {}, select() {}, clarity: 0 },
    model: new THREE.Group(), camera: new THREE.PerspectiveCamera(), cameraAim: new THREE.Vector3(),
    columnSpacing: MUSIC_COLUMN_SPACING, coordinateOrigin: { row: 0, lane: 0 },
    pointer: new THREE.Vector2(), rotation: 0, targetRotation: 0, targetReveal: 1, targetDetail: 0, detail: 0,
    reveal: 1, idleGain: 0, lastInteraction: 100, clock: 100, last: 100,
    scanTime: 29.1, scanBlend: 0, pulses: [], outgoing: [], returnY: null, pendingPulse: null,
    shoulder: { value: 24, velocity: 0 }, laneFocus: { value: 2, velocity: 0 },
    rail: { value: -2.17 - (24 - 15.5) * ROW_SPACING, velocity: 0 },
    columnCamera: { value: 0, velocity: 0 }, lift: { value: .9, velocity: 0 },
    pulseGain: 1, deferSelectionPulse: false,
    scene: { remove() {} }, appearance: { dispose() {} },
    musicColumnRowOffset(lane) { return arrayMode === 'filled' ? 0 : this.selectedCell.row - real.row(lane); },
    get musicBrowseRow() { return this.selectedCell.row; },
    update(time) { advanceIdle.call(this, time, 0, false); },
  };
  real.reset(host.musicColumnCounts, host.selectedCell);
  host.camera.position.set(-40, 25, 30);
  return host;
}
const fieldPoints = [[24, 2], [20, 2], [32, 2], [15, 0], [23, 1], [17, 3], [55, 4]];
function sampleField(host, time, opening, shot = 27.12) {
  return fieldPoints.map(([row, lane]) => sceneField.call(host, row, lane, shot,
    host.selectedCell.row, host.selectedCell.lane, time, opening));
}
const vectorClose = (actual, expected, message, tolerance = 1e-10) => {
  actual.forEach((value, index) => close(value, expected[index], `${message} [${index}]`, tolerance));
};
let handoffCases = 0;
for (const arrayMode of ['filled', 'realistic']) for (const hz of [30, 60, 120]) for (const handoffTime of [111.6, 308.75]) {
  const host = handoffFixture(arrayMode), dt = 1 / hz;
  // The real opening code owns idle gain before the endpoint; no test-side
  // assignment is allowed to hide an unwanted cinematic reset to zero.
  advanceIdle.call(host, handoffTime - dt, dt, true);
  const before = sampleField(host, handoffTime - dt, true);
  advanceIdle.call(host, handoffTime, dt, true);
  const endpointField = sampleField(host, handoffTime, true);
  assert.equal(host.idleGain, 1, 'The completed opening already contains normal drift');
  host.finishMusicIntro(handoffTime);
  assert.equal(host.idleGain, 1, 'finishMusicIntro preserves the rendered drift gain');
  assert.ok(handoffTime - host.lastInteraction > 2.5, 'Automatic completion survives setMode without rearming the user inactivity gate');
  advanceIdle.call(host, handoffTime, 0, false);
  const afterSameTime = sampleField(host, handoffTime, false);
  vectorClose(afterSameTime, endpointField, 'C0: cinematic and normal surfaces agree at the exact handoff');
  advanceIdle.call(host, handoffTime + dt, dt, false);
  const after = sampleField(host, handoffTime + dt, false);
  const leftVelocity = before.map((value, i) => (endpointField[i] - value) / dt);
  const rightVelocity = after.map((value, i) => (value - afterSameTime[i]) / dt);
  vectorClose(leftVelocity, rightVelocity, `C1: drift velocity survives ${hz} Hz handoff`, .002);
  assert.ok(after.some((value, i) => Math.abs(value - endpointField[i]) > 1e-5),
    'The first normal frame continues moving, without a fixed idle plateau');
  const holdStart = sampleField(host, handoffTime - .44, true, shotAt(120));
  assert.ok(holdStart.some((value, i) => Math.abs(value - endpointField[i]) > .001),
    'The final camera hold continues the album surface drift');
  for (let frame = 1; frame <= hz * 3; frame++) {
    advanceIdle.call(host, handoffTime + frame / hz, dt, false);
    assert.equal(host.idleGain, 1, 'No reset or delayed restart occurs after completion');
  }
  // Genuine mode/navigation interactions retain the established 2.5 s guard.
  host.clock = handoffTime + 4;
  host.setMode('archive');
  assert.equal(host.lastInteraction, host.clock, 'Normal setMode still records user interaction');
  const priorGain = host.idleGain;
  advanceIdle.call(host, host.clock + dt, dt, false);
  assert.ok(host.idleGain < priorGain, 'A real user interaction still suppresses drift');
  host.clock += 1;
  host.setMode('hidden');
  advanceIdle.call(host, host.clock + dt, dt, true);
  assert.equal(host.idleGain, 1, 'Replay restores the cinematic drift target');
  const replayEnd = host.clock + 12;
  const replayField = sampleField(host, replayEnd, true);
  host.finishMusicIntro(replayEnd);
  advanceIdle.call(host, replayEnd, 0, false);
  vectorClose(sampleField(host, replayEnd, false), replayField, 'Replay has the same continuous handoff');
  handoffCases++;
}
for (const arrayMode of ['filled', 'realistic']) for (const reduced of [false, true]) {
  const host = handoffFixture(arrayMode, reduced);
  host.showMusicArchiveImmediately(200);
  assert.equal(host.idleGain, 0, 'Skipping first renders the existing settled archive');
  assert.ok(200 - host.lastInteraction > 2.5, 'Skip does not add a new inactivity delay');
  advanceIdle.call(host, 200 + 1 / 60, 1 / 60, false);
  if (reduced) {
    assert.equal(host.idleGain, 0);
    vectorClose(sampleField(host, 200, false), sampleField(host, 202, false),
      'Reduced motion remains static in every column');
  } else {
    assert.ok(host.idleGain > 0 && host.idleGain < .02, 'Skipping begins a gentle drift immediately on the next frame');
  }
}
console.log(`Music intro handoff passed: ${handoffCases} actual-scene C0/C1 cases at 30/60/120 Hz, filled/realistic surfaces, mode-reset protection, uninterrupted hold drift, replay, skip, and reduced motion.`);
