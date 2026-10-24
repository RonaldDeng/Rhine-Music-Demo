import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const urls = new Map();
function sourceModule(path) {
  const url = new URL(path, import.meta.url);
  if (urls.has(url.href)) return urls.get(url.href);
  const source = fs.readFileSync(url, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_, q, specifier) =>
    `from ${JSON.stringify(specifier.startsWith('.') ? sourceModule(new URL(/\.\w+$/.test(specifier) ? specifier : `${specifier}.ts`, url)) : import.meta.resolve(specifier))}`);
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  urls.set(url.href, result);
  return result;
}
const { setMusicMotionSpeed, getMusicMotionSpeed } = await import(sourceModule('../src/music-motion-settings.ts'));
const { setupMusicCssMotion } = await import(sourceModule('../src/music-css-motion.ts'));
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} / ${b}`);

// Model browser semantics: a running transition retains its initial duration;
// a CSS keyframe re-resolves its duration when a referenced variable changes.
class TestTransition {
  playState = 'running'; pending = false; playbackRate = 1; currentTime = 120;
  updatePlaybackRate(rate) { this.playbackRate = rate; }
}
class TestKeyframe extends TestTransition {
  currentTime = 4100;
  effect = { getTiming: () => ({ duration: 1300 / getMusicMotionSpeed(), delay: 200 / getMusicMotionSpeed() }) };
}
globalThis.CSSAnimation = TestKeyframe;
globalThis.CSSTransition = TestTransition;
const transition = new TestTransition(), keyframe = new TestKeyframe();
// Keep the test classes distinct as native CSSAnimation / CSSTransition are.
Object.setPrototypeOf(TestKeyframe.prototype, Object.prototype);
let cssSpeed = 1;
keyframe.effect.getTiming = () => ({ duration: 1300 / cssSpeed, delay: 200 / cssSpeed });
const root = { style: { setProperty(_key, value) { cssSpeed = 1 / Number(value); } }, getAnimations: () => [transition, keyframe] };
const dispose = setupMusicCssMotion(root);
const iterationProgress = (keyframe.currentTime - 200) / 1300;
for (const speed of [.25, 3, .25, 1]) {
  const time = transition.currentTime;
  setMusicMotionSpeed(speed);
  close(transition.playbackRate, speed, 'An existing transition scales once across rapid retiming');
  assert.equal(transition.currentTime, time, 'Changing speed preserves the displayed transition position');
  close((keyframe.currentTime - 200 / speed) / (1300 / speed), iterationProgress,
    'A repeating CSS animation preserves both loop count and phase');
}
dispose();
setMusicMotionSpeed(3);
close(cssSpeed, 1, 'Disposed CSS listener no longer writes');
setMusicMotionSpeed(1);

// Compile the production scene clock statements, not a duplicate equation.
const sceneSource = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('scene.ts', sceneSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const update = klass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(tree) === 'update');
const statements = [...update.body.statements];
const stop = statements.findIndex(node => node.getText(tree) === 'if (!this.loaded) return;');
assert.ok(stop > 0);
const source = ts.transpileModule(`return function(time, cinematic) { ${statements.slice(0, stop).map(node => node.getText(tree)).join('\n')} return { dt, motionTime }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = new Function('musicLibrary', 'getMusicMotionSpeed', source)(true, getMusicMotionSpeed);
for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const state = { clock: 100, last: 100, reduced: false };
  for (let frame = 1; frame <= 120 / speed; frame++) tick.call(state, 100 + frame / 120);
  close(state.clock, 101, 'Idle-wave phase and ripple age advance by equal scaled time');
  const before = state.clock;
  tick.call(state, state.last);
  close(state.clock, before, 'Duplicate frame timestamps cannot advance motion');
  tick.call(state, state.last + 300);
  close(state.clock - before, .05 * speed, 'A hidden-tab gap does not advance a wave by minutes');
}
setMusicMotionSpeed(3);
const intro = { clock: 10, last: 10, reduced: false };
tick.call(intro, 10.01, { time: 25 });
close(intro.clock, 10.01, 'The cinematic field remains unscaled');
tick.call(intro, 10.02);
close(intro.clock, 10.04, 'The first browsing frame continues the exact intro phase at the selected speed');
const retiming = { clock: 100, last: 100, reduced: false };
for (const speed of [3, .25, 1]) {
  setMusicMotionSpeed(speed);
  const before = retiming.clock;
  tick.call(retiming, retiming.last);
  close(retiming.clock, before, 'Live retiming does not jump a field phase');
  tick.call(retiming, retiming.last + .01);
  close(retiming.clock - before, .01 * speed, 'Only future field time uses the new speed');
}
setMusicMotionSpeed(1);
console.log('Music animation audit passed: live CSS transition retiming, infinite CSS phase continuity, 0.25/1/3× scene field timing, intro handoff, duplicate frames, suspended-tab gaps and rapid speed changes.');

// Shared scene changes must keep ?original=1 on its pre-existing real clock.
// Exercise the actual production dispatch with musicLibrary=false, including
// its intentional legacy 16 ms fallback on duplicate timestamp samples.
const legacyTick = new Function('musicLibrary', 'getMusicMotionSpeed', source)(false, getMusicMotionSpeed);
for (const speed of [.25, 1, 3]) for (const reduced of [false, true]) for (const cinematic of [undefined, { time: 25 }]) {
  setMusicMotionSpeed(speed);
  const state = { clock: 100, last: 100, reduced };
  for (const [now, expectedDt] of [[100, .016], [100.01, .01], [100.04, .03], [400, .05], [400, .016]]) {
    const result = legacyTick.call(state, now, cinematic);
    close(result.dt, expectedDt, 'Original archive retains its unscaled physical timestep and fallback');
    assert.equal(result.motionTime, now, 'Original wave sampling and ripple ages retain exact wall time');
    assert.equal(state.clock, now, 'Original interaction timestamps retain wall time');
  }
}
const snapTracks = statements.find(node => ts.isIfStatement(node) &&
  node.thenStatement.getText(tree).includes('this.shoulder =') && node.thenStatement.getText(tree).includes('this.rail ='));
const snapCondition = new Function('musicLibrary', 'cinematic', `return ${snapTracks.expression.getText(tree)};`);
assert.equal(snapCondition.call({ reduced: true }, false, undefined), false,
  'The new direct reduced-motion browsing-track snap does not run in the original archive');
const outgoing = statements.find(node => ts.isForStatement(node) && node.getText(tree).includes('this.outgoing.length - 1'));
const snapCopy = outgoing.statement.statements.find(node => ts.isIfStatement(node) && node.thenStatement.getText(tree).includes('o.lift ='));
const copyCondition = new Function('musicLibrary', `return ${snapCopy.expression.getText(tree)};`);
assert.equal(copyCondition.call({ reduced: true }, false), false,
  'The new direct returning-copy snap does not run in the original archive');
setMusicMotionSpeed(1);
console.log('Original archive compatibility passed: unchanged real clock, physics delta/fallback, cinematic/reduced branches and no music-only direct track/copy snaps.');
