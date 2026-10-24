import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function sourceModule(path) {
  const url = new URL(path, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  // Node has no stylesheet loader. All production JavaScript remains intact.
  const code = outputText.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, '')
    .replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
      `from ${JSON.stringify(specifier.startsWith('.') ? sourceModule(new URL(/\.\w+$/.test(specifier) ? specifier : `${specifier}.ts`, url)) : import.meta.resolve(specifier))}`);
  const compiled = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(url.href, compiled);
  return compiled;
}

const timingModule = sourceModule('../src/music-boot-timing.ts');
const { MusicBootFrameClock, MUSIC_BOOT_START_TIME: START, MUSIC_BOOT_END_TIME: END, MUSIC_BOOT_SCENE_REVEAL_TIME, MUSIC_BOOT_SCENE_START, musicBootSceneTime } = await import(timingModule);
const { MusicBoot } = await import(sourceModule('../src/music-boot.ts'));
const { setMusicMotionSpeed } = await import(sourceModule('../src/music-motion-settings.ts'));
const { musicOpeningFrame, MUSIC_OPENING_CAPTION } = await import(sourceModule('../src/music-opening.ts'));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${message}: expected ${expected}, received ${actual}`);

for (const fps of [30, 60, 120]) {
  const clock = new MusicBootFrameClock();
  clock.reset(100);
  close(clock.update(100), START, 'First frame starts at the authored opening');
  const frames = Math.round((END - START) * fps);
  for (let frame = 1; frame <= frames; frame++) {
    close(clock.update(100 + frame / fps), Math.min(END, START + frame / fps),
      `Normal ${fps} fps playback retains the 7 second duration`);
  }
  assert.equal(clock.update(100 + frames / fps), END, 'Final frame is exact, without an extra rounding frame');
  assert.equal(clock.update(200), END, 'A completed clock stays at the endpoint');
  clock.reset(500, MUSIC_BOOT_SCENE_START);
  close(clock.update(500), MUSIC_BOOT_SCENE_START, 'A scene-only clock starts exactly after the slogan fade');
  const sceneFrames = Math.round((END - MUSIC_BOOT_SCENE_START) * fps);
  for (let frame = 1; frame <= sceneFrames; frame++)
    close(clock.update(500 + frame / fps), Math.min(END, MUSIC_BOOT_SCENE_START + frame / fps),
      `Scene-only ${fps} fps playback retains the complete 5.2 second choreography`);
  assert.equal(clock.update(600), END);
  clock.reset(700);
  assert.equal(clock.update(700), START, 'A later full replay still restores the original prologue start');
}

const cold = new MusicBootFrameClock();
cold.reset(10);
close(cold.update(10), START, 'Cold start begins with its first frame');
close(cold.update(13.5), START + 0.05, 'A 3.5 second first-render shader compile consumes only one bounded frame');
close(cold.update(13.5 + 1 / 60), START + 0.05 + 1 / 60, 'The next frame has no catch-up backlog');
const beforeHidden = cold.update(13.6);
close(cold.update(313.6), beforeHidden + 0.05, 'A hidden tab does not skip the remaining opening');
const beforeInvalid = cold.update(313.7);
for (const invalid of [NaN, Infinity, -Infinity, 200, 313.7]) {
  assert.equal(cold.update(invalid), beforeInvalid, 'Invalid or backward timestamps cannot rewind or advance the film');
}
close(cold.update(313.7 + 1 / 60), beforeInvalid + 1 / 60, 'Backward timestamps do not alter the previous valid clock sample');
cold.reset(500);
assert.equal(cold.update(500), START, 'A restarted opening discards all prior progress');
close(cold.update(550), START + 0.05, 'A stall before the first animation callback is bounded too');
cold.reset(600, MUSIC_BOOT_SCENE_START);
close(cold.update(700), MUSIC_BOOT_SCENE_START + 0.05, 'Scene-only playback also bounds cold-render or suspended-tab gaps');
const sceneBeforeInvalid = cold.update(700 + 1 / 60);
for (const invalid of [NaN, Infinity, -Infinity, 600, 700 + 1 / 60])
  assert.equal(cold.update(invalid), sceneBeforeInvalid, 'Invalid scene-only timestamps never rewind to the slogan prologue');

// Minimal DOM doubles exercise the real MusicBoot state machine, including its
// one-frame endpoint handoff, skip callback and reduced-motion branch.
const controlAnimations = [];
class FakeAnimation {
  constructor(target, frames, options) {
    Object.assign(this, { target, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {});
    controlAnimations.push(this);
  }
  updatePlaybackRate(rate) { this.playbackRate = rate; }
  finish() { this.resolve(); }
  cancel() { this.reject(new Error('cancelled')); }
}
class FakeElement {
  children = [];
  dataset = {};
  hidden = false;
  inert = false;
  isConnected = true;
  className = '';
  attributes = new Map();
  properties = new Map();
  classList = { contains: (value) => this.className.split(' ').includes(value) };
  style = {
    getPropertyValue: (name) => this.properties.get(name)?.value ?? '',
    getPropertyPriority: (name) => this.properties.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => this.properties.set(name, { value, priority }),
    removeProperty: (name) => this.properties.delete(name),
  };
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, fields = {}) {
    const event = { ...fields, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; } };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  queries = new Map();
  querySelector(selector) {
    if (selector.startsWith('.')) {
      for (const child of this.children) {
        if (child.classList.contains(selector.slice(1))) return child;
        const descendant = child.querySelector(selector);
        if (descendant) return descendant;
      }
      return null;
    }
    if (!selector.startsWith('[data-opening=')) return null;
    if (!this.queries.has(selector)) this.queries.set(selector, new FakeElement());
    return this.queries.get(selector);
  }
  contains(child) { return this === child || this.children.some((entry) => entry.contains(child)); }
  closest() { return this.hidden || this.inert ? this : this.parent?.closest() ?? null; }
  focus() { document.activeElement = this; }
  animate(frames, options) { return new FakeAnimation(this, frames, options); }
  remove() { this.isConnected = false; this.parent.children = this.parent.children.filter((entry) => entry !== this); }
}
globalThis.HTMLElement = FakeElement;
globalThis.document = {
  createElement: () => new FakeElement(),
  body: new FakeElement(),
  activeElement: null,
};
document.activeElement = document.body;
globalThis.getComputedStyle = () => ({ opacity: '1', translate: 'none' });

function bootFixture(reduced = false, withHeader = false) {
  const stage = new FakeElement();
  const scene = new FakeElement(); scene.className = 'three-scene';
  const controls = new FakeElement(); controls.style.setProperty('visibility', 'collapse', 'important');
  stage.appendChild(scene); stage.appendChild(controls);
  const header = new FakeElement(); header.className = 'music-header';
  const identity = new FakeElement(); identity.className = 'music-identity';
  const brand = new FakeElement(); brand.className = 'music-brand';
  const navigation = new FakeElement(); navigation.className = 'music-topnav';
  const button = new FakeElement(); button.className = 'custom-control';
  identity.appendChild(brand); navigation.appendChild(button);
  header.appendChild(identity); header.appendChild(navigation);
  if (withHeader) stage.appendChild(header);
  const completed = [];
  let started = 0;
  const boot = new MusicBoot(stage, {
    reduced,
    onStart: () => { started++; },
    onComplete: (reason) => completed.push(reason),
  });
  return { boot, stage, scene, controls, header, identity, brand, navigation, button,
    completed, get started() { return started; } };
}

const actual = bootFixture();
actual.boot.start(100);
assert.equal(actual.boot.root.attributes.get('aria-label'), '音乐开场：ONE ALBUM AT A TIME');
assert.equal(actual.boot.update(100).appTime, START);
assert.equal(actual.scene.inert, true);
assert.equal(actual.controls.style.getPropertyValue('visibility'), 'hidden');
close(actual.boot.update(103.5).appTime, START + 0.05, 'Actual MusicBoot uses the bounded clock after shader compilation');
assert.equal(actual.boot.update(203.5).phase, 'slogan', 'A long pause cannot jump actual MusicBoot to its final selection');
assert.deepEqual(actual.completed, [], 'A pause cannot complete the intro');
actual.boot.replay(500);
assert.equal(actual.boot.update(500).appTime, START, 'Actual replay resets the displayed film time');
const totalFrames = Math.round((END - START) * 60);
for (let frame = 1; frame <= totalFrames; frame++) {
  const rendered = actual.boot.update(500 + frame / 60);
  assert.ok(rendered, 'The opening emits a frame throughout the prologue and live shelf');
  assert.equal(rendered.renderScene, rendered.appTime >= MUSIC_BOOT_SCENE_REVEAL_TIME,
    'The live scene runs only once the opaque paper starts its dissolve');
  if (!rendered.renderScene) assert.equal(musicOpeningFrame(rendered.appTime).background, 1,
    'Every skipped scene frame is fully covered by the opening art');
  assert.equal(rendered.cinema.time, musicBootSceneTime(rendered.appTime), 'Camera, geometry and lighting share one bounded clock');
}
assert.equal(actual.stage.children.at(-1).dataset.appTime, String(END));
assert.deepEqual(actual.completed, [], 'The endpoint is rendered before completion is announced');
assert.equal(actual.boot.update(500 + (totalFrames + 1) / 60), undefined);
assert.deepEqual(actual.completed, ['complete'], 'Completion fires once on the frame after the endpoint');
await Promise.resolve();
assert.equal(actual.boot.active, false, 'The existing control reveal completes normally');
assert.equal(actual.controls.inert, false);
assert.equal(actual.controls.style.getPropertyValue('visibility'), 'collapse');
assert.equal(actual.controls.style.getPropertyPriority('visibility'), 'important');

const skipped = bootFixture();
skipped.boot.start(0); skipped.boot.update(0); skipped.boot.update(3.5);
skipped.boot.skip();
assert.deepEqual(skipped.completed, ['skip'], 'Skip still bypasses the opening immediately');
await Promise.resolve();
assert.equal(skipped.boot.active, false);
assert.equal(skipped.boot.update(100), undefined, 'Skipped frames cannot resume the timeline');

const reduced = bootFixture(true);
reduced.boot.start(0);
assert.equal(reduced.started, 1);
assert.deepEqual(reduced.completed, ['skip'], 'Reduced motion retains its immediate skip');
assert.equal(reduced.boot.active, false);
reduced.boot.replay(20);
assert.equal(reduced.boot.active, false, 'Replay also honours reduced motion');
assert.deepEqual(reduced.completed, ['skip', 'skip']);
reduced.boot.dispose();
assert.equal(reduced.boot.active, false);

let reduceNow = false;
const changed = bootFixture(() => reduceNow);
changed.boot.start(0);
changed.boot.update(0);
reduceNow = true;
assert.equal(changed.boot.update(1 / 60), undefined);
assert.equal(changed.boot.active, false, 'A reduced-motion preference change skips an in-flight opening');
assert.deepEqual(changed.completed, ['skip']);

const openingMarkup = actual.boot.root.children[0].innerHTML;
assert.equal(MUSIC_OPENING_CAPTION, 'ONE ALBUM AT A TIME', 'The prologue restores the previous English slogan');
assert.equal(openingMarkup.replace(/<[^>]*>/g, '').trim(), MUSIC_OPENING_CAPTION,
  'The centered English caption is the only visible text in the opening');
assert.equal((openingMarkup.match(/<div\b/g) ?? []).length, 2,
  'Only the paper and single caption elements remain in the opening');
assert.ok(openingMarkup.includes('class="music-opening-caption" data-opening="caption"'),
  'The slogan uses its centered caption element');
assert.ok(!/<svg\b|Rhine|[\u3400-\u9fff]/i.test(openingMarkup),
  'The prologue contains no logo, brand name or Chinese subtitle');
for (const removed of ['music-opening-mark', 'data-opening="mark"', 'music-opening-brand', 'music-opening-rule', 'music-opening-symbols',
  'music-opening-orbit', 'music-opening-title', 'music-opening-subtitle', '一张一张，慢慢听'])
  assert.ok(!openingMarkup.includes(removed), `The new opening excludes ${removed}`);
assert.equal(MUSIC_BOOT_SCENE_REVEAL_TIME, 1.72);
assert.equal(MUSIC_BOOT_SCENE_START, 1.8);
assert.equal(END, 7, 'The slogan prologue and unchanged live shelf total seven seconds');
assert.equal(musicBootSceneTime(0), 21.92);
assert.equal(musicBootSceneTime(MUSIC_BOOT_SCENE_START), 21.92, 'Prewarming the scene does not consume its authored sweep');
close(musicBootSceneTime(END), 27.12, 'The original live-scene endpoint is unchanged');
assert.deepEqual(musicOpeningFrame(0), { phase: 'slogan', background: 1, caption: 0 });
for (const invalid of [NaN, Infinity, -Infinity, -1])
  assert.deepEqual(musicOpeningFrame(invalid), musicOpeningFrame(0), 'Invalid or negative samples return the first slogan frame');
close(musicOpeningFrame(.3).caption, .5, 'The slogan fades in around a fixed center');
for (const time of [.6, .8, 1, 1.1])
  assert.equal(musicOpeningFrame(time).caption, 1, 'The complete slogan holds at full opacity');
close(musicOpeningFrame((1.1 + MUSIC_BOOT_SCENE_REVEAL_TIME) / 2).caption, .5,
  'The slogan fades out on the same smooth opacity curve');
assert.equal(musicOpeningFrame(MUSIC_BOOT_SCENE_REVEAL_TIME).caption, 0,
  'The slogan is completely gone before the live shelf is uncovered');
assert.equal(musicOpeningFrame(MUSIC_BOOT_SCENE_START - .001).phase, 'slogan');
assert.equal(musicOpeningFrame(MUSIC_BOOT_SCENE_START).phase, 'array');
const opacityTracks = ['background', 'caption'];
let previous = musicOpeningFrame(0);
for (let time = 1 / 120; time <= END; time += 1 / 120) {
  const frame = musicOpeningFrame(time);
  assert.deepEqual(Object.keys(frame).sort(), ['background', 'caption', 'phase'],
    'Only the slogan and its background remain in the two-dimensional edit');
  for (const track of opacityTracks) {
    assert.ok(frame[track] >= 0 && frame[track] <= 1);
    assert.ok(Math.abs(frame[track] - previous[track]) < 0.075, `${track} has no editorial opacity jump`);
  }
  if (time <= MUSIC_BOOT_SCENE_REVEAL_TIME) assert.equal(frame.background, 1);
  if (time >= MUSIC_BOOT_SCENE_REVEAL_TIME) assert.equal(frame.caption, 0);
  previous = frame;
}
assert.equal(musicOpeningFrame(2.16).background, 0, 'The backdrop releases the live scene completely');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// The initial focus belongs to the overlay, so the small skip text has no
// automatic focus border. Keyboard users can still reach it, and either skip
// gesture must complete once without leaking input through the control reveal.
for (const mode of ['start', 'replay']) {
  for (const trigger of ['click', 'Escape', 'Enter']) {
    const opener = new FakeElement(); document.activeElement = opener;
    const f = bootFixture(false, true);
    f.boot[mode](0);
    const skip = f.boot.root.children[1];
    assert.equal(document.activeElement, f.boot.root, 'Starting either mode focuses the overlay without highlighting skip');
    assert.equal(skip.textContent, '跳过进场', 'Both replay modes use the same unobtrusive skip text');
    assert.equal(f.header.style.getPropertyValue('visibility'), 'hidden');
    const tab = f.boot.root.dispatch('keydown', { key: 'Tab' });
    assert.ok(tab.defaultPrevented && tab.propagationStopped);
    assert.equal(document.activeElement, skip, 'Tab reaches the only available skip control');
    const reverseTab = f.boot.root.dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.ok(reverseTab.defaultPrevented && reverseTab.propagationStopped);
    assert.equal(document.activeElement, skip, 'Reverse Tab also remains inside the opening');
    const revealStart = controlAnimations.length;
    if (trigger === 'click') skip.dispatch('click');
    else {
      const key = f.boot.root.dispatch('keydown', { key: trigger });
      assert.ok(key.defaultPrevented && key.propagationStopped);
    }
    assert.deepEqual(f.completed, ['skip'], `${trigger} skips the ${mode} film once`);
    assert.equal(f.stage.dataset.musicBoot, 'revealing');
    assert.equal(document.activeElement, f.boot.root, 'Focus stays on the overlay while fixed controls fade in');
    assert.ok(skip.hidden, 'Skip disappears during the final control reveal');
    for (const key of ['Tab', 'Escape', 'Enter', 'ArrowRight']) {
      const event = f.boot.root.dispatch('keydown', { key });
      assert.ok(event.defaultPrevented && event.propagationStopped, 'Control-reveal input cannot navigate the library underneath');
    }
    skip.dispatch('click');
    assert.deepEqual(f.completed, ['skip'], 'Repeated input does not duplicate the completion hook');
    assert.equal(document.activeElement, f.boot.root);
    controlAnimations.slice(revealStart).forEach(animation => animation.finish());
    await flush();
    assert.equal(f.boot.active, false);
    assert.equal(document.activeElement, opener, 'The completed reveal restores the original focus');
    assert.equal(f.header.style.getPropertyValue('visibility'), '');
    assert.equal(f.header.inert, false);
    f.boot.dispose();
  }
}

// Reusing the real DOM also reuses all responsive geometry. Exercise its actual
// visibility/inert lifecycle, including prior child state and interrupted replay.
const shared = bootFixture(false, true);
shared.navigation.style.setProperty('visibility', 'collapse', 'important');
shared.navigation.inert = true;
shared.button.style.setProperty('visibility', 'hidden', 'important');
shared.button.inert = true;
shared.boot.start(0);
assert.equal(shared.stage.querySelector('.music-brand'), shared.brand);
assert.equal(shared.brand.parent, shared.identity);
assert.equal(shared.identity.parent, shared.header);
assert.equal(shared.header.style.getPropertyValue('visibility'), 'hidden', 'The entire fixed header stays hidden throughout the film');
assert.equal(shared.identity.style.getPropertyValue('visibility'), '');
assert.equal(shared.brand.style.getPropertyValue('visibility'), '');
assert.equal(shared.header.inert, true, 'The hidden brand and navigation stay outside the intro focus order');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse', 'Hiding the header preserves its nested navigation state');
assert.equal(shared.button.style.getPropertyValue('visibility'), 'hidden', 'Nested control overrides are untouched');
const revealStart = controlAnimations.length;
shared.boot.skip();
assert.equal(shared.boot.active, true, 'Controls still own their reveal lifecycle after skip');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse');
assert.equal(shared.navigation.style.getPropertyPriority('visibility'), 'important');
const oldReveal = controlAnimations.slice(revealStart);
assert.equal(oldReveal.length, 1);
assert.equal(oldReveal[0].target, shared.header, 'The full header fades in once after the 3D animation');
shared.boot.replay(10);
oldReveal.forEach(animation => animation.finish());
await flush();
assert.equal(shared.stage.dataset.musicBoot, 'running', 'An obsolete reveal cannot finish a replay');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse', 'Hiding the header preserves its nested navigation state');
assert.equal(shared.header.style.getPropertyValue('visibility'), 'hidden');
shared.boot.skip();
controlAnimations.slice(revealStart).forEach(animation => animation.finish());
await flush();
assert.equal(shared.boot.active, false);
assert.equal(shared.header.inert, false);
assert.equal(shared.navigation.inert, true, 'Original nested inert state is restored after revealing');
assert.equal(shared.button.inert, true);
assert.equal(shared.button.style.getPropertyPriority('visibility'), 'important');
assert.equal(shared.stage.querySelector('.music-brand'), shared.brand, 'The same brand survives the handoff');
shared.boot.replay(20); shared.boot.dispose();
assert.equal(shared.header.inert, false, 'Disposal also releases the persistent header');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse');
assert.equal(shared.navigation.style.getPropertyPriority('visibility'), 'important');
assert.equal(shared.navigation.inert, true);

let sharedReduced = false;
const reducedHeader = bootFixture(() => sharedReduced, true);
reducedHeader.boot.start(0); reducedHeader.boot.skip();
assert.equal(reducedHeader.boot.active, true);
sharedReduced = true; reducedHeader.boot.update(.02);
assert.equal(reducedHeader.boot.active, false, 'Live reduced motion finishes the full-header reveal');
assert.equal(reducedHeader.header.inert, false);
assert.equal(reducedHeader.navigation.inert, false);
assert.equal(reducedHeader.header.style.getPropertyValue('visibility'), '');
assert.equal(reducedHeader.navigation.style.getPropertyValue('visibility'), '');
reducedHeader.boot.replay(30);
assert.equal(reducedHeader.boot.active, false);
assert.equal(reducedHeader.stage.querySelector('.music-brand'), reducedHeader.brand);
reducedHeader.boot.dispose();

for (const fps of [20,30,60,120]) {
  const gate = bootFixture();
  gate.boot.start(0);
  let skipped = 0, rendered = 0, firstSceneFrame;
  for (let step=0;step<=Math.round(END*fps);step++) {
    const frame = gate.boot.update(step/fps);
    if (!frame) continue;
    if (frame.renderScene) { rendered++; firstSceneFrame ??= frame; }
    else skipped++;
  }
  assert.ok(skipped >= Math.floor(MUSIC_BOOT_SCENE_REVEAL_TIME*fps),
    `At ${fps} fps the fully opaque intro avoids repeated WebGL rendering`);
  assert.ok(rendered > 0 && firstSceneFrame.appTime <= MUSIC_BOOT_SCENE_REVEAL_TIME + 1/fps + 1e-9,
    'The first partially transparent frame has a live scene behind it');
  close(firstSceneFrame.cinema.time, 21.92,
    'Dissolve pre-roll starts at the original scene frame, before shelf motion advances');
  gate.boot.dispose();
}

// Replay the complete released opening while interrupting the film and its
// control handoff. A retired scene-only study path is never exposed.
assert.equal(typeof MusicBoot.prototype.replayScene, 'undefined');
{
  const f = bootFixture(false, true), opening = f.boot.root.children[0];
  f.navigation.style.setProperty('visibility', 'collapse', 'important');
  f.navigation.inert = true;
  f.boot.start(0); f.boot.update(0);
  const oldRevealStart = controlAnimations.length;
  f.boot.skip();
  const oldReveal = controlAnimations.slice(oldRevealStart);
  f.boot.replay(20);
  oldReveal.forEach(animation => animation.finish()); await flush();
  assert.equal(f.stage.dataset.musicBoot, 'running', 'An obsolete reveal cannot complete a newer replay');
  assert.ok(f.boot.active && !opening.hidden && f.header.inert);
  assert.equal(f.boot.update(20).appTime, START, 'Every replay includes the slogan');
  f.boot.replay(30);
  assert.equal(f.boot.update(30).appTime, START, 'Restarting a running opening resets its clock');
  assert.deepEqual(f.completed, ['skip'], 'Replacing a running film does not issue a stale completion');
  f.boot.dispose();
  assert.ok(!f.boot.active && !f.boot.root.isConnected);
  assert.equal(f.scene.inert, false);
  assert.equal(f.header.inert, false);
  assert.equal(f.navigation.inert, true);
  assert.equal(f.navigation.style.getPropertyValue('visibility'), 'collapse');
  assert.equal(f.navigation.style.getPropertyPriority('visibility'), 'important');
  const started = f.started;
  f.boot.start(40); f.boot.replay(50);
  assert.equal(f.started, started, 'A disposed controller cannot restart');
}
for (const duringReveal of [false, true]) {
  let reduce = false;
  const f = bootFixture(() => reduce, true);
  f.boot.replay(0); f.boot.update(0);
  if (duringReveal) f.boot.skip();
  reduce = true;
  assert.equal(f.boot.update(1 / 60), undefined);
  assert.ok(!f.boot.active && f.boot.root.hidden && f.boot.root.children[0].hidden);
  assert.deepEqual(f.completed, ['skip']);
  assert.equal(f.header.inert, false);
  assert.equal(f.navigation.inert, false);
  assert.equal(f.scene.inert, false);
  f.boot.dispose();
}
console.log('Music boot passed: centered English slogan, unchanged 7s full film and 1.72s WebGL gate; original shelf/camera/light timeline; full replay and handoff interruption, nested control restoration, cold/suspended clock, exact endpoint, keyboard/click skip, disposal and live reduced motion.');


for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const f = bootFixture(false, true);
  f.boot.start(0);
  for (let frame = 0; frame <= 420; frame++) f.boot.update(frame / 60);
  assert.equal(f.boot.root.dataset.appTime, String(END), 'The authored film is still exactly 7 seconds at every UI speed');
  const revealStart = controlAnimations.length;
  f.boot.update(421 / 60);
  const reveals = controlAnimations.slice(revealStart);
  assert.ok(reveals.length > 0);
  assert.ok(reveals.every(animation => animation.playbackRate === speed));
  assert.ok(reveals.every(animation => animation.options.duration + animation.options.delay === 720));
  const nextSpeed = speed === 3 ? .25 : 3;
  setMusicMotionSpeed(nextSpeed);
  assert.ok(reveals.every(animation => animation.playbackRate === nextSpeed), 'Controls retime without restarting their reveal');
  f.boot.dispose();
  await flush();
}
setMusicMotionSpeed(1);
console.log('Boot handoff passed: independent 7s film, globally scaled 720ms controls at 0.25/1/3×, live retiming, cleanup.');
