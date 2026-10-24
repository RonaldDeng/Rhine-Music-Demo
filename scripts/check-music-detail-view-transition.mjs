import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Load the real controller and its shared motion clock, not a rewritten model.
const modules = new Map();
async function compiled(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const source = await readFile(url, 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [, name] of [...outputText.matchAll(/from\s+["'](\.[^"']+)["']/g)]) {
    const dependency = await compiled(new URL(name.endsWith('.ts') ? name : `${name}.ts`, url));
    outputText = outputText.replaceAll(`"${name}"`, JSON.stringify(dependency)).replaceAll(`'${name}'`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  modules.set(url.href, result);
  return result;
}
const { setMusicMotionSpeed } = await import(await compiled(new URL('../src/music-motion-settings.ts', import.meta.url)));
const { MusicDetailViewTransition } = await import(await compiled(new URL('../src/music-detail-view-transition.ts', import.meta.url)));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, { veilOpacity = 1, hiddenTargets = false } = {}) {
  const animations = [], events = [], commits = [];
  let current = 'info', settled = 0;
  class FakeAnimation {
    playbackRate = 1;
    currentTime = 0;
    playState = 'running';
    constructor(element, frames, options) {
      Object.assign(this, { element, frames, options });
      this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
      this.finished.catch(() => {});
      animations.push(this);
    }
    updatePlaybackRate(rate) { this.playbackRate = rate; }
    finish() {
      this.currentTime = this.options.duration;
      this.playState = 'finished';
      this.resolve();
    }
    cancel() {
      if (this.playState !== 'finished') this.reject(new Error('cancelled'));
      this.playState = 'idle';
    }
    opacity() {
      const progress = Math.min(1, this.currentTime / this.options.duration);
      return this.frames[0].opacity + (this.frames[1].opacity - this.frames[0].opacity) * progress;
    }
  }
  class Element {
    isConnected = true;
    visible = !hiddenTargets;
    constructor(name, opacity = 1, inert = false) { Object.assign(this, { name, baseOpacity: opacity, inert }); }
    getClientRects() { return this.visible ? [{}] : []; }
    animate(frames, options) { return new FakeAnimation(this, frames, options); }
  }
  const info = new Element('info'), lyrics = new Element('lyrics', 1, true), veil = new Element('veil', veilOpacity);
  const opacity = (element) => {
    const animation = animations.findLast((entry) => entry.element === element && entry.playState !== 'idle');
    return animation ? animation.opacity() : element.baseOpacity;
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: element => ({ opacity: String(opacity(element)) }) });
  const transition = new MusicDetailViewTransition({
    current: () => current,
    targets: () => [current === 'info' ? info : lyrics, veil],
    commit: (view) => { commits.push(view); events.push(`commit:${view}`); current = view; },
    state: (phase) => events.push(phase),
    settled: () => { settled++; events.push('settled'); },
  });
  setMusicMotionSpeed(1);
  t.after(async () => {
    transition.cancel();
    await flush();
    setMusicMotionSpeed(1);
    if (descriptor) Object.defineProperty(globalThis, 'getComputedStyle', descriptor);
    else delete globalThis.getComputedStyle;
  });
  const advance = (milliseconds) => {
    for (const animation of [...animations]) {
      if (animation.playState !== 'running') continue;
      animation.currentTime += milliseconds * animation.playbackRate;
      if (animation.currentTime >= animation.options.duration) animation.finish();
    }
  };
  const finishActive = async () => {
    for (const animation of animations.filter((entry) => entry.playState === 'running')) animation.finish();
    await flush();
  };
  return { transition, animations, events, commits, info, lyrics, veil, opacity, advance, finishActive,
    get current() { return current; }, get settled() { return settled; } };
}

test('normal switch closes fully before committing geometry, then opens and restores original inert flags', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', false);
  assert.equal(f.transition.target, 'lyrics');
  assert.equal(f.current, 'info');
  assert.deepEqual(f.events, ['closing']);
  assert.equal(f.info.inert, true); assert.equal(f.veil.inert, true);
  assert.ok(f.animations.every(animation => animation.options.duration === 240));
  f.advance(239); await flush();
  assert.equal(f.commits.length, 0);
  f.advance(1); await flush();
  assert.deepEqual(f.events, ['closing', 'commit:lyrics', 'opening']);
  const entering = f.animations.filter(animation => animation.playState === 'running');
  assert.ok(entering.every(animation => animation.frames[0].opacity === 0 && animation.options.duration === 360));
  assert.equal(f.settled, 0);
  f.advance(359); await flush(); assert.equal(f.settled, 0);
  f.advance(1); await flush();
  assert.equal(f.settled, 1); assert.equal(f.transition.target, 'lyrics');
  assert.deepEqual(f.events.slice(-2), ['idle', 'settled']);
  assert.equal(f.info.inert, false, 'old target lock is restored too');
  assert.equal(f.lyrics.inert, true, 'a pre-existing inert target stays inert');
  assert.equal(f.veil.inert, false);
  assert.ok(f.animations.every(animation => animation.playState === 'idle'));
});

test('reversing during close resumes from displayed opacity without committing the abandoned view', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', false);
  f.advance(96);
  const displayed = f.opacity(f.info);
  assert.ok(displayed > 0 && displayed < 1);
  f.transition.change('info', false);
  const active = f.animations.filter(animation => animation.playState === 'running');
  assert.equal(active.find(animation => animation.element === f.info).frames[0].opacity, displayed);
  assert.equal(active.find(animation => animation.element === f.info).frames[1].opacity, 1);
  await f.finishActive();
  assert.deepEqual(f.commits, []);
  assert.equal(f.current, 'info'); assert.equal(f.transition.target, 'info');
  assert.equal(f.settled, 1); assert.equal(f.info.inert, false);
});

test('reversing after close has resolved but before its promise callback cannot commit stale geometry', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', false);
  f.animations.forEach(animation => animation.finish());
  // Native animation completion queues microtasks; input may supersede it first.
  f.transition.change('info', false);
  await flush();
  assert.deepEqual(f.commits, []);
  assert.equal(f.transition.target, 'info');
  await f.finishActive();
  assert.equal(f.settled, 1); assert.equal(f.current, 'info');
});

test('reversing while opening closes the visible new view before returning and settles only the newest request', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', false);
  await f.finishActive();
  f.advance(120);
  const displayed = f.opacity(f.lyrics);
  f.transition.change('info', false);
  assert.deepEqual(f.commits, ['lyrics']);
  const leaving = f.animations.findLast(animation => animation.element === f.lyrics && animation.playState === 'running');
  assert.equal(leaving.frames[0].opacity, displayed); assert.equal(leaving.frames[1].opacity, 0);
  await f.finishActive();
  assert.deepEqual(f.commits, ['lyrics', 'info']); assert.equal(f.settled, 0);
  await f.finishActive();
  assert.equal(f.settled, 1); assert.equal(f.transition.target, 'info');
  assert.equal(f.info.inert, false); assert.equal(f.veil.inert, false); assert.equal(f.lyrics.inert, true);
});

test('cancel suppresses queued commit and settlement callbacks and unlocks every touched target', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', false);
  f.animations.forEach(animation => animation.finish());
  f.transition.cancel();
  await flush();
  assert.deepEqual(f.commits, []); assert.equal(f.settled, 0); assert.equal(f.transition.target, 'info');
  assert.equal(f.info.inert, false); assert.equal(f.veil.inert, false);
  f.transition.change('lyrics', false);
  await f.finishActive();
  f.animations.filter(animation => animation.playState === 'running').forEach(animation => animation.finish());
  f.transition.cancel();
  await flush();
  assert.deepEqual(f.commits, ['lyrics']); assert.equal(f.settled, 0);
  assert.equal(f.transition.target, 'lyrics');
  assert.equal(f.info.inert, false); assert.equal(f.lyrics.inert, true); assert.equal(f.veil.inert, false);
});

test('reduced motion and finish commit exactly once and never leave pending animation or inert state', async (t) => {
  const f = fixture(t);
  f.transition.change('lyrics', true);
  assert.deepEqual(f.commits, ['lyrics']); assert.equal(f.settled, 1);
  assert.equal(f.animations.length, 0); assert.equal(f.veil.inert, false);
  f.transition.change('info', false);
  f.advance(75);
  f.transition.change('info', true); // same pending destination, reduced motion changed mid-flight
  assert.deepEqual(f.commits, ['lyrics', 'info']); assert.equal(f.settled, 2);
  assert.equal(f.info.inert, false); assert.equal(f.lyrics.inert, true);
  await flush(); assert.equal(f.settled, 2);
  f.transition.change('lyrics', false);
  await f.finishActive();
  f.transition.finish();
  assert.deepEqual(f.commits, ['lyrics', 'info', 'lyrics']); assert.equal(f.settled, 3);
  await flush(); assert.equal(f.settled, 3);
  f.transition.finish();
  assert.equal(f.settled, 3, 'finishing an already idle controller is not a second settlement');
  assert.ok(f.animations.every(animation => animation.playState === 'idle'));
});

test('an underlying zero-opacity veil stays transparent during entry and completion', async (t) => {
  const f = fixture(t, { veilOpacity: 0 });
  f.transition.change('lyrics', false);
  await f.finishActive();
  const veilEntry = f.animations.findLast(animation => animation.element === f.veil);
  assert.deepEqual(veilEntry.frames, [{ opacity: 0 }, { opacity: 0 }]);
  f.advance(180); assert.equal(f.opacity(f.veil), 0);
  await f.finishActive();
  assert.equal(f.opacity(f.veil), 0); assert.equal(f.settled, 1);
});

test('a global speed change preserves progress and retimes both closing and opening', async (t) => {
  const f = fixture(t);
  setMusicMotionSpeed(0.25);
  f.transition.change('lyrics', false);
  assert.ok(f.animations.every(animation => animation.playbackRate === 0.25));
  f.advance(400);
  const time = f.animations[0].currentTime, before = f.opacity(f.info);
  setMusicMotionSpeed(2);
  assert.equal(f.animations[0].currentTime, time); assert.equal(f.opacity(f.info), before);
  f.advance(70); await flush();
  assert.equal(f.current, 'lyrics'); assert.equal(f.settled, 0);
  assert.ok(f.animations.filter(animation => animation.playState === 'running').every(animation => animation.playbackRate === 2));
  f.advance(180); await flush();
  assert.equal(f.settled, 1);
});

test('hidden surfaces with no animation targets still complete and restore interaction', async (t) => {
  const f = fixture(t, { hiddenTargets: true });
  f.transition.change('lyrics', false);
  await flush();
  assert.equal(f.animations.length, 0);
  assert.deepEqual(f.commits, ['lyrics']); assert.equal(f.settled, 1);
  assert.equal(f.info.inert, false); assert.equal(f.lyrics.inert, true); assert.equal(f.veil.inert, false);
});
