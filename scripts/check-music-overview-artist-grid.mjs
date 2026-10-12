import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Execute the production controllers and SurfaceTransition together; the DOM
// and WAAPI clock below replace only browser primitives, never grid behavior.
const modules = new Map();
async function compiled(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let { outputText } = ts.transpileModule(await readFile(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [, specifier] of [...outputText.matchAll(/from\s+["']([^"']+)["']/g)]) {
    const dependency = specifier.startsWith('.')
      ? await compiled(new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url))
      : import.meta.resolve(specifier);
    outputText = outputText.replaceAll(`"${specifier}"`, JSON.stringify(dependency))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  modules.set(url.href, result);
  return result;
}
const { MusicOverviewArtistGrid } = await import(await compiled(new URL('../src/music-overview-artist-grid.ts', import.meta.url)));
const { MusicOverviewUI } = await import(await compiled(new URL('../src/music-overview-ui.ts', import.meta.url)));
const { overviewArtists } = await import(await compiled(new URL('../src/music-overview-artists.ts', import.meta.url)));
const { setMusicMotionSpeed } = await import(await compiled(new URL('../src/music-motion-settings.ts', import.meta.url)));

const animations = [];
class Animation {
  currentTime = 0; playbackRate = 1; playState = 'running';
  constructor(element, frames, options) {
    Object.assign(this, { element, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {});
    animations.push(this);
  }
  updatePlaybackRate(value) { this.playbackRate = value; }
  cancel() { this.playState = 'idle'; this.reject(new Error('cancelled')); }
  finish() { this.playState = 'finished'; this.currentTime = (this.options.delay ?? 0) + this.options.duration + (this.options.endDelay ?? 0); this.resolve(); }
}
class Element {
  children = []; dataset = {}; attrs = {}; hidden = false; inert = false; scrollTop = 0;
  offsetTop = 0; offsetHeight = 64; clientHeight = 232;
  style = { setProperty(key, value) { this[key] = value; } };
  listeners = new Map(); gridTemplateColumns = '120px 120px'; text = ''; appendCount = 0;
  constructor(name = 'div', className = '') { this.name = name; this.className = className; }
  append(...elements) {
    for (const element of elements) {
      this.appendCount++;
      if (element.parent) element.remove();
      element.parent = this; this.children.push(element);
    }
  }
  before(element) {
    const parent = this.parent;
    if (!parent) return;
    if (element.parent) element.remove();
    element.parent = parent;
    parent.children.splice(parent.children.indexOf(this), 0, element);
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  set innerHTML(value) {
    // Only the preexisting projected card uses HTML. Artist metadata must never
    // pass through this setter, including names resembling markup.
    assert.ok(value.startsWith('<div class="overview-column">'), 'Artist text must not be parsed as HTML');
    const card = new Element('div', 'overview-column');
    const label = new Element('button', 'overview-column-label');
    label.append(new Element('strong'), new Element('small'));
    const slot = new Element('span', 'overview-enter-slot');
    const enter = new Element('button', 'overview-enter');
    slot.append(enter); card.append(label, slot); this.append(card);
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.name === selector; }
  querySelectorAll(selector) {
    return selector.split(',').flatMap(choice => {
      const parts = choice.trim().split(/\s+/);
      const descendants = this.children.flatMap(child => [child, ...child.descendants()]);
      return descendants.filter(child => {
        if (!child.matches(parts.at(-1))) return false;
        let parent = child.parent;
        for (const part of parts.slice(0, -1).reverse()) {
          while (parent && !parent.matches(part)) parent = parent.parent;
          if (!parent) return false;
          parent = parent.parent;
        }
        return true;
      });
    });
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus(options) {
    document.activeElement = this; this.focusOptions = options;
    for (let node = this; node; node = node.parent) node.dispatch('focusin', { target: this });
  }
  get parentElement() { return this.parent; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this);
    this.parent = undefined;
    if (this.contains(document.activeElement)) document.activeElement = null;
  }
  animate(frames, options) { return new Animation(this, frames, options); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback({ target: this, ...event });
  }
  key(key, modifiers = {}) {
    const event = { key, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...modifiers };
    for (const callback of this.listeners.get('keydown') ?? []) callback(event);
    return event;
  }
}
globalThis.document = { activeElement: null, createElement: name => new Element(name) };
globalThis.HTMLElement = Element;
globalThis.getComputedStyle = element => {
  const value = (property, fallback) => {
    const animation = animations.findLast(a => a.element === element && a.playState !== 'idle' && property in a.frames[0]);
    if (!animation) return fallback;
    const progress = Math.max(0, Math.min(1, (animation.currentTime - (animation.options.delay ?? 0)) / animation.options.duration));
    const before = animation.frames[0][property], after = animation.frames.at(-1)[property];
    return property === 'opacity' ? String(Number(before) + (Number(after) - Number(before)) * progress)
      : progress >= 1 ? after : before;
  };
  return { opacity: value('opacity', '1'), transform: value('transform', 'none'),
    backdropFilter: value('backdropFilter', 'blur(4px) saturate(0.95)'),
    gridTemplateColumns: element.gridTemplateColumns };
};
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
async function advance(milliseconds) {
  for (const animation of animations) if (animation.playState === 'running') {
    animation.currentTime += milliseconds * animation.playbackRate;
    if (animation.currentTime >= (animation.options.delay ?? 0) + animation.options.duration + (animation.options.endDelay ?? 0)) animation.finish();
  }
  await flush();
}
const artist = (key, count = 1) => ({ key, name: `Artist ${key}`, albumIds: Array.from({ length: count }, (_, index) => `${key}-${index}`) });
const catalog = Array.from({ length: 200 }, (_, index) => artist(String(index), index % 3 + 1));
const buttonFor = (root, key) => root.children.find(button => button.dataset.overviewArtist === key);
function gridFixture(artists = catalog) {
  const host = new Element(), root = new Element('div', 'overview-artist-grid'), back = new Element('button');
  host.append(root);
  const grid = new MusicOverviewArtistGrid(root, () => back.focus({ preventScroll: true }));
  grid.setArtists(artists);
  root.children.forEach((button, index) => { button.offsetTop = Math.floor(index / 2) * 78; });
  return { grid, root, back, host, frost: host.children.find(element => element !== root) };
}
const currentAnimations = element => animations.filter(animation => animation.element === element && animation.playState !== 'idle');
const tileOpacity = element => Number(getComputedStyle(element).opacity);

// Frosted glass starts first. Only visible tiles receive a bounded reading-order
// stagger; the browser clock includes the delays and scales them with speed.
for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const { grid, root, frost, host } = gridFixture();
  assert.ok(frost && frost.parentElement === host && root.parentElement === host,
    'Full-screen frost is a sibling of the scrolling grid, not its rectangular backing');
  assert.ok(frost.hidden, 'The full-screen filter starts hidden');
  grid.setActive(true, false);
  assert.ok(!frost.hidden);
  const [first, second, third] = root.children;
  const glass = currentAnimations(frost).find(animation => 'backdropFilter' in animation.frames[0]);
  assert.ok(glass, 'Frosted glass must have its own entering filter animation');
  assert.equal(glass.options.duration, 460);
  assert.notEqual(glass.frames[0].backdropFilter, glass.frames.at(-1).backdropFilter,
    'The filter starts clear and progressively acquires frost');
  assert.ok(!currentAnimations(root).some(animation => 'transform' in animation.frames[0]),
    'The glass surface does not slide its clipping boundary over the tile grid');
  assert.ok(!currentAnimations(root).some(animation => 'backdropFilter' in animation.frames[0]),
    'The grid itself does not create a local rectangular blur');
  assert.equal(currentAnimations(first)[0].options.delay, 80);
  assert.equal(currentAnimations(second)[0].options.delay, 108);
  assert.equal(currentAnimations(third)[0].options.delay, 136);
  assert.equal(currentAnimations(first)[0].options.duration, 360);
  assert.equal(tileOpacity(first), 0);
  assert.equal(tileOpacity(second), 0);
  assert.equal(currentAnimations(root.children.at(-1)).length, 0,
    'Offscreen artists do not accumulate hundreds of delayed animations');
  assert.equal(tileOpacity(root.children.at(-1)), 1, 'Offscreen tiles are ready for immediate scrolling');
  await advance(40 / speed);
  assert.ok(tileOpacity(root) > 0, 'The glass surface is already entering before any label');
  assert.equal(tileOpacity(frost), tileOpacity(root), 'Full-screen frost and the label layer share the same surface reveal clock');
  assert.equal(tileOpacity(first), 0);
  await advance(41 / speed);
  assert.ok(tileOpacity(first) > 0 && tileOpacity(second) === 0, 'The first label begins before the second');
  await advance(28 / speed);
  assert.ok(tileOpacity(first) > tileOpacity(second) && tileOpacity(second) > 0 && tileOpacity(third) === 0,
    'Reading order advances one tile at a time');
  for (const tile of root.children) for (const animation of currentAnimations(tile)) {
    assert.ok((animation.options.delay ?? 0) + animation.options.duration <= 636,
      'Even the last visible tile has a bounded complete entrance');
    assert.equal(animation.playbackRate, speed);
  }
  await advance(527 / speed + .001);
  assert.ok(root.children.every(tile => tileOpacity(tile) === 1));
  assert.equal(tileOpacity(root), 1);
  assert.equal(tileOpacity(frost), 1);
  grid.dispose();
  assert.ok(!frost.parentElement && !host.children.includes(frost), 'Disposal removes the separate full-screen frost');
  assert.equal(currentAnimations(frost).length, 0);
}
setMusicMotionSpeed(1);

// A large library stays responsive when scrolling, keyboard focusing or polling
// while the first screen is still revealing.
{
  const { grid, root } = gridFixture();
  grid.setActive(true, false);
  const entrance = currentAnimations(root.children[0])[0];
  await advance(30);
  grid.setArtists(structuredClone(catalog));
  assert.equal(currentAnimations(root.children[0])[0], entrance, 'An unchanged catalog does not restart the stagger');
  assert.equal(entrance.currentTime, 30);
  root.scrollTop = 7300;
  root.dispatch('scroll');
  await flush();
  assert.ok(root.children.every(tile => tileOpacity(tile) === 1), 'Scrolling finishes all queued labels so no scroll destination is blank');
  assert.ok(root.children.every(tile => currentAnimations(tile).every(animation => animation.playState !== 'running')));
  assert.equal(root.scrollTop, 7300);
  grid.setActive(false, true);
  grid.setActive(true, false);
  const firstVisible = root.children.find(tile => tile.offsetTop + tile.offsetHeight > root.scrollTop && tile.offsetTop < root.scrollTop + root.clientHeight);
  assert.ok(firstVisible && currentAnimations(firstVisible).length > 0);
  assert.equal(currentAnimations(firstVisible)[0].options.delay, 80,
    'Reopening at a deep scroll position starts a fresh local rank, never the global artist index');
  firstVisible.focus();
  await flush();
  assert.equal(tileOpacity(firstVisible), 1, 'Keyboard focus reveals its tile immediately');
  grid.dispose();
  assert.equal(root.listeners.get('scroll')?.size ?? 0, 0);
  assert.equal(root.listeners.get('focusin')?.size ?? 0, 0);
}
{
  const { grid, root } = gridFixture();
  root.clientHeight = 20_000;
  grid.setActive(true, false);
  const delays = root.children.map(tile => currentAnimations(tile)[0].options.delay);
  assert.ok(delays.every((delay, index) => index === 0 || delay > delays[index - 1]),
    'Every visible artist keeps its own reading-order start instead of grouping all later tiles at a capped delay');
  assert.equal(delays[0], 80);
  assert.equal(delays.at(-1), 276);
  const last = currentAnimations(root.children.at(-1))[0];
  assert.ok(last && last.options.delay <= 276 && last.options.duration + last.options.delay <= 636,
    'An unusually tall viewport still caps the last reveal instead of multiplying delay by 200 artists');
  await advance(20);
  const before = [...root.children];
  grid.setArtists(catalog.slice(0, -1));
  await flush();
  assert.equal(root.children.length, 199);
  assert.ok(before.every(tile => currentAnimations(tile).every(animation => animation.playState !== 'running')),
    'A real catalog update retires all old tile animations, including a removed artist');
  assert.ok(root.children.every(tile => tileOpacity(tile) === 1));
  grid.dispose();
}

// Closing during queued/staggered reveals cannot flash hidden labels. Reopening
// samples the current appearance and never reintroduces the initial delay.
for (const closeAt of [40, 120, 300, 700]) {
  const { grid, root, frost } = gridFixture(catalog.slice(0, 6));
  grid.setActive(true, false);
  await advance(closeAt);
  const before = root.children.map(tileOpacity);
  grid.setActive(false, false);
  assert.deepEqual(root.children.map(tileOpacity), before, 'Interrupting entry preserves every current tile opacity');
  for (const tile of root.children) for (const animation of currentAnimations(tile))
    assert.equal(animation.options.delay ?? 0, 0, 'Outgoing tiles discard entry delays');
  await advance(30);
  const fading = root.children.map(tileOpacity);
  assert.ok(fading.every((opacity, index) => opacity <= before[index]), 'No queued tile becomes brighter during exit');
  grid.setActive(true, false);
  assert.deepEqual(root.children.map(tileOpacity), fading, 'Reopening retains the current tile opacity');
  for (const tile of root.children) for (const animation of currentAnimations(tile))
    assert.equal(animation.options.delay ?? 0, 0, 'A rapid reversal has no fresh per-tile wait');
  await advance(700);
  assert.ok(grid.visible && !root.inert && root.children.every(tile => tileOpacity(tile) === 1),
    'Old close callbacks cannot conceal a reopened list');
  assert.ok(!frost.hidden && tileOpacity(frost) === 1, 'Old close callbacks cannot hide the reopened full-screen frost');
  grid.dispose();
}
{
  const { grid, root, frost } = gridFixture(catalog.slice(0, 6));
  grid.setActive(true, false); await advance(460);
  const unfinished = root.children.filter(tile => currentAnimations(tile).length > 0);
  const complete = root.children.filter(tile => currentAnimations(tile).length === 0);
  assert.ok(unfinished.length && complete.length, 'Fixture includes both finished and still-entering tiles');
  grid.setActive(false, false); await advance(180);
  assert.ok(grid.visible, 'The root still owns the last part of its 240 ms exit');
  assert.ok(unfinished.every(tile => tileOpacity(tile) === 0), 'Interrupted tile exits retain zero opacity until the panel has left');
  assert.ok(complete.every(tile => tileOpacity(tile) === 1), 'Already settled tiles follow the common panel fade');
  root.dispatch('scroll');
  assert.ok(unfinished.every(tile => tileOpacity(tile) === 0), 'A late inertial scroll cannot cancel exit fill and flash labels back');
  await advance(59);
  assert.ok(grid.visible && unfinished.every(tile => tileOpacity(tile) === 0));
  await advance(1);
  assert.ok(!grid.visible);
  assert.ok(frost.hidden, 'The full-screen frost hides on the same completed exit');
  assert.ok(root.children.every(tile => currentAnimations(tile).length === 0), 'A completed close releases every fill-held tile animation');
  assert.equal(currentAnimations(frost).length, 0, 'A completed close releases the glass animation');
  grid.dispose();
}
{
  const { grid, root } = gridFixture();
  grid.setActive(true, false);
  await advance(40);
  const tile = root.children[1], delayed = currentAnimations(tile)[0];
  setMusicMotionSpeed(3);
  assert.equal(delayed.currentTime, 40, 'Changing global speed does not jump delayed animation time');
  assert.equal(delayed.playbackRate, 3, 'A tile still in its delay follows global speed changes');
  await advance(23);
  assert.ok(tileOpacity(tile) > 0, 'The remaining delay runs at the new speed');
  grid.finish(); await flush();
  assert.ok(root.children.every(button => tileOpacity(button) === 1));
  assert.ok([root, ...root.children].every(element => currentAnimations(element).every(animation => animation.playState !== 'running')),
    'Switching to reduced motion finishes glass, root and all delayed labels');
  grid.setActive(false, true);
  grid.setActive(true, true);
  assert.ok(root.children.every(button => tileOpacity(button) === 1));
  assert.ok([root, ...root.children].every(element => currentAnimations(element).length === 0), 'Reduced entrance creates no stagger or glass animation');
  grid.dispose();
}
setMusicMotionSpeed(1);

// Polling can finish while the sheet is fading. Defer DOM changes until hidden,
// retain only the newest library snapshot, and apply it safely on early reopen.
for (const reopen of [false, true]) {
  const { grid, root } = gridFixture(catalog.slice(0, 6));
  grid.setActive(true, false); await advance(460);
  const initial = [...root.children];
  grid.setActive(false, false); await advance(100);
  const fading = initial.map(tileOpacity), appended = root.appendCount;
  grid.setArtists(catalog.slice(0, 5));
  grid.setArtists([...catalog.slice(0, 4), artist('new')]);
  assert.equal(root.appendCount, appended, 'Library updates during exit do not insert fully opaque tiles');
  assert.deepEqual(root.children, initial, 'Closing keeps the original fading DOM until completion');
  assert.deepEqual(initial.map(tileOpacity), fading, 'Library polling cannot reset exit opacity');
  if (reopen) grid.setActive(true, false);
  await advance(reopen ? 700 : 140);
  assert.equal(grid.count, 5);
  assert.ok(grid.artist('new') && !grid.artist('4') && !grid.artist('5'), 'Only the latest pending library snapshot is reconciled');
  assert.equal(root.children.length, 5);
  assert.equal(grid.visible, reopen, 'Pending catalog work cannot hide a reopened sheet or prolong a completed close');
  assert.ok(root.children.every(tile => currentAnimations(tile).length === 0), 'Pending reconciliation leaves no stale animated tile');
  grid.dispose();
}
{
  const { grid, root } = gridFixture(catalog.slice(0, 6));
  grid.setActive(true, false); await advance(460);
  grid.setActive(false, false); await advance(60);
  grid.setArtists(catalog.slice(0, 3));
  grid.setActive(false, true);
  await flush();
  assert.ok(!grid.visible && root.inert, 'Enabling reduced motion during an existing close finishes its surface immediately');
  assert.equal(grid.count, 3, 'Reduced completion also flushes the pending library snapshot');
  assert.ok([root, ...root.children].every(element => currentAnimations(element).length === 0),
    'Reduced repeated-close completion releases glass and fill-held tile animations');
  grid.setActive(true, true);
  assert.equal(root.children.length, 3);
  assert.ok(root.children.every(tile => tileOpacity(tile) === 1));
  grid.dispose();
}

// Full membership, no virtual omission, and no DOM churn on selection frames.
{
  const { grid, root, back } = gridFixture();
  assert.equal(grid.count, 200);
  assert.equal(root.children.length, 200);
  grid.setActive(true, true);
  root.scrollTop = 734;
  const initial = [...root.children], target = buttonFor(root, '199');
  target.focus();
  const appended = root.appendCount;
  grid.setArtists(structuredClone(catalog));
  assert.equal(root.appendCount, appended, 'An identical polled catalog performs no DOM append/reorder');
  assert.equal(document.activeElement, target, 'An identical catalog does not disturb focus');
  assert.equal(root.scrollTop, 734, 'An identical catalog does not disturb scroll');
  for (let index = 0; index < 40; index++) grid.setSelectedAlbum(`${index}-0`);
  assert.deepEqual(root.children, initial, 'Selection updates preserve every button identity and order');
  assert.equal(root.scrollTop, 734, 'Selection frames preserve native scroll position');
  assert.equal(document.activeElement, target, 'Scene selection cannot steal grid focus');
  assert.equal(buttonFor(root, '39').attrs['aria-pressed'], 'true');
  assert.equal(root.children.filter(button => button.attrs['aria-pressed'] === 'true').length, 1);
  grid.setArtists([...catalog].reverse());
  assert.ok(root.appendCount > appended, 'A genuinely reordered catalog reconciles its order');
  assert.equal(root.children[0], target, 'Catalog reconciliation reorders rather than recreates artists');
  assert.equal(document.activeElement, target, 'Catalog reconciliation retains focused artist');
  assert.equal(root.scrollTop, 734);
  grid.setArtists(catalog.slice(0, -1));
  assert.equal(document.activeElement, back, 'Removing the focused artist returns focus safely');
  assert.equal(grid.artist('199'), undefined);
  assert.equal(grid.count, 199);
  grid.setArtists([]);
  assert.equal(root.children.length, 0, 'Clearing a library leaves no stale artist');
  grid.dispose();
  assert.equal(root.listeners.get('keydown').size, 0, 'Disposed grids detach their keyboard owner');
}

// Metadata enters through textContent and dataset, never CSS selectors/HTML.
{
  const names = ['__proto__', 'constructor', 'x"] <img src=x onerror=alert(1)>', '', '  ADELE  ', 'Ａｄｅｌｅ'];
  const albums = names.map((name, index) => ({ id: `safe-${index}`, title: `${index}`, artist: name }));
  const artists = overviewArtists(albums);
  const { grid, root } = gridFixture(artists);
  assert.equal(grid.count, 5, 'Normalized duplicate artist spellings share one button');
  assert.equal(root.children.length, 5);
  assert.equal(grid.artist('adele').albumIds.length, 2);
  for (const item of artists) {
    const button = buttonFor(root, item.key);
    assert.equal(button.querySelector('strong').textContent, item.name);
    assert.deepEqual(button.children.map(child => child.name), ['strong', 'small']);
    assert.equal(button.attrs['aria-label'], `选择歌手：${item.name}，${item.albumIds.length} 张专辑`);
  }
  grid.setActive(true, true);
  buttonFor(root, '').focus();
  grid.setArtists(artists);
  assert.equal(document.activeElement, buttonFor(root, ''), 'An empty normalized key still retains focus');
  grid.dispose();
}

// Use the actual event handler to move focus by rendered grid track count.
{
  const { grid, root } = gridFixture(catalog.slice(0, 7));
  grid.setActive(true, true);
  root.gridTemplateColumns = '120px 120px 120px';
  root.children[0].focus();
  for (const [key, expected] of [['ArrowDown', 3], ['ArrowRight', 4], ['ArrowUp', 1], ['ArrowLeft', 0], ['End', 6], ['ArrowDown', 6], ['Home', 0], ['ArrowUp', 0]]) {
    const event = root.key(key);
    assert.equal(document.activeElement, root.children[expected], key);
    assert.ok(event.defaultPrevented && event.propagationStopped, `${key} cannot reach scene keyboard navigation`);
  }
  root.gridTemplateColumns = '260px';
  root.key('ArrowDown');
  assert.equal(document.activeElement, root.children[1], 'One-column portrait moves exactly one card vertically');
  for (const [key, modifiers] of [['ArrowDown', { ctrlKey: true }], ['ArrowDown', { altKey: true }], ['ArrowDown', { metaKey: true }], ['Enter', {}], ['Tab', {}]]) {
    const event = root.key(key, modifiers);
    assert.ok(!event.defaultPrevented && !event.propagationStopped, 'Native activation/tab and modified keys retain browser ownership');
  }
  assert.equal(document.activeElement, root.children[1]);
  grid.dispose();
}

// Shared animation speed, finite inert exit and reversal all use production WAAPI.
for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const { grid, root, back } = gridFixture(catalog.slice(0, 2));
  grid.setActive(true, false);
  assert.equal(root.dataset.transition, 'opening');
  await advance(460 / speed);
  assert.equal(root.dataset.transition, 'open');
  root.children[0].focus();
  grid.setActive(false, false);
  assert.ok(grid.visible && root.inert, 'Closing retains pixels but immediately disables interaction');
  assert.equal(document.activeElement, back);
  await advance(239 / speed);
  assert.ok(grid.visible, `Exit remains visible for its full duration at ${speed}×`);
  await advance(1 / speed + .001);
  assert.ok(!grid.visible);
  grid.setActive(true, false);
  await advance(460 / speed);
  grid.setActive(false, false);
  await advance(80 / speed);
  const oldOpacity = Number(getComputedStyle(root).opacity);
  grid.setActive(true, false);
  assert.equal(Number(getComputedStyle(root).opacity), oldOpacity, 'Reopening continues the current opacity');
  await advance(1000 / speed);
  assert.ok(grid.visible && !root.inert, 'The stale close callback cannot hide a reopened grid');
  assert.equal(root.dataset.transition, 'open');
  grid.dispose();
}
{
  setMusicMotionSpeed(1);
  const { grid, root } = gridFixture();
  grid.setActive(true, true);
  grid.setActive(false, false);
  await advance(60);
  const opacity = getComputedStyle(root).opacity;
  setMusicMotionSpeed(3);
  assert.equal(getComputedStyle(root).opacity, opacity, 'Speed changes preserve current progress');
  await advance(59);
  assert.ok(grid.visible);
  await advance(1);
  assert.ok(!grid.visible, 'The remainder follows the new global speed without restarting');
  grid.setActive(true, true);
  assert.equal(root.dataset.transition, 'open');
  grid.setActive(false, true);
  assert.ok(!grid.visible && root.inert, 'Reduced motion completes exits immediately');
  grid.setActive(true, false);
  grid.finish();
  await flush();
  assert.equal(root.dataset.transition, 'open', 'Enabling reduced motion can finish the in-flight entrance');
  grid.dispose();
}
setMusicMotionSpeed(1);

function overviewFixture() {
  const surface = new Element(), container = new Element(), panel = new Element('div', 'overview-artist-grid');
  surface.hidden = true;
  const heading = new Element('div', 'overview-heading'), title = new Element('h2'), description = new Element('p');
  title.textContent = '按歌手名字浏览收藏'; description.textContent = '点击列名切换到该列';
  heading.append(title, description);
  const controls = new Element('nav', 'overview-controls'), back = new Element('button', 'overview-return');
  Object.assign(heading, { offsetTop: 115, offsetHeight: 0 });
  Object.assign(controls, { offsetTop: 488 }); Object.assign(back, { offsetTop: 488 });
  surface.append(heading, controls, back, container, panel);
  const ui = new MusicOverviewUI(surface, container, () => back.focus({ preventScroll: true }), panel);
  ui.setArtists(catalog);
  const frost = surface.querySelector('.overview-artist-frost');
  assert.ok(frost, 'Overview hosts the sibling full-screen frost');
  return { ui, surface, container, panel, frost, heading, title, description };
}
const projection = { lane: 0, physicalLane: 0, name: 'One projected artist', count: 1, x: 300, y: 300, selected: true };
{
  const f = overviewFixture();
  f.ui.setActive(true, false);
  f.ui.update([], 600, 600, .13, false, '歌手');
  assert.ok(f.ui.isArtistGrid && f.ui.hasLabels, 'Exactly square uses the artist panel at the chrome entrance gate');
  assert.ok(!f.frost.hidden, 'Square mode activates the full-screen frost alongside the grid');
  assert.equal(f.panel.children.length, 200, 'An empty projected scene cannot remove any library artists');
  assert.equal(f.container.children.length, 0, 'Grid mode never mounts projected names');
  assert.equal(f.title.textContent, '选择歌手');
  assert.ok(f.description.textContent.includes('200'));
  await advance(460);
  f.ui.setActive(false, false);
  assert.ok(f.ui.hasLabels, 'App camera wait includes a closing artist panel');
  await advance(239);
  assert.ok(f.ui.hasLabels && !f.surface.hidden, 'Closing grid and overview surface remain through the finite exit');
  assert.ok(!f.frost.hidden, 'Full-screen frost stays attached to the same finite exit');
  await advance(1);
  assert.ok(!f.ui.hasLabels && f.surface.hidden, 'Grid completion releases the camera wait');
  assert.ok(f.frost.hidden, 'No full-screen frost survives the normal overview exit');
  f.ui.setActive(true, true);
  f.ui.update([], 320, 568, 1, true, '歌手');
  assert.ok(f.ui.isArtistGrid && f.ui.hasLabels && !f.panel.hidden);
  const nodes = [...f.panel.children];
  f.ui.setSelectedAlbum('199-0');
  f.ui.update([], 320, 2000, 1, true, '歌手');
  assert.deepEqual(f.panel.children, nodes, 'Narrower resize and selection do not rebuild panel membership');
  f.ui.update([projection], 601, 600, 1, true, '歌手');
  assert.ok(f.ui.isArtistGrid && !f.panel.hidden, 'Slightly wider than square still uses the shared portrait layout');
  f.ui.update([projection], 629, 600, 1, true, '歌手');
  assert.ok(f.ui.isArtistGrid && !f.panel.hidden, 'The last portrait pixel before the 1.05 boundary retains the grid');
  assert.equal(f.container.children.length, 0);
  f.ui.update([projection], 630, 600, 1, true, '歌手');
  assert.ok(!f.ui.isArtistGrid && f.panel.hidden, 'Exactly 1.05 restores projected mode with the scene and DOM');
  assert.ok(f.frost.hidden, 'Landscape mode removes the full-screen filter immediately with the retired grid');
  assert.equal(f.title.textContent, '按歌手名字浏览收藏');
  assert.equal(f.container.children.length, 1);
  f.ui.update([], 600, 600, 1, true, '歌手');
  assert.equal(f.container.children.length, 0, 'Returning to square removes all projected anchors');
  assert.equal(f.panel.children.length, 200);
  assert.ok(!f.frost.hidden, 'A subsequent square mode reuses and reveals its frost');
  f.ui.setActive(false, true);
  assert.ok(!f.ui.hasLabels && f.surface.hidden, 'Reduced whole-surface exit never leaves pending camera labels');
  assert.ok(f.frost.hidden, 'Reduced motion leaves no visible full-screen filter');
  f.ui.dispose();
  assert.ok(!f.surface.querySelector('.overview-artist-frost'), 'Disposing the overview removes its sibling filter node');
}
{
  const f = overviewFixture();
  f.ui.setActive(true, false); f.ui.update([], 430, 932, 1, false, '歌手');
  await advance(460);
  f.ui.setActive(false, false); await advance(60);
  f.ui.setActive(true, false); f.ui.update([], 430, 932, 1, false, '歌手');
  await advance(1000);
  assert.ok(!f.surface.hidden && !f.panel.hidden && f.ui.isArtistGrid && f.ui.hasLabels,
    'Rapid return/reopen cancels both grid and outer-surface close callbacks');
  assert.ok(!f.frost.hidden, 'Rapid reopen keeps the correct full-screen filter visible');
  f.ui.setActive(false, false);
  f.ui.update([], 932, 430, 1, false, '歌手');
  assert.ok(!f.ui.hasLabels, 'Rotation during close releases a retired grid instead of stranding camera wait');
  assert.ok(f.frost.hidden, 'Rotation during close never strands full-screen frost over landscape mode');
  await advance(240);
  assert.ok(f.surface.hidden);
  assert.ok(f.frost.hidden && currentAnimations(f.frost).length === 0);
  f.ui.dispose();
}

// The user preference switches the existing interaction surface immediately.
// Every theme and speed keeps the same full catalog, stagger and cleanup path.
for (const theme of ['day', 'night', 'dusk']) for (const speed of [.25, 1, 3]) {
  for (const reduced of [false, true]) {
    setMusicMotionSpeed(speed);
    const f = overviewFixture();
    f.surface.dataset.theme = theme;
    f.ui.setActive(true, reduced);
    f.ui.update([projection], 1440, 900, 1, reduced, '歌手');
    assert.ok(!f.ui.isArtistGrid && f.panel.hidden && f.frost.hidden,
      'Without the preference a landscape overview retains projected names');
    assert.equal(f.container.children.length, 1);
    f.ui.expand(0);
    assert.ok(f.ui.canEnter(0));
    const nodes = [...f.panel.children];
    f.panel.scrollTop = 144;
    f.ui.setSelectedAlbum('199-0');

    f.ui.update([projection], 1440, 900, 1, reduced, '歌手', 0, true);
    assert.ok(f.ui.isArtistGrid && f.ui.hasLabels && !f.panel.hidden && !f.frost.hidden,
      'All-ratios mode opens the existing artist grid and frost in every theme');
    assert.equal(f.surface.dataset.layout, 'grid');
    assert.equal(f.container.children.length, 0, 'Enabling the grid retires every projected anchor');
    assert.ok(!f.ui.canEnter(0), 'Projected expansion cannot survive the preference switch');
    assert.deepEqual(f.panel.children, nodes, 'The preference reuses the complete artist catalog');
    assert.equal(f.panel.scrollTop, 144);
    assert.equal(buttonFor(f.panel, '199').attrs['aria-pressed'], 'true');
    assert.equal(f.title.textContent, '选择歌手');

    const frostAnimations = currentAnimations(f.frost);
    f.surface.dataset.theme = theme === 'day' ? 'night' : 'day';
    f.ui.update([], 3440, 1440, 1, reduced, '流派', 1 / 60, true);
    assert.ok(f.ui.isArtistGrid && !f.frost.hidden, 'Theme, sort and wider resize cannot override the preference');
    assert.deepEqual(currentAnimations(f.frost), frostAnimations,
      'An unchanged forced-grid mode does not restart its surface or frost animation');
    assert.deepEqual(f.panel.children, nodes);
    if (!reduced) await advance(60 / speed);

    f.ui.update([projection], 1440, 900, 1, reduced, '歌手', 0, false);
    assert.ok(!f.ui.isArtistGrid && f.panel.hidden && f.frost.hidden,
      'Disabling the preference in landscape clears even an unfinished grid entrance');
    assert.equal(f.surface.dataset.layout, 'projected');
    assert.equal(f.container.children.length, 1);
    assert.equal(f.title.textContent, '按歌手名字浏览收藏');
    assert.equal(currentAnimations(f.frost).length, 0);
    assert.ok(nodes.every(node => currentAnimations(node).length === 0),
      'Retired stagger callbacks cannot reveal tiles over the projected view');

    f.ui.update([], 1440, 900, 1, reduced, '歌手', 0, true);
    assert.ok(f.ui.isArtistGrid && !f.frost.hidden, 'A rapid re-enable opens the same grid cleanly');
    assert.deepEqual(f.panel.children, nodes);
    assert.equal(f.panel.scrollTop, 144);
    f.ui.setActive(false, reduced);
    if (!reduced) {
      assert.ok(f.ui.hasLabels, 'Forced grid exit retains the same camera wait as portrait');
      const exitDuration = currentAnimations(f.panel).find(animation => 'opacity' in animation.frames[0]).options.duration;
      assert.ok(exitDuration >= 72 && exitDuration <= 240,
        'Closing an unfinished entrance preserves the existing bounded reversal duration');
      await advance((exitDuration - 1) / speed);
      assert.ok(f.ui.hasLabels && !f.frost.hidden);
      await advance(1 / speed + .001);
      assert.ok(f.panel.hidden && f.frost.hidden && !f.ui.hasLabels,
        'The grid releases camera ownership on completion of its own finite exit');
      await advance(240 / speed);
    }
    assert.ok(f.surface.hidden && f.panel.hidden && f.frost.hidden && !f.ui.hasLabels);
    assert.equal(currentAnimations(f.frost).length, 0);
    f.ui.dispose();
  }
}
setMusicMotionSpeed(1);

{
  const f = overviewFixture();
  f.ui.setActive(true, false);
  f.ui.update([], 1440, 900, .12, false, '歌手', 0, true);
  assert.ok(f.ui.isArtistGrid && f.panel.hidden && f.frost.hidden && !f.ui.hasLabels,
    'The override preserves the original camera progress gate before chrome appears');
  f.ui.update([], 1440, 900, .13, false, '歌手', 0, true);
  assert.ok(!f.panel.hidden && !f.frost.hidden);
  f.ui.update([], 629, 600, .13, false, '歌手', 0, false);
  assert.ok(f.ui.isArtistGrid && !f.panel.hidden,
    'Disabling the override inside the portrait boundary leaves the active grid intact');
  f.ui.setActive(false, false);
  await advance(60);
  f.ui.update([], 630, 600, .13, false, '歌手', 0, false);
  assert.ok(!f.ui.hasLabels && f.panel.hidden && f.frost.hidden,
    'The shared portrait boundary still releases a grid that is closing');
  await advance(240);
  assert.ok(f.surface.hidden && currentAnimations(f.frost).length === 0);
  f.ui.dispose();
}

// Execute the actual app selection and column-memory path. Only scene/data
// boundaries are supplied; the function bodies come from the TS syntax tree.
{
  const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['selectOverviewArtist', 'selectOverviewColumn', 'resolveColumnSelection', 'navigationSelection'];
  const methods = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  assert.ok(methods.every(Boolean), 'Actual artist selection, column resolution and pending-selection functions must be present');
  const logic = ts.transpileModule(methods.map(method => method.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  function appFixture(sortMode = 'artist') {
    const records = ['a0', 'b0', 'a1', 'b1', 'blank0'].map(id => ({ id }));
    const artists = new Map([
      ['a', { key: 'a', albumIds: ['a0', 'a1'] }],
      ['b', { key: 'b', albumIds: ['b0', 'b1'] }],
      ['', { key: '', albumIds: ['blank0'] }],
      ['stale', { key: 'stale', albumIds: ['removed'] }],
    ]);
    const lanes = sortMode === 'artist' ? [[0, 2], [1, 3], [4]] : sortMode === 'genre' ? [[0, 1, 4], [2, 3]] : [[0, 1], [2, 3, 4]];
    const archiveColumns = lanes.map((_, index) => `column-${index}`);
    const fileLocation = index => ({ lane: lanes.findIndex(files => files.includes(index)), row: 12 + lanes.find(files => files.includes(index)).indexOf(index) });
    const columnFiles = lane => lanes[lane] ?? [];
    const overviewUI = { isArtistGrid: true, artist: key => artists.get(key) };
    const scene = { musicColumnCell: (lane, row) => ({ lane: lane + 6, row }), musicBrowseRow: 12 };
    const calls = [];
    return new Function('records', 'archiveColumns', 'fileLocation', 'columnFiles', 'overviewUI', 'scene', 'preferences', 'calls', `
      let selected = 0, libraryRebuilding = false, libraryIntent;
      const presentation = { pendingSelection: undefined };
      const columnMemory = new Map(archiveColumns.map((name, lane) => [name, records[columnFiles(lane).at(-1)]?.id]));
      const fileAtCell = cell => columnFiles(cell.lane)[cell.row - 12] ?? -1;
      function select(index, navigation, openAfter) {
        calls.push({ kind: 'select', index, navigation, openAfter });
        presentation.pendingSelection = { index, navigation };
      }
      function setOverview(active) { calls.push({ kind: 'overview', active }); overviewUI.isArtistGrid = active; }
      ${logic}
      return {
        click: selectOverviewArtist, calls, overviewUI, presentation,
        pending: () => navigationSelection(),
        setPending: index => { presentation.pendingSelection = { index, navigation: { axis: 'row', direction: 1 } }; },
        setLibraryIntent: index => { libraryRebuilding = true; libraryIntent = { index }; },
      };
    `)(records, archiveColumns, fileLocation, columnFiles, overviewUI, scene,
      { sortMode, rememberColumnPosition: true, arrayMode: 'filled' }, calls);
  }
  {
    const f = appFixture('artist');
    f.click('b');
    assert.deepEqual(f.calls, [
      { kind: 'select', index: 3, navigation: undefined, openAfter: false },
      { kind: 'overview', active: false },
    ], 'Artist sort reuses the column-memory resolver, retaining the remembered b1 album');
    f.click('a');
    assert.equal(f.calls.length, 2, 'A second event after return starts cannot retarget the exiting panel');
  }
  for (const sortMode of ['genre', 'album']) {
    const f = appFixture(sortMode);
    f.click('b');
    assert.deepEqual(f.calls, [
      { kind: 'select', index: 1, navigation: undefined, openAfter: false },
      { kind: 'overview', active: false },
    ], `${sortMode} sort chooses a real album of the requested singer rather than treating an artist index as a scene lane`);
  }
  for (const sortMode of ['artist', 'genre', 'album']) {
    const f = appFixture(sortMode);
    f.setPending(3);
    const pendingObject = f.presentation.pendingSelection;
    f.click('b');
    assert.deepEqual(f.calls, [{ kind: 'overview', active: false }], 'Already-current singer preserves the pending album and physical route');
    assert.equal(f.presentation.pendingSelection, pendingObject);
    assert.equal(f.pending(), 3);
    const rebuilding = appFixture(sortMode);
    rebuilding.setLibraryIntent(3); rebuilding.click('b');
    assert.deepEqual(rebuilding.calls, [{ kind: 'overview', active: false }], 'Selection during rebuild respects the pending library intent');
  }
  for (const key of ['missing', 'stale']) {
    const f = appFixture();
    f.click(key);
    assert.deepEqual(f.calls, [], 'Missing or stale catalog entries neither navigate nor close overview');
  }
  {
    const f = appFixture();
    f.overviewUI.isArtistGrid = false; f.click('b');
    assert.deepEqual(f.calls, [], 'Inactive/projected overview ignores stale artist-grid events');
  }
  {
    const f = appFixture('album');
    f.click('');
    assert.deepEqual(f.calls, [
      { kind: 'select', index: 4, navigation: undefined, openAfter: false },
      { kind: 'overview', active: false },
    ], 'The empty normalized key can select the unknown-artist album');
  }
}
console.log('Artist grid runtime: frost-first bounded tile stagger, large-library scroll/focus, interruption/polling/reopen, shared/reduced motion, complete/stable catalog, literal keys, shared portrait boundary, all-ratios toggles across themes/speeds, camera exit lifetime and app selection across all sorts passed.');
