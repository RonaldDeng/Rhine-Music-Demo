import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Run the production controller without a DOM/WebGL dependency. Transpilation
// also supports its TypeScript parameter properties on Node's strip-only builds.
const source = await readFile(new URL('../src/music-presentation.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { MusicPresentation } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function fixture({ reduced = false } = {}) {
  const events = [];
  const menuExits = [];
  const browseExits = [];
  const ready = { presentation: false, archive: true };
  const ports = {
    presentationReady: () => ready.presentation,
    archiveReady: () => ready.archive,
    enterCamera() {
      events.push('camera:enter');
      ready.archive = false;
      ready.presentation = reduced;
    },
    returnCamera() {
      events.push('camera:return');
      ready.presentation = false;
      ready.archive = reduced;
    },
    select(selection) {
      events.push({ select: structuredClone(selection) });
      ready.archive = reduced;
    },
    prepareMenu: () => events.push('menu:prepare'),
    showMenu: () => events.push('menu:show'),
    hideMenu(done) {
      events.push('menu:hide');
      if (reduced) done();
      else menuExits.push(done);
    },
    hideBrowse(done) {
      events.push('browse:hide');
      if (reduced) done();
      else browseExits.push(done);
    },
    showBrowse: () => events.push('browse:show'),
    mode: (mode) => events.push(`mode:${mode}`),
  };
  const motion = new MusicPresentation(ports);
  const finishBrowse = () => {
    assert.ok(browseExits.length, 'A browse exit must be pending');
    browseExits.shift()();
  };
  const finishMenu = () => {
    assert.ok(menuExits.length, 'A menu exit must be pending');
    menuExits.shift()();
  };
  const openDetail = () => {
    motion.open();
    if (!reduced) finishBrowse();
    ready.presentation = true;
    motion.update();
    assert.equal(motion.phase, 'detail');
  };
  const selections = () => events.filter((event) => typeof event === 'object').map((event) => event.select);
  return { motion, events, ready, ports, finishBrowse, finishMenu, openDetail, selections, browseExits, menuExits };
}

test('menu waits for both browse exit and completed front/left camera presentation', () => {
  const f = fixture();
  f.motion.open();
  assert.equal(f.motion.phase, 'opening');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 0);
  // A camera readiness signal by itself may not expose an overlapping menu.
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.ready.presentation = false;
  f.finishBrowse();
  for (let frame = 0; frame < 120; frame++) f.motion.update();
  assert.equal(f.motion.phase, 'opening', 'Elapsed frames cannot replace camera readiness');
  assert.ok(!f.events.includes('menu:show'));
  f.ready.presentation = true;
  f.motion.update();
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1);
});

test('switch waits for menu exit, camera return, and new rail settling in that order', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 4 }, true);
  assert.equal(f.motion.phase, 'hiding');
  f.ready.archive = true; // Even a stale ready flag cannot bypass the menu exit.
  f.motion.update();
  assert.deepEqual(f.events, ['menu:hide']);
  f.finishMenu();
  assert.deepEqual(f.events, ['menu:hide', 'mode:archive', 'camera:return']);
  f.motion.update();
  assert.deepEqual(f.selections(), [], 'Do not switch the card while the camera is returning');
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.selections(), [{ index: 4 }]);
  assert.equal(f.motion.phase, 'selecting');
  f.motion.update();
  assert.ok(!f.events.includes('camera:enter'), 'Wait for the selected rail before opening again');
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.events.at(-1), 'menu:show');
  assert.ok(f.events.indexOf('menu:hide') < f.events.indexOf('camera:return'));
  assert.ok(f.events.indexOf('camera:return') < f.events.findIndex((event) => typeof event === 'object'));
});

test('rapid requests retain the latest selection and its navigation intent', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 1 }, true);
  f.motion.select({ index: 2 }, true);
  assert.equal(f.menuExits.length, 1, 'Rapid input must not restart the menu exit');
  f.finishMenu();
  const final = { index: 9, navigation: { axis: 'lane', direction: -1 } };
  f.motion.select(final, true);
  assert.deepEqual(f.motion.pendingSelection, final);
  f.motion.update();
  assert.deepEqual(f.selections(), []);
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.selections(), [final]);
  f.motion.select({ index: 10 }, true);
  f.motion.select({ index: 12 }, false);
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.selections(), [final, { index: 12 }]);
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('back cancels pending selection and a requested reopen while returning', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, true);
  f.motion.back();
  assert.equal(f.motion.pendingSelection, undefined);
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), []);
  assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
});

test('latest back during a committed rail movement settles into browsing', () => {
  const f = fixture();
  f.motion.select({ index: 7 }, true);
  assert.equal(f.motion.phase, 'selecting');
  f.motion.select({ index: 8 }, true);
  f.motion.back();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 7 }]);
  assert.ok(!f.events.includes('camera:enter'));
});

test('replay/reset invalidates old menu-exit callbacks', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 5 }, true);
  f.motion.reset();
  f.events.length = 0;
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.motion.pendingSelection, undefined);
  assert.equal(f.motion.openingOrDetail, false);
  assert.deepEqual(f.events, [], 'A callback from the previous opening cannot move the new scene');
});

test('skip/replay handoff cannot use an old browse exit to reveal the new menu', () => {
  const f = fixture();
  f.motion.open();
  f.motion.reset();
  f.motion.open();
  f.ready.presentation = true;
  f.finishBrowse(); // Completion from before reset.
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  assert.ok(!f.events.includes('menu:show'));
  f.finishBrowse();
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('interrupted opening ignores stale callbacks and honours a later open request', () => {
  const f = fixture();
  f.motion.open();
  f.motion.back();
  f.motion.open();
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.ok(!f.events.includes('menu:show'));
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('reduced-motion synchronous callbacks preserve ordering and never deadlock', () => {
  const f = fixture({ reduced: true });
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 2 }, true);
  assert.equal(f.motion.phase, 'returning');
  for (let frame = 0; frame < 3; frame++) f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.deepEqual(f.events, [
    'menu:hide', 'mode:archive', 'camera:return', { select: { index: 2 } },
    'mode:detail', 'menu:prepare', 'browse:hide', 'camera:enter', 'menu:show',
  ]);
  f.motion.back();
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('enabling reduced motion during an exit can finish existing callbacks safely', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, false);
  f.finishMenu();
  // Real ports snap the camera and drain their existing transition callbacks.
  f.ready.archive = true;
  f.motion.update();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 3 }]);
  assert.equal(f.events.at(-1), 'browse:show');
});

const transitionSource = await readFile(new URL('../src/ui-transitions.ts', import.meta.url), 'utf8');
const transitionModule = ts.transpileModule(transitionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { SurfaceTransition } = await import(`data:text/javascript;base64,${Buffer.from(transitionModule).toString('base64')}`);

function animationElement(hidden = false) {
  const element = { hidden, dataset: {}, opacity: '1', transform: 'none', animations: [] };
  element.animate = (frames, options) => {
    let resolve, reject, finished;
    let settled = false, cancelled = false;
    const animation = {
      frames, options,
      get finished() {
        // Native Animation.finished is only observed when its getter is used.
        return finished ??= new Promise((done, fail) => {
          resolve = done;
          reject = fail;
          if (cancelled) fail(new Error('cancelled'));
          else if (settled) done();
        });
      },
      finish() { settled = true; resolve?.(); },
      cancel() { cancelled = true; reject?.(new Error('cancelled')); },
    };
    element.animations.push(animation);
    return animation;
  };
  return element;
}

test('production menu transition moves right and fades before returning the camera', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  const f = fixture();
  f.openDetail();
  f.ports.hideMenu = (done) => transition.hide(false, done);
  f.motion.select({ index: 6 }, true);
  assert.equal(root.hidden, false, 'Retain the menu while its outgoing frames render');
  assert.equal(root.dataset.transition, 'closing');
  assert.equal(root.animations.at(-1).frames.at(-1).opacity, 0);
  const destination = article.animations.at(-1).frames.at(-1).transform;
  assert.match(destination, /^translateX\([\d.]+px\)$/);
  assert.ok(Number(destination.match(/[\d.]+/)[0]) > 0, 'Exit moves toward screen right');
  assert.ok(!f.events.includes('camera:return'));
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(root.hidden, true);
  assert.equal(f.motion.phase, 'returning');
  assert.equal(f.events.at(-1), 'camera:return');
});

test('production transition cancellation cannot complete an obsolete exit', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  let obsoleteCalls = 0;
  transition.hide(false, () => { obsoleteCalls++; });
  const oldFade = root.animations.at(-1);
  root.opacity = '0.37'; // The browser's current interpolated style on interruption.
  article.transform = 'matrix(1, 0, 0, 1, 23, 0)';
  transition.show(false);
  assert.equal(root.animations.at(-1).frames[0].opacity, '0.37');
  assert.equal(article.animations.at(-1).frames[0].transform, article.transform);
  oldFade.finish();
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(obsoleteCalls, 0);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.transition, 'open');
  let reducedCalls = 0;
  transition.hide(true, () => { reducedCalls++; });
  assert.equal(reducedCalls, 1, 'Reduced motion completes synchronously');
  assert.equal(root.hidden, true);
});
