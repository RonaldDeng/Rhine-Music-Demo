import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicArchiveOffset, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor } from '../src/music-camera.ts';
import { damp, smooth, settlingWave } from '../src/motion.ts';
import { MusicArchiveMotion } from '../src/music-archive-motion.ts';
import { COLUMN_SPACING as ORIGINAL_COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';
import { archiveFraming } from '../src/viewport-layout.ts';
import { overviewFraming } from '../src/music-overview.ts';
import { MUSIC_MODEL, MUSIC_COLUMN_SPACING as COLUMN_SPACING } from '../src/music-model.ts';
import { musicIntroPose } from '../src/music-intro-motion.ts';

// Run the scene's actual camera target construction: a unit-only test of the
// dolly would miss the speed-driven yaw layered on top by ArchiveScene.update.
const sceneSource = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const sceneTree = ts.createSourceFile('scene.ts', sceneSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sceneClass = sceneTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
// Execute the real constructor field expression so the original archive keeps
// its historical spacing while music uses the revised geometry-aware spacing.
const spacingField = sceneClass.members.find(node => ts.isPropertyDeclaration(node) && node.name.getText(sceneTree) === 'columnSpacing');
assert.ok(spacingField?.initializer, 'The scene owns its spacing per instance');
const sceneSpacing = new Function('musicLibrary', 'MUSIC_COLUMN_SPACING', 'COLUMN_SPACING',
  `return ${spacingField.initializer.getText(sceneTree)};`);
assert.equal(sceneSpacing(true, COLUMN_SPACING, ORIGINAL_COLUMN_SPACING), COLUMN_SPACING);
assert.equal(sceneSpacing(false, COLUMN_SPACING, ORIGINAL_COLUMN_SPACING), 5.2,
  'The original archive retains its 5.2-unit column spacing');
const updateNode = sceneClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(sceneTree) === 'update');
const cameraStatements = [...updateNode.body.statements];
const cameraStart = cameraStatements.findIndex(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(sceneTree) === 'orbit'));
const cameraEnd = cameraStatements.findIndex((node, i) => i > cameraStart && ts.isIfStatement(node) &&
  node.thenStatement.getText(sceneTree).includes('this.musicCamera.update('));
assert.ok(cameraStart >= 0 && cameraEnd > cameraStart, 'Extract the production camera target path');
const cameraDependencies = { THREE, ease: smooth, musicLibrary: true, ROW_SPACING,
  archiveFraming, overviewFraming, musicArchiveOffset, settlingWave, MUSIC_MODEL,
  musicIntroPose, musicCinematicPose, musicExtractionAnchor,
  MUSIC_INSPECTION_LIFT: MUSIC_MODEL.height + .12, MUSIC_DETAIL_ELEVATION: THREE.MathUtils.degToRad(20) };
const cameraFactory = ts.transpileModule(`return function cameraTargets(dt, overview = 0, options = {}) {
  const cinematic = options.cinematic, musicLibrary = options.musicLibrary ?? true;
  const musicIntro = Boolean(musicLibrary && cinematic?.musicIntro);
  const shot = options.shot ?? 29.1, detail = options.detail ?? 0;
  const introPose = musicIntro ? musicIntroPose(shot) : undefined;
  const introSettle = introPose?.settle ?? 0;
  ${cameraStatements.slice(cameraStart, cameraEnd).map(node => node.getText(sceneTree)).join('\n')}
  return { position: cameraPosition, aim: cameraAim, span: framing.span, direction: viewDirection, distance };
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const productionCameraTargets = new Function(...Object.keys(cameraDependencies), cameraFactory)(...Object.values(cameraDependencies));

// Exercise the real opening camera branch through every framing surface. The
// old film used model-corner anchoring; moving that model here detects any old
// anchor or pan accidentally surviving in the new music-only shot.
function introCameraHost(width, height, selectedLane = 2) {
  return {
    container: { clientWidth: width, clientHeight: height, closest: () => null },
    musicCamera: { navigationElevation: () => 0 }, musicArrayMode: 'filled',
    rail: { value: -2.17, velocity: 0 }, columnSpacing: COLUMN_SPACING,
    pointer: new THREE.Vector2(), reduced: false,
    musicPresentation: { holdsDetail: false },
    model: { position: new THREE.Vector3((selectedLane - 2) * COLUMN_SPACING, -1.5, -2.17) },
  };
}
const cameraClose = (actual, expected, message) =>
  assert.ok(actual.distanceTo(expected) < 1e-10, `${message}: ${actual.toArray()} vs ${expected.toArray()}`);
for (const [width, height] of [[1920, 1080], [3440, 1440], [1024, 768], [390, 844]]) {
  for (const selectedLane of [-8, 0, 2, 11]) {
    const host = introCameraHost(width, height, selectedLane);
    for (const frame of [1, 15, 32, 45, 60, 75]) {
      const shot = 21.92 + (frame - 1) / 25, pose = musicIntroPose(shot);
      const result = productionCameraTargets.call(host, 0, 0, { shot, cinematic: { musicIntro: true } });
      cameraClose(result.aim, new THREE.Vector3(pose.aimX, pose.aimY, pose.aimZ),
        'Early music opening uses the independent axial target without old corner tracking');
      const yaw = THREE.MathUtils.degToRad(pose.yaw), elevation = THREE.MathUtils.degToRad(pose.elevation);
      cameraClose(result.direction, new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation),
        Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation)), 'The authored music heading survives scene integration');
      assert.ok(Math.abs(result.position.distanceTo(result.aim) - pose.distance) < 1e-10);
    }
    const archive = productionCameraTargets.call(host, 0);
    for (const shot of [21.92 + 119 / 25, 27.12]) {
      const result = productionCameraTargets.call(host, 0, 0, { shot, cinematic: { musicIntro: true } });
      cameraClose(result.position, archive.position, 'The opening ends at the actual browsing position');
      cameraClose(result.aim, archive.aim, 'The opening ends at the actual browsing aim, including portrait');
      assert.equal(result.span, archive.span, 'The opening and browser use the same responsive visible height');
    }
  }
}
// Captured from the pre-reconstruction original camera, with this same model
// position and viewport. It covers the original film's late corner-tracking
// branch; the new music-only sampler must never change this result.
const originalHost = introCameraHost(1920, 1080);
originalHost.columnSpacing = ORIGINAL_COLUMN_SPACING;
const originalFilm = productionCameraTargets.call(originalHost, 0, 0,
  { cinematic: {}, musicLibrary: false, shot: 26.1 });
cameraClose(originalFilm.position, new THREE.Vector3(-111.46422398457192, 46.27732925810111, 65.43494614783081),
  'The original film retains its pre-reconstruction camera position');
cameraClose(originalFilm.aim, new THREE.Vector3(-1.6638981203903576, .6328916229944999, .3391327840981188),
  'The original film retains its pre-reconstruction camera anchor');
assert.equal(originalFilm.span, 7.455538747873798);

function verifyColumnHeading({ hz, guided, reverse, overview, width, height, pointer, reduced }) {
  const camera = new THREE.PerspectiveCamera(), aim = new THREE.Vector3();
  const motion = new MusicCameraMotion(), travel = new MusicArchiveMotion();
  const tracks = Object.fromEntries(['rail', 'column', 'shoulder', 'lane'].map(key => [key, { value: 0, velocity: 0 }]));
  const host = { container: { clientWidth: width, clientHeight: height, closest: () => null },
    columnSpacing: COLUMN_SPACING, musicCamera: motion, columnCamera: tracks.column, rail: tracks.rail,
    musicArrayMode: 'realistic', musicPresentation: { holdsDetail: false },
    pointer: new THREE.Vector2(...pointer), reduced };
  let targets;
  const retarget = lane => {
    targets = { rail: 0, shoulder: 0, column: lane * COLUMN_SPACING, lane };
    if (guided) travel.retarget(tracks, targets);
  };
  const initial = productionCameraTargets.call(host, 0, overview);
  motion.update(camera, aim, initial.position, initial.aim, initial.span, 0, true);
  const initialDirection = camera.getWorldDirection(new THREE.Vector3());
  let maxDirectionError = 0, moved = 0;
  retarget(1);
  for (let frame = 0; frame < hz * 6; frame++) {
    if (reverse && frame === Math.round(hz * .42)) retarget(4);
    if (reverse && frame === Math.round(hz * .88)) retarget(-2);
    if (guided) travel.update(tracks, 1 / hz, reduced);
    else for (const key of Object.keys(tracks)) {
      if (reduced) Object.assign(tracks[key], { value: targets[key], velocity: 0 });
      else damp(tracks[key], targets[key], 3.7, 1 / hz);
    }
    const target = productionCameraTargets.call(host, 1 / hz, overview);
    motion.update(camera, aim, target.position, target.aim, target.span, 1 / hz, reduced);
    maxDirectionError = Math.max(maxDirectionError,
      camera.getWorldDirection(new THREE.Vector3()).distanceTo(initialDirection));
    moved = Math.max(moved, Math.abs(tracks.column.value));
  }
  assert.ok(moved > COLUMN_SPACING * .9, 'The regression performs real column travel');
  assert.ok(Math.abs(tracks.column.value - targets.column) < .0001, 'Column movement retains its endpoint');
  assert.ok(maxDirectionError < 1e-12,
    `Cross-column motion keeps its camera heading through travel and settling (${JSON.stringify({ hz, guided, reverse, overview, width, reduced })}); direction drift ${maxDirectionError}`);
}

for (const hz of [30, 60, 120]) for (const guided of [false, true]) for (const reverse of [false, true]) {
  for (const overview of [0, 1]) for (const [width, height] of [[1440, 900], [390, 844]]) {
    for (const reduced of [false, true]) verifyColumnHeading({ hz, guided, reverse, overview, width, height,
      pointer: [.75, .6], reduced });
  }
}

for (const [width, height] of [[390, 844], [1080, 1920], [1049, 1000], [0, 0]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: 0, y: 0 },
    'Portrait retains its own camera composition, including at the layout boundary');
}
for (const [width, height] of [[1050, 1000], [1024, 768], [1440, 900], [1920, 1080], [1280, 720]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: 0, y: .08 },
    'Every landscape view through 16:9 reserves eight percent of its height above the raised album');
}
const halfwayOffset = musicArchiveOffset(2220, 1080);
assert.ok(Math.abs(halfwayOffset.x - .0175) < 1e-12 && Math.abs(halfwayOffset.y - .09) < 1e-12,
  'Intermediate wide screens gradually move left and add vertical headroom');
for (const [width, height] of [[2520, 1080], [2560, 1080], [3840, 1080]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: .035, y: .1 },
    'Wide-screen movement is capped at 3.5 percent horizontally and ten percent vertically');
}
const scaleIndependent = musicArchiveOffset(3814, 1656), sameAspect = musicArchiveOffset(1907, 828);
assert.deepEqual(scaleIndependent, sameAspect, 'Matching aspect ratios use matching composition at different pixel densities');
for (const width of [1920, 2520]) {
  const before = musicArchiveOffset(width - .01, 1080), after = musicArchiveOffset(width + .01, 1080);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-10,
    'The 16:9 and 21:9 framing joins have no position or velocity jump');
}

function setup() {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3();
  camera.position.set(-62, 36, 43);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(7.33 / (2 * camera.position.length())));
  const motion = new MusicCameraMotion();
  motion.observe(camera, aim, 0);
  return { camera, aim, motion };
}
const span = (camera, aim) => 2 * camera.position.distanceTo(aim) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const target = new THREE.Vector3(-20, 17, 67), focus = new THREE.Vector3(2, 1, 0);
const a = setup(), b = setup();
const start = a.camera.position.clone();
a.motion.update(a.camera, a.aim, target, focus, 7.33, .1, false);
for (let frame = 0; frame < 12; frame++) b.motion.update(b.camera, b.aim, target, focus, 7.33, 1 / 120, false);
assert.ok(a.camera.position.distanceTo(b.camera.position) < 1e-9, 'Dolly is stable across frame rates');
assert.ok(a.aim.distanceTo(b.aim) < 1e-9);
assert.ok(a.camera.position.distanceTo(start) < target.distanceTo(start) * .25, 'The first 100 ms starts gently');
assert.ok(Math.abs(span(a.camera, a.aim) - 7.33) < 1e-9, 'Distance change does not produce a scale pulse');
const before = a.camera.position.clone();
a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 7.33, 1 / 120, false);
assert.ok(a.camera.position.x > before.x, 'A rapid reversal preserves existing velocity before braking');
for (let frame = 0; frame < 300; frame++) a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 5.9, 1 / 60, false);
assert.ok(a.camera.position.distanceTo(start) < 1e-10 && Math.abs(span(a.camera, a.aim) - 5.9) < 1e-10, 'Camera settles to exact framing');
a.motion.update(a.camera, a.aim, target, focus, 5.9, 0, true);
assert.deepEqual(a.camera.position.toArray(), target.toArray(), 'Reduced motion snaps');
assert.deepEqual(a.aim.toArray(), focus.toArray());

const film = setup();
film.camera.position.x += .1;
film.motion.observe(film.camera, film.aim, 1 / 60);
const handoff = film.camera.position.clone();
film.motion.update(film.camera, film.aim, handoff, film.aim.clone(), 7.33, 1 / 120, false);
assert.ok(film.camera.position.x > handoff.x, 'Opening camera velocity survives the interactive handoff');
assert.ok(film.camera.position.distanceTo(handoff) < .1, 'Handoff is continuous');

assert.deepEqual(musicExtractionAnchor(27.3), { x: 518, y: 288 }, 'Extraction starts at the previous shot corner');
const next = musicExtractionAnchor(27.3 + .001);
assert.ok(Math.hypot(next.x - 518, next.y - 288) < .000001, 'The shot boundary has no anchor jump');
const end = musicExtractionAnchor(34);
assert.deepEqual(end, { x: 420, y: 330 }, 'Oblique inspection holds its corner before the separate centering move');
assert.deepEqual(musicCinematicPose(29), musicCinematicPose(32.5), 'The close oblique shot has a real inspection pause');
const front = musicCinematicPose(34.56);
assert.deepEqual(front, { yaw: 0, elevation: 0, centered: 1, detail: 1 }, 'Film finishes face-on and centered');
const navigation = setup();
for (let frame = 0; frame < 180; frame++) {
  const elevation = navigation.motion.navigationElevation(-5, 0, 1 / 60, false);
  assert.ok(Math.abs(elevation) <= .006, 'Filled-array vertical browsing retains its subtle elevation');
}
assert.equal(navigation.motion.navigationElevation(10, 0, 0, true), 0);

function verifyPresentation(hz, reduced = false) {
  const presentation = new MusicPresentation();
  const pan = new MusicPlacementMotion();
  const rig = setup();
  const archiveCamera = rig.camera.position.clone();
  const detailAim = new THREE.Vector3(2.6222222222, 1.85, 0);
  const yaw = THREE.MathUtils.degToRad(8), elevation = THREE.MathUtils.degToRad(20);
  const detailCamera = detailAim.clone().addScaledVector(new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation),
  ), 72);
  const pose = (progress) => ({
    aim: detailAim.clone().multiplyScalar(progress),
    camera: archiveCamera.clone().lerp(detailCamera, progress),
    height: 7.33 + (5.9 - 7.33) * progress,
  });
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Extraction and placement start in the same phase');
  assert.equal(presentation.placed, true, 'The shared movement starts without a frontal-centering gate');
  assert.equal(presentation.holdsDetail, true);
  const history = [presentation.phase];
  presentation.update(1, false, true, reduced);
  assert.equal(presentation.phase, 'placing', 'Placement readiness cannot bypass a moving camera');
  presentation.update(1, true, false, reduced);
  assert.equal(presentation.phase, 'placing', 'Camera readiness cannot bypass a moving extraction');
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    if (frame === 0) assert.ok(progress > 0, 'The first entry frame advances the common movement');
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) {
      history.push(presentation.phase);
      assert.ok(pan.settled, 'Presentation waits for the common extraction and placement endpoint');
      assert.ok(rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height),
        'Presentation also waits for the displayed camera to settle');
    }
    if (presentation.phase === 'presented') break;
  }
  assert.deepEqual(history, ['placing', 'presented']);
  const displayedDirection = rig.camera.position.clone().sub(rig.aim).normalize();
  assert.ok(Math.abs(Math.asin(displayedDirection.y) - elevation) < .001,
    'The displayed detail camera preserves the elevated inspection angle');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-center');
  presentation.returnWhenAligned(false);
  presentation.update(1, true, true, reduced);
  assert.equal(presentation.phase, 'returning-center', 'A manually rotated box must align before returning');
  assert.equal(presentation.holdsDetail, true, 'Alignment holds the shared extraction and camera endpoint');
  assert.equal(pan.update(Number(presentation.holdsDetail), 1 / hz, reduced), 1);
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An aligned box begins the common return immediately');
  assert.equal(presentation.holdsDetail, false);
  history.push(presentation.phase);
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) history.push(presentation.phase);
    if (presentation.phase === 'archive') break;
  }
  assert.deepEqual(history, ['placing', 'presented', 'returning-array', 'archive']);
  presentation.request('detail');
  presentation.request('archive');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An unrotated entry can reverse on its first return frame');
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Rapid reversal resumes the same shared movement');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'placing', 'A stale alignment signal cannot undo a reopened detail');
  presentation.request('hidden');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'hidden', 'Replay clears all readiness');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-array', 'Skip waits for the archive camera');
}
verifyPresentation(30);
verifyPresentation(120);
verifyPresentation(30, true);

function measurePan(hz) {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3(0, 1.85, 0);
  camera.position.set(0, 1.85, 72);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(5.9 / 144));
  const motion = new MusicCameraMotion(), pan = new MusicPlacementMotion();
  motion.observe(camera, aim, 0);
  const shift = 5.9 * 16 / 9 * .25;
  let early = 0, t95 = null, previous = 0;
  for (let frame = 1; frame <= hz * 3; frame++) {
    const progress = pan.update(1, 1 / hz, false);
    const targetAim = new THREE.Vector3(progress * shift, 1.85, 0);
    const targetCamera = targetAim.clone().add(new THREE.Vector3(0, 0, 72));
    motion.update(camera, aim, targetCamera, targetAim, 5.9, 1 / hz, false);
    const displayed = aim.x / shift;
    assert.ok(displayed >= previous && displayed <= 1 + 1e-10, 'A full pan has no reversal or overshoot');
    previous = displayed;
    if (frame === hz / 5) early = displayed;
    if (t95 === null && displayed >= .95) t95 = frame / hz;
  }
  assert.ok(early < .005, 'The first 200 ms gently accelerates instead of travelling half the distance');
  assert.ok(t95 > 1.4 && t95 < 1.55, 'Actual 95% travel follows the long deceleration timing');
  return { early, t95 };
}
const pan30 = measurePan(30), pan120 = measurePan(120), pan240 = measurePan(240);
assert.ok(Math.abs(pan30.t95 - pan120.t95) < .05, 'Pan timing is stable at 30 and 120 Hz');
const interruptedPan = new MusicPlacementMotion();
interruptedPan.update(1, .55, false);
const state = [interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration];
interruptedPan.update(0, 0, false);
assert.deepEqual([interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration], state,
  'Retargeting the pan preserves position, velocity and acceleration');
interruptedPan.update(0, 1e-5, false);
assert.ok(Math.abs(interruptedPan.value - state[0]) < .0001 && Math.abs(interruptedPan.velocity - state[1]) < .001,
  'The first interrupted frame is continuous');
interruptedPan.update(1, 0, true);
assert.equal(interruptedPan.value, 1);
assert.equal(interruptedPan.velocity, 0);
assert.equal(interruptedPan.settled, true);

for (const hz of [30, 120]) {
  const presentation = new MusicPresentation();
  presentation.request('archive');
  presentation.update(.1, true, true, false);
  assert.equal(presentation.phase, 'archive');
  const tracks = Object.fromEntries(['rail', 'column', 'shoulder', 'lane'].map(key => [key, { value: 0, velocity: 0 }]));
  let targets = { rail: -.62, column: COLUMN_SPACING, shoulder: 1, lane: 1 };
  presentation.selectionChanged();
  assert.equal(presentation.phase, 'returning-array', 'Selecting a new cell invalidates readiness immediately');
  for (let frame = 0; frame < hz / 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'returning-array', 'A settled camera cannot bypass the moving selection tracks');
  const previousSpeed = tracks.column.velocity;
  targets = { rail: -1.24, column: -COLUMN_SPACING, shoulder: 2, lane: -1 };
  presentation.selectionChanged();
  assert.equal(tracks.column.velocity, previousSpeed, 'Rapid browsing keeps the existing track velocity');
  for (let frame = 0; frame < hz * 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'archive', 'Readiness returns after all selected-cell tracks settle');
  for (const key of Object.keys(tracks)) {
    const speed = tracks[key].velocity;
    tracks[key].velocity = .1;
    assert.equal(musicArchiveTracksSettled(tracks, targets), false, `${key} velocity must settle too`);
    tracks[key].velocity = speed;
  }
}
console.log('Music camera passed: fixed heading across single/multiple/reversed column travel and settling (30/60/120 Hz, spring/guided, preview/overview, landscape/portrait, pointer offset, reduced motion); landscape framing, continuous motion, film handoff, shared entry/return, elevated detail and interruption.');
console.log(`Presentation pan: ${(pan240.early * 100).toFixed(3)}% at 0.2 s; 95% at ${pan240.t95.toFixed(3)} s (rendered camera, 240 Hz).`);
