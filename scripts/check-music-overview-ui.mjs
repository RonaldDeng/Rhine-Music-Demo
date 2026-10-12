import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

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
const { MusicOverviewUI } = await import(await compiled(new URL('../src/music-overview-ui.ts', import.meta.url)));
const { SurfaceTransition } = await import(await compiled(new URL('../src/ui-transitions.ts', import.meta.url)));
const { setMusicMotionSpeed } = await import(await compiled(new URL('../src/music-motion-settings.ts', import.meta.url)));
const { visibleOverviewLabels, overviewLabelMetrics, overviewLabelOpacity, overviewCollisionOpacity, overviewBoundaryClearance } =
  await import(await compiled(new URL('../src/music-overview.ts', import.meta.url)));
const animations = [];
class Animation {
  currentTime = 0; playbackRate = 1; playState = 'running'; completed = false;
  constructor(element, frames, options) {
    Object.assign(this, { element, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {});
    animations.push(this);
  }
  updatePlaybackRate(value) { this.playbackRate = value; }
  cancel() { this.playState = 'idle'; this.reject(new Error('cancelled')); }
  finish() { this.completed = true; this.playState = 'finished'; this.currentTime = this.options.duration; this.resolve(); }
}
class Element {
  children = []; style = { setProperty(key, value) { this[key] = value; } }; dataset = {}; attrs = {}; hidden = false; inert = false;
  constructor(name = 'div', className = '') { this.name = name; this.className = className; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  set innerHTML(_value) {
    const card = new Element('div', 'overview-column');
    const label = new Element('button', 'overview-column-label');
    label.append(new Element('strong'), new Element('small'));
    const slot = new Element('span', 'overview-enter-slot');
    const enter = new Element('button', 'overview-enter');
    slot.append(enter); card.append(label, slot); this.append(card);
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelectorAll(selector) {
    const choices = selector.split(',').map(x => x.trim());
    return this.children.flatMap(child => [
      ...(choices.some(x => x.startsWith('.') ? child.className === x.slice(1) : child.name === x) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus() { document.activeElement = this; }
  get parentElement() { return this.parent; }
  getBoundingClientRect() { return { width: this.rectWidth ?? 0 }; }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
  animate(frames, options) { return new Animation(this, frames, options); }
}
globalThis.document = { activeElement: null, createElement: name => new Element(name) };
globalThis.getComputedStyle = element => {
  const fade = animations.findLast(a => a.element === element && a.playState !== 'idle' && 'opacity' in a.frames[0]);
  const value = fade ? Number(fade.frames[0].opacity) + (Number(fade.frames[1].opacity) - Number(fade.frames[0].opacity)) * Math.min(1, fade.currentTime / fade.options.duration) : 1;
  return { opacity: String(value), transform: 'none' };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function advance(ms) {
  for (const animation of animations) if (animation.playState === 'running') {
    animation.currentTime += ms * animation.playbackRate;
    if (animation.currentTime >= animation.options.duration) animation.finish();
  }
  await flush();
}
function fixture() {
  const surface = new Element(), container = new Element(); surface.hidden = true;
  const chrome = ['overview-heading', 'overview-controls', 'overview-return'].map(name => new Element('div', name));
  Object.assign(chrome[0], { offsetTop: 115, offsetHeight: 0 });
  Object.assign(chrome[1], { offsetTop: 632 });
  Object.assign(chrome[2], { offsetTop: 632 });
  surface.append(...chrome, container);
  const ui = new MusicOverviewUI(surface, container, () => chrome[2].focus());
  return { ui, surface, container, chrome };
}
const column = (lane, x, y = 300) => ({ lane, physicalLane: lane, name: `Artist ${lane}`, count: 3, x, y, selected: lane === 0 });
const update = (f, columns, reduced = false) => f.ui.update(columns, 1280, 720, 1, reduced, '歌手');
const byLane = (f, lane) => f.container.children.find(anchor =>
  anchor.querySelector('.overview-column-label').dataset.overviewLane === String(lane));
const desktopMetrics = overviewLabelMetrics(1280);
const leftAt = clearance => 12 + desktopMetrics.width / 2 + clearance;
const nextAt = (x, gap) => x + desktopMetrics.width + desktopMetrics.entry + gap;
const topAt = clearance => 115 + desktopMetrics.height + clearance;
function assertProjection(anchor, projection, context = '') {
  assert.ok(Math.abs(Number.parseFloat(anchor.style.left) - projection.x) <= .00501,
    `${context}: X follows the physical projection without clamping or easing`);
  assert.ok(Math.abs(Number.parseFloat(anchor.style.top) - projection.y) <= .00501,
    `${context}: Y follows the physical projection without row packing or easing`);
}
function footprint(label, width) {
  const metrics = overviewLabelMetrics(width);
  return { left: label.x - metrics.width / 2, right: label.x + metrics.width / 2 + metrics.entry,
    top: label.y - metrics.height, bottom: label.y + metrics.stem };
}
function paintedShapes(label, width) {
  const metrics = overviewLabelMetrics(width);
  return [
    { left: label.x - metrics.width / 2, right: label.x + metrics.width / 2 + metrics.entry,
      top: label.y - metrics.height, bottom: label.y },
    { left: label.x, right: label.x + 1, top: label.y, bottom: label.y + metrics.stem },
  ];
}
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function assertSelectionGeometry(input, labels, width, height, bounds = { top: 115, bottom: height - 112 }) {
  assert.equal(new Set(labels.map(label => label.lane)).size, labels.length, 'A logical identity appears at most once');
  for (const label of labels) {
    const source = input.find(item => item.lane === label.lane);
    assert.deepEqual(label, source, 'Visibility selection cannot resize or displace the supplied projection');
    const box = footprint(label, width);
    assert.ok(box.left >= 12 && box.right <= width - 12, 'Complete name and entry footprint remains inside horizontal bounds');
    assert.ok(box.top >= bounds.top && box.bottom <= bounds.bottom, 'Complete name and stem clear the heading and controls');
    const opacity = overviewLabelOpacity(label, width, height, bounds);
    assert.equal(opacity, 1, 'Every retained footprint uses binary safety, never a permanent fractional alpha');
    for (const other of labels) if (other.lane !== label.lane)
      assert.ok(!paintedShapes(label, width).some(a => paintedShapes(other, width).some(b => overlaps(a, b))),
        'Selected card/arrow rectangles and narrow stems cannot intersect');
  }
}

// UI lifetime, keyboard state, and animation ownership remain separate from projection.
{
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400), column(1, 650)]);
  const first = byLane(f, 0), second = byLane(f, 1), firstCard = first.querySelector('.overview-column');
  assert.equal(f.ui.canEnter(0), false);
  f.ui.expand(0); assert.equal(f.ui.canEnter(0), true);
  assertProjection(first, column(0, 400), 'Expansion');
  assert.equal(firstCard.dataset.expanded, 'true');
  first.querySelector('.overview-enter').focus(); f.ui.expand(1);
  assert.equal(document.activeElement, first.querySelector('.overview-column-label'), 'Collapsing a focused arrow returns focus to its name');
  assert.equal(f.ui.canEnter(0), false); assert.equal(f.ui.canEnter(1), true);
  assert.equal(firstCard.dataset.expanded, 'false');
  assert.equal(second.querySelector('.overview-enter').disabled, false);
  for (const anchor of [first, second]) {
    const card = anchor.querySelector('.overview-column');
    assert.ok(!animations.some(a => (a.element === anchor || a.element === card) &&
      a.frames.some(frame => 'transform' in frame)), 'Labels use pure opacity transitions, never another positional transform');
  }
  await advance(500);
  update(f, [column(0, leftAt(3.9)), column(1, 700)]);
  assert.equal(first.inert, true, 'A retiring label cannot be activated');
  await advance(80); update(f, [column(0, 405), column(1, 700)]);
  assert.equal(byLane(f, 0), first, 'A reversal preserves the outgoing node until its original exit completes');
  assert.equal(firstCard.dataset.transition, 'closing'); assert.equal(first.inert, true);
  assertProjection(first, column(0, 405));
  await advance(161); assert.equal(byLane(f, 0), undefined, 'Safe reversal cannot restart a half-faded lifetime');
  update(f, [column(0, 405), column(1, 700)]); await advance(500);
  assert.notEqual(byLane(f, 0), first, 'After a completed exit the same physical projection may enter with a new lifetime');
  assertProjection(byLane(f, 0), column(0, 405));
  f.ui.setActive(false, false);
  assert.equal(f.surface.hidden, false, 'Overview remains mounted throughout its fade');
  await advance(60); f.ui.setActive(true, false); update(f, [column(0, 415)]); await advance(600);
  assert.equal(f.surface.hidden, false, 'An interrupted surface exit cannot hide a reopened overview');
  assert.equal(byLane(f, 0), undefined, 'Reopening the surface does not restart an already closing name');
  update(f, [column(0, 415)]); await advance(500);
  assertProjection(byLane(f, 0), column(0, 415));
  f.ui.dispose();
}
{
  const f = fixture(); f.ui.setActive(true, false);
  for (const extent of [.04, .3, .5, .98, .995]) {
    update(f, [{ ...column(0, 400), extent }]); await advance(500);
    assert.equal(f.container.children.length, 0, 'A partly unfolded outer column must not mount an independent name');
  }
  update(f, [{ ...column(0, 400), extent: 1 }]); await advance(500);
  const anchor = byLane(f, 0);
  update(f, [{ ...column(0, 420), extent: .99 }]);
  assert.equal(byLane(f, 0), anchor, 'A nearly full retained occurrence uses extent hysteresis');
  assert.equal(anchor.style.opacity, '1', 'Retained names remain opaque independently of physical extent');
  update(f, [{ ...column(0, 430), extent: .98 }]);
  assert.equal(anchor.inert, true, 'Extent retirement disables the name immediately');
  await advance(250); assert.equal(byLane(f, 0), undefined, 'Extent retirement has a finite lifetime');
  update(f, [{ ...column(0, 440), extent: 1 }]); await advance(500);
  update(f, [{ ...column(0, 440), extent: 0 }]);
  assert.equal(f.container.children.length, 0, 'Zero extent immediately disposes the physical occurrence');
  await advance(500); assert.equal(f.container.children.length, 0); f.ui.dispose();
}
{
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400)]); await advance(500);
  const old = byLane(f, 0); f.ui.expand(0);
  update(f, [{ ...column(0, 800), physicalLane: 2 }]);
  const replacement = byLane(f, 0);
  assert.notEqual(replacement, old, 'A repeated logical name must own a new node when its physical copy changes');
  assertProjection(replacement, column(0, 800));
  assert.equal(old.style.left, '400.00px', 'The old occurrence is never moved to its replacement');
  assert.equal(f.ui.canEnter(0), false, 'A replacement cannot inherit an expanded entry for the retired occurrence');
  update(f, [column(0, 420)]); const reversed = byLane(f, 0);
  assert.notEqual(reversed, replacement); await advance(600);
  assert.equal(byLane(f, 0), reversed, 'Stale callbacks cannot remove the latest physical occurrence');
  update(f, [{ ...column(0, -400), physicalLane: 2 }]);
  assert.equal(f.container.children.length, 0, 'An offscreen replacement removes the previous physical occurrence immediately');
  await advance(40); update(f, [{ ...column(0, 430), physicalLane: 2 }]);
  assert.equal(f.container.children.length, 1); assertProjection(byLane(f, 0), column(0, 430));
  update(f, []); assert.equal(f.container.children.length, 0, 'A missing projection leaves no pinned ghost');
  update(f, [{ ...column(0, 440), physicalLane: 2 }]); await advance(600);
  assert.equal(f.container.children.length, 1); f.ui.dispose();
}
{
  setMusicMotionSpeed(.25);
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400)]);
  await advance(2000); f.ui.setActive(false, false); await advance(600);
  assert.equal(f.surface.hidden, false, 'Slow exits must follow their animation rather than a wall-clock timeout');
  assert.equal(f.container.children.length, 1);
  setMusicMotionSpeed(3); await advance(100);
  assert.equal(f.surface.hidden, true); assert.equal(f.container.children.length, 0);
  f.ui.setActive(true, true); update(f, [column(0, 400)], true);
  assert.equal(f.container.children.length, 1); f.ui.setActive(false, true);
  assert.equal(f.surface.hidden, true); assert.equal(f.container.children.length, 0);
  f.ui.dispose(); setMusicMotionSpeed(1);
}
{
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400)]);
  f.ui.finish(); await flush(); assert.equal(byLane(f, 0).querySelector('.overview-column').dataset.transition, 'open');
  f.ui.setActive(false, false); f.ui.finish(); await flush();
  assert.equal(f.surface.hidden, true); assert.equal(f.container.children.length, 0);
  f.ui.setActive(true, false); update(f, [column(0, 500)]);
  const mounted = [...f.container.children], pending = animations.filter(a => a.playState === 'running');
  f.ui.dispose(); assert.ok(pending.every(a => a.playState === 'idle'), 'Disposal cancels owned animations');
  for (const animation of pending) animation.finish(); await advance(500);
  assert.deepEqual(f.container.children, mounted, 'Disposed completion callbacks cannot mutate the old container');
}

// Fixed metrics and binary safety use the future entry and the narrow stem.
assert.deepEqual(overviewLabelMetrics(1280), { width: 144, height: 46, entry: 32, stem: 18 });
assert.deepEqual(overviewLabelMetrics(430), { width: 104, height: 42, entry: 32, stem: 18 });
// Geometry reservations must describe the actual CSS card, expanded arrow
// and leader. Shrinking padding must not silently shrink name/meta fonts.
{
  const css = await readFile(new URL('../src/music-overview.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/\.overview-anchor\s*\{([^}]+)\}/g)]
    .map(match => match[1]).filter(body => body.includes('--overview-label-width'));
  assert.equal(rules.length, 2, 'Desktop and mobile each declare fixed name metrics');
  const value = (rule, property) => Number(rule.match(new RegExp(`${property}:\\s*(\\d+)px`))?.[1]);
  const stem = Number(css.match(/\.overview-column::after\s*\{[^}]*height:\s*(\d+)px/)?.[1]);
  const entry = value(rules[0], '--overview-entry-width');
  for (const [index, width] of [[0, 600], [1, 599]]) assert.deepEqual(overviewLabelMetrics(width), {
    width: value(rules[index], '--overview-label-width'), height: value(rules[index], '--overview-label-height'), entry, stem,
  }, 'Physical culling dimensions match the exact CSS breakpoint and painted geometry');
  assert.match(css, /@media\s*\(max-width:\s*599px\)/);
  const fontSizes = [...css.matchAll(/\.overview-column strong\s*\{[^}]*font-size:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.deepEqual(fontSizes, [12, 11], 'Compact geometry preserves readable desktop and mobile name fonts');
  assert.match(css, /\.overview-column small\s*\{[^}]*font-size:\s*9px/);
}
for (const [width, height] of [[280, 640], [320, 568], [393, 852], [430, 932], [1280, 720], [1863, 782], [3840, 1080]]) {
  const metrics = overviewLabelMetrics(width), bounds = { top: 115, bottom: height - 112 };
  const center = column(0, (width - metrics.entry) / 2, (bounds.top + metrics.height + bounds.bottom - metrics.stem) / 2);
  assert.equal(overviewLabelOpacity(center, width, height, bounds), 1, 'A comfortably contained card is fully opaque');
  const edges = [
    d => ({ ...center, x: metrics.width / 2 + 12 + d }),
    d => ({ ...center, x: width - 12 - metrics.width / 2 - metrics.entry - d }),
    d => ({ ...center, y: bounds.top + metrics.height + d }),
    d => ({ ...center, y: bounds.bottom - metrics.stem - d }),
  ];
  for (const atEdge of edges) {
    assert.equal(overviewLabelOpacity(atEdge(-1), width, height, bounds), 0, 'A clipped card is already transparent');
    assert.equal(overviewLabelOpacity(atEdge(0), width, height, bounds), 0, 'Fading finishes at the complete footprint boundary');
    for (const distance of [1, 4, 4.001, 8, 8.001, 12, 24]) {
      const candidate = atEdge(distance);
      assert.ok(Math.abs(overviewBoundaryClearance(candidate, width, height, bounds) - distance) < 1e-8,
        'Boundary clearance exposes the true complete-geometry distance');
      assert.equal(overviewLabelOpacity(candidate, width, height, bounds), 1,
        'Safe geometry cannot impose a stable translucent name');
      assert.equal(visibleOverviewLabels([candidate], width, height, new Set(), null, bounds).length,
        Number(distance > 8), 'New names require 8 px of inward clearance');
      assert.equal(visibleOverviewLabels([candidate], width, height, new Set([0]), null, bounds).length,
        Number(distance > 4), 'Retained names use the 4 px exit threshold');
    }
    assert.equal(visibleOverviewLabels([atEdge(-1)], width, height, new Set([0]), 0, bounds).length, 0,
      'Retention and expansion cannot keep an out-of-bounds full footprint visible');
  }
  const input = [center, column(1, 8, center.y), column(2, width - 8, center.y), column(3, center.x, 100),
    column(4, center.x, height - 50), { ...column(5, center.x), x: NaN }];
  const original = structuredClone(input);
  const accepted = visibleOverviewLabels(input, width, height, new Set(), null, bounds);
  assertSelectionGeometry(input, accepted, width, height, bounds);
  assert.deepEqual(input, original, 'Selection does not mutate caller-owned projections');
  assert.equal(accepted.length, 1, 'The safe center stays reachable while invalid or clipped labels disappear');
}
{
  const crowded = [{ ...column(0, 400), selected: false }, column(1, 580)], retained = new Set([1]);
  const accepted = visibleOverviewLabels(crowded, 1280, 720, retained);
  assert.deepEqual(accepted.map(item => item.lane), [1], 'A retained occurrence stays stable when an unselected neighbour competes');
  const selected = visibleOverviewLabels([{ ...crowded[0], selected: true }, crowded[1]], 1280, 720, retained);
  assert.deepEqual(selected.map(item => item.lane), [0], 'An explicit selection remains reachable even when its neighbour was retained');
  const expanded = visibleOverviewLabels(crowded, 1280, 720, retained, 0);
  assert.deepEqual(expanded.map(item => item.lane), [0], 'An explicitly expanded entry keeps priority');
  assertSelectionGeometry(crowded, accepted, 1280, 720);
  assertSelectionGeometry(crowded, expanded, 1280, 720);
  const safe = [column(0, 400), column(1, 650)];
  assert.deepEqual(visibleOverviewLabels(safe, 1280, 720), visibleOverviewLabels(safe, 1280, 720, new Set(), 0),
    'Expanding an already reserved entry never changes otherwise safe geometry');
}
// Proximity changes membership and finite lifetime, never the row or stable alpha.
for (const width of [430, 1280]) {
  const metrics = overviewLabelMetrics(width), source = column(0, width / 3);
  for (const gap of [-1, 0, 1, 8, 8.001, 10, 10.001, 12, 16]) {
    const other = column(1, source.x + metrics.width + metrics.entry + gap);
    const alpha = overviewCollisionOpacity(source, other, width);
    assert.ok(alpha === 0 || alpha === 1, 'Collision safety returns binary visibility');
    if (gap < 0) assert.equal(alpha, 0, 'Intersecting names are hard-unsafe');
    if (gap > 0) assert.equal(alpha, 1, 'A separated name has no static proximity dimming');
  }
}
{
  const f = fixture(); f.ui.setActive(true, false);
  update(f, [column(0, 350), column(1, 600)]); await advance(500);
  const a = byLane(f, 0), b = byLane(f, 1);
  const nearing = [column(0, 350), column(1, nextAt(350, 12))];
  update(f, nearing); await advance(500);
  assert.equal(b.style.opacity, '1', 'The old 12 px collision fade-band fixture remains fully readable');
  assert.equal(a.style.opacity, '1');
  assertProjection(a, nearing[0]); assertProjection(b, nearing[1]);
  f.ui.setActive(false, false); update(f, nearing);
  update(f, [column(0, 350), column(1, 500)]);
  assert.equal(byLane(f, 1), undefined, 'Hard intersection immediately removes the outgoing name');
  await advance(500); assert.equal(f.container.children.length, 0); f.ui.dispose();
}
{
  const f = fixture(); f.ui.setActive(true, false);
  update(f, [column(0, 400), column(1, 650)]); await advance(500);
  const a = byLane(f, 0);
  update(f, [column(0, 400), column(1, nextAt(400, 8))]);
  const retiring = byLane(f, 1);
  assert.ok(retiring.inert, 'At 8 px clearance the retiring name immediately loses interaction');
  for (let frame = 0; frame < 16; frame++) {
    update(f, [column(0, 400), column(1, nextAt(400, 8) + (frame % 2 ? .001 : -.001))]);
    const current = byLane(f, 1);
    if (current) assert.equal(current.inert, true, '8/10 px hysteresis prevents subpixel exit/re-entry chatter');
    assert.equal(byLane(f, 0), a); assertProjection(a, column(0, 400));
    await advance(20);
  }
  assert.equal(byLane(f, 1), undefined, 'The culled lifetime releases its node');
  update(f, [column(0, 400), column(1, 650)]); await advance(500);
  assert.ok(byLane(f, 1) && !byLane(f, 1).inert, 'A safely separated column becomes reachable again');
  update(f, [column(0, 400), column(1, nextAt(400, -6))]);
  assert.equal(byLane(f, 1), undefined, 'Hard overlap is removed within the same update');
  await advance(1000); update(f, [column(0, 400), column(1, nextAt(400, -6))]);
  assert.equal(byLane(f, 1), undefined, 'An old animation cannot resurrect an unsafe name');
  assert.equal(byLane(f, 0), a, 'A neighbour retirement/re-entry never recreates the survivor');
  f.ui.dispose();
}
// Removing an unsafe outgoing leader must release its collision reservation
// in the same frame, while the safe follower completes its original finite exit.
{
  const f = fixture(); f.ui.setActive(true, false);
  update(f, [column(0, 400), column(1, 650)]); await advance(500);
  const follower = byLane(f, 1), card = follower.querySelector('.overview-column');
  update(f, [{ ...column(0, 400), extent: .97 }, { ...column(1, 650), extent: .97 }]);
  assert.equal(card.dataset.transition, 'closing'); await advance(80);
  update(f, [{ ...column(0, 80), extent: .97 }, { ...column(1, 250), extent: .97 }]);
  assert.equal(byLane(f, 0), undefined, 'The hard-unsafe outgoing leader disappears immediately');
  assert.equal(byLane(f, 1), follower, 'An already removed leader cannot hard-cull a safe outgoing follower');
  assert.equal(card.dataset.transition, 'closing'); assert.equal(follower.inert, true);
  assert.equal(follower.style.opacity, '1', 'The safe follower keeps its ordinary card fade, not a stale geometry cap');
  assertProjection(follower, column(1, 250), 'Outgoing reservation release');
  await advance(159); assert.equal(byLane(f, 1), follower, 'The safe follower keeps the remainder of its original 240 ms exit');
  await advance(2); assert.equal(byLane(f, 1), undefined, 'The original deadline removes the follower without restart');
  f.ui.dispose();
}
// A corner heading is a local obstacle, not an exclusion strip across the screen.
{
  const bounds = { top: 20, bottom: 680,
    obstacles: [{ left: 195, right: 280, top: 140, bottom: 220 }] };
  const alongside = column(0, 800, 200);
  assert.equal(overviewLabelOpacity(alongside, 1280, 720, bounds), 1,
    'A label beside the heading can use the same vertical range');
  assert.deepEqual(visibleOverviewLabels([alongside], 1280, 720, new Set(), null, bounds), [alongside]);
  assert.equal(overviewLabelOpacity(column(0, 230, 200), 1280, 720, bounds), 0,
    'The actual heading rectangle excludes an intersecting card');
  assert.equal(overviewLabelOpacity(column(0, 100, 200), 1280, 720, bounds), 0,
    'The future arrow cannot expand into the heading');
  assert.equal(overviewLabelOpacity(column(0, 230, 130), 1280, 720, bounds), 0,
    'A narrow leader also participates in the local heading collision');
  const f = fixture(); f.ui.setActive(true, false);
  Object.assign(f.chrome[0], { offsetLeft: 33, offsetTop: 140, offsetWidth: 230, offsetHeight: 80 });
  update(f, [alongside]); await advance(500);
  const anchor = byLane(f, 0);
  assert.ok(anchor, 'The UI forwards the heading as a local rectangle rather than a full-width top bound');
  assertProjection(anchor, alongside);
  update(f, [column(0, 200, 200)]);
  assert.equal(byLane(f, 0), undefined, 'A name intersecting the heading is removed immediately');
  update(f, [alongside]); await advance(500);
  assert.notEqual(byLane(f, 0), anchor, 'A safely returning projection creates a fresh node after hard disposal');
  assertProjection(byLane(f, 0), alongside);
  f.ui.dispose();
}
{
  const f = fixture(); f.ui.setActive(true, false);
  update(f, [column(0, 140), column(1, 400)]); await advance(500);
  const follower = byLane(f, 1);
  update(f, [column(0, leftAt(4.1)), column(1, 400)]);
  assert.equal(byLane(f, 0).style.opacity, '1', 'A retained soft-edge name stays readable until its timed exit');
  update(f, [column(0, leftAt(3.9)), column(1, 400)]);
  assert.equal(byLane(f, 0).inert, true);
  assert.equal(follower.style.opacity, '1', 'A neighbour exit cannot dim or brighten a surviving name');
  await advance(250); assert.equal(byLane(f, 0), undefined);
  update(f, [column(1, 50)]);
  assert.equal(byLane(f, 1), undefined, 'A hard boundary crossing leaves no painted outgoing node');
  await advance(500); assert.equal(f.container.children.length, 0); f.ui.dispose();
}
// The recording's ordinary diagonal spacing must retain its labels. A
// 196×79 bounding box wrongly treats each 1 px leader as a full-width card.
{
  const diagonal = Array.from({ length: 6 }, (_, lane) => column(lane, 180 + lane * 201, 600 - lane * 72));
  const bounds = { top: 100, bottom: 700 };
  const labels = visibleOverviewLabels(diagonal, 1600, 800, new Set(), null, bounds);
  assert.equal(labels.length, diagonal.length,
    'Normal 201×72 diagonal column spacing retains every safely separated artist name');
  assertSelectionGeometry(diagonal, labels, 1600, 800, bounds);
  for (let i = 0; i < labels.length - 1; i++) {
    assert.equal(overviewCollisionOpacity(labels[i], labels[i + 1], 1600), 1,
      'Ordinary diagonal spacing is legible rather than nominally mounted at nearly zero opacity');
  }
}
// Recorded regression: 0.02 px of horizontal motion previously caused a 52.46 px Y target jump.
for (const separation of [160.87, 160.89, 161.29, 161.30, 195.99, 196.01, 205.99, 206.01]) {
  const input = [column(0, 500), column(1, 500 + separation)];
  const labels = visibleOverviewLabels(input, 1280, 720, new Set([0]));
  assertSelectionGeometry(input, labels, 1280, 720);
  assert.equal(labels.find(item => item.lane === 0)?.y, 300, 'A changing collision can alter visibility, never move the retained row');
}
for (const epsilon of [-1e-9, 0, 1e-9, .142, .143]) {
  const xs = [288, 506, 723, 932, 1138, 1340, 1537], ys = [550, 472, 397, 320, 252, 199, 150];
  const input = xs.map((x, lane) => column(lane, x + (lane === 6 ? epsilon : 0), ys[lane]));
  assertSelectionGeometry(input, visibleOverviewLabels(input, 1863, 782, new Set(), null,
    { top: 193, bottom: 675 }), 1863, 782, { top: 193, bottom: 675 });
}

// Drive the same production projection geometry forward and backward, rather
// than assuming a handful of arbitrary rectangles represents real navigation.
{
  const THREE = await import('three');
  const { MUSIC_MODEL, MUSIC_COLUMN_SPACING } = await import(await compiled(new URL('../src/music-model.ts', import.meta.url)));
  const { overviewFraming } = await import(await compiled(new URL('../src/music-overview.ts', import.meta.url)));
  const { musicOverviewColumnExtent } = await import(await compiled(new URL('../src/music-overview-edge.ts', import.meta.url)));
  for (const hz of [30, 60, 120]) for (const [width, height] of [[393, 852], [1280, 720], [1863, 782]]) {
    const framing = overviewFraming(width, height);
    const yaw = THREE.MathUtils.degToRad(framing.yaw), elevation = THREE.MathUtils.degToRad(framing.elevation);
    const aim = new THREE.Vector3((framing.aimColumns ?? 0) * MUSIC_COLUMN_SPACING, -1.8, -1.5);
    const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
    const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(
      2 * Math.atan(framing.span / (2 * framing.distance))), width / height, .1, 500);
    camera.position.copy(aim).addScaledVector(direction, framing.distance);
    camera.lookAt(aim); camera.updateMatrixWorld(true);
    let retained = new Set(), visibleFrames = 0;
    for (let frame = 0; frame <= 8 * hz; frame++) {
      const elapsed = frame / hz, center = 3 + (elapsed <= 4 ? elapsed : 8 - elapsed) / 4;
      const input = Array.from({ length: 9 }, (_, lane) => {
        const extent = musicOverviewColumnExtent(lane, center, 1);
        const point = new THREE.Vector3((lane - center) * MUSIC_COLUMN_SPACING,
          -4.6 + MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2 + (MUSIC_MODEL.height + .65) * extent,
          -2.17).project(camera);
        return { ...column(lane, (point.x + 1) * width / 2, (1 - point.y) * height / 2), extent,
          count: lane * 7 + 1, selected: lane === Math.round(center) };
      });
      const labels = visibleOverviewLabels(input, width, height, retained);
      assertSelectionGeometry(input, labels, width, height);
      if (labels.length) visibleFrames++;
      retained = new Set(labels.map(item => item.lane));
    }
    assert.ok(visibleFrames > hz * 7, `${width}×${height} at ${hz} Hz retains usable projected labels through navigation`);
  }
}
{
  for (const reduced of [false, true]) {
    const f = fixture(); f.ui.setActive(true, reduced);
    const survivor = column(0, 400, 350); update(f, [survivor], reduced); await advance(500);
    const anchor = byLane(f, 0);
    for (let frame = 0; frame < 50; frame++) {
      const physical = { ...survivor, x: 400 + frame * 2.3, y: 350 - frame * .7 };
      const input = [physical, column(1, frame % 2 ? 1 : -1, 350), column(2, 900, 260)];
      update(f, input, reduced);
      assert.equal(byLane(f, 0), anchor, 'An edge candidate cannot recreate an unrelated retained occurrence');
      assertProjection(anchor, physical, `Navigation frame ${frame}, reduced ${reduced}`);
      await advance(1000 / 60);
    }
    f.ui.setActive(false, reduced);
    if (!reduced) {
      const exitProjection = { ...survivor, x: 530, y: 310 };
      update(f, [exitProjection], reduced); assertProjection(anchor, exitProjection, 'Overview exit');
    }
    await advance(500); assert.equal(f.container.children.length, 0); f.ui.dispose();
  }
}
// A continuous slow approach must reserve the whole exit duration. The old
// 4/8 px buffers reached hard-unsafe after 66.7/133.3 ms at 60 px per second.
// Forecast dt is in motion-scaled seconds, while WAAPI progresses in wall time.
for (const hz of [30, 60, 120]) for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  for (const kind of ['boundary', 'collision', 'copyClearance']) {
    const f = fixture(); f.ui.setActive(true, false);
    const at = elapsed => kind === 'boundary'
      ? [column(0, 500), column(1, leftAt(48) - 60 * elapsed)]
      : kind === 'collision' ? [column(0, 400), column(1, nextAt(400, 54) - 60 * elapsed)]
      : [column(0, 400), { ...column(1, 750), copyClearance: .8 - elapsed }];
    f.ui.update(at(0), 1280, 720, 1, false, '歌手', 0); await advance(500 / speed);
    const original = byLane(f, 1), originalCard = original.querySelector('.overview-column');
    const frameMs = 1000 / hz, dt = speed / hz, expectedExitMs = 240 / speed;
    let closingAt = null, removedAt = null, previousAlpha = 1, fadingSamples = 0;
    for (let frame = 0; frame <= Math.ceil(2 / dt); frame++) {
      const time = frame * frameMs, projections = at(frame * dt);
      f.ui.update(projections, 1280, 720, 1, false, '歌手', dt);
      const current = byLane(f, 1);
      if (!current) {
        removedAt = time;
        assert.notEqual(closingAt, null, `${kind}: a continuous approach must start a timed exit before disposal`);
        assert.ok(time + .001 >= closingAt + expectedExitMs,
          `${kind}, ${hz} Hz, speed ${speed}: exit was cut short at ${time - closingAt} ms, expected ${expectedExitMs} ms`);
        break;
      }
      assert.equal(current, original, 'A continuous outgoing occurrence preserves its original node');
      assertProjection(current, projections[1], 'Predicted continuous retirement');
      if (originalCard.dataset.transition === 'closing') {
        if (closingAt === null) closingAt = time;
        const alpha = Number(getComputedStyle(originalCard).opacity);
        assert.equal(current.style.opacity, '1', 'Geometry cannot clip a continuous exit with an abrupt opacity cap');
        assert.ok(alpha <= previousAlpha + 1e-8, 'An outgoing card cannot brighten or restart its fade');
        if (alpha > 0 && alpha < 1) fadingSamples++;
        previousAlpha = alpha;
      }
      await advance(frameMs);
    }
    assert.notEqual(removedAt, null, 'Continuous retirement completes within the bounded navigation fixture');
    assert.ok(removedAt <= closingAt + expectedExitMs + frameMs + .001,
      'Forecasting cannot prolong or repeatedly restart the exit');
    assert.ok(fadingSamples >= 2, 'Retirement includes multiple intermediate painted alpha samples');
    if (kind === 'copyClearance') {
      assert.ok(.8 - (closingAt + expectedExitMs) * speed / 1000 > 0,
        'The full fade deadline precedes physical replacement even when the next sampled frame reaches the boundary');
      f.ui.update([column(0, 400), { ...column(1, 750), physicalLane: 3, copyClearance: .8 }],
        1280, 720, 1, false, '歌手', dt);
      for (let frame = 0; frame <= Math.ceil(.12 / dt); frame++) {
        await advance(frameMs);
        f.ui.update([column(0, 400), { ...column(1, 750), physicalLane: 3, copyClearance: .8 }],
          1280, 720, 1, false, '歌手', dt);
      }
      assert.ok(byLane(f, 1), 'The replacement uses its fresh margin and enters after sustained safety confirmation');
      assert.notEqual(byLane(f, 1), original);
      await advance(500 / speed);
      assert.equal(byLane(f, 1).querySelector('.overview-column').dataset.transition, 'open');
    }
    f.ui.dispose();
  }
  // A new card is not entitled to erase an already fading physical neighbour.
  const f = fixture(); f.ui.setActive(true, false);
  const initial = [column(0, 400), column(1, 950), { ...column(2, 450), extent: .5 }];
  f.ui.update(initial, 1280, 720, 1, false, '歌手', 0); await advance(500 / speed);
  const old = byLane(f, 0), oldCard = old.querySelector('.overview-column');
  const closing = [{ ...initial[0], extent: .97 }, initial[1], initial[2]];
  f.ui.update(closing, 1280, 720, 1, false, '歌手', 0); await advance(80 / speed);
  const entering = [closing[0], closing[1], { ...closing[2], extent: 1 }];
  f.ui.update(entering, 1280, 720, 1, false, '歌手', 0);
  assert.equal(byLane(f, 0), old, 'A new candidate cannot cancel a retiring card after only 80 ms');
  assert.equal(oldCard.dataset.transition, 'closing'); assert.equal(old.inert, true);
  assert.equal(byLane(f, 2), undefined, 'The newcomer waits for the retiring footprint to become free');
  await advance(159 / speed);
  f.ui.update(entering, 1280, 720, 1, false, '歌手', 0);
  assert.equal(byLane(f, 0), old, 'The outgoing node remains until its full deadline');
  assert.equal(byLane(f, 2), undefined, 'The newcomer cannot steal the last frame of an exit');
  await advance(2 / speed);
  f.ui.update(entering, 1280, 720, 1, false, '歌手', 0);
  assert.equal(byLane(f, 0), undefined);
  assert.ok(byLane(f, 2), 'A safe candidate enters immediately after the old lifetime finishes');
  await advance(500 / speed);
  assert.equal(byLane(f, 2).querySelector('.overview-column').dataset.transition, 'open');
  assert.equal(byLane(f, 2).style.opacity, '1');
  f.ui.dispose();
}
setMusicMotionSpeed(1);

// A stopped/reversed velocity estimate cannot reopen the same half-faded
// card. It must finish once, then a safe projection can start a fresh lifetime.
for (const hz of [30, 60, 120]) for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const f = fixture(); f.ui.setActive(true, false);
  const dt = speed / hz, frameMs = 1000 / hz;
  const at = x => [column(0, 500), column(1, x)];
  f.ui.update(at(leftAt(29.5) + 60 * dt), 1280, 720, 1, false, '歌手', 0); await advance(500 / speed);
  const outgoing = byLane(f, 1), card = outgoing.querySelector('.overview-column');
  f.ui.update(at(leftAt(29.5)), 1280, 720, 1, false, '歌手', dt);
  assert.equal(card.dataset.transition, 'closing', 'An approaching boundary starts a predictive exit while geometry remains safe');
  let previousAlpha = 1, replacement, returningX;
  for (let frame = 1; frame <= Math.ceil(.24 / dt) + 1; frame++) {
    await advance(frameMs);
    const elapsed = frame * dt, x = leftAt(29.5) + Math.max(0, elapsed - .08) * 12;
    f.ui.update(at(x), 1280, 720, 1, false, '歌手', dt);
    const current = byLane(f, 1);
    if (elapsed < .24 - 1e-9) {
      assert.equal(current, outgoing, 'Withdrawing the forecast preserves the outgoing node until its deadline');
      assert.equal(card.dataset.transition, 'closing'); assert.equal(outgoing.inert, true);
      const alpha = Number(getComputedStyle(card).opacity);
      assert.ok(alpha <= previousAlpha + 1e-8, 'Stopping or reversing cannot brighten the outgoing card');
      previousAlpha = alpha;
      assertProjection(outgoing, column(1, x));
    } else {
      assert.equal(card.dataset.transition, 'closed');
      assert.notEqual(current, outgoing, 'A completed outgoing lifetime cannot be reopened');
      returningX = x; break;
    }
  }
  for (let frame = 0; frame <= Math.ceil(.12 / dt); frame++) {
    await advance(frameMs);
    f.ui.update(at(returningX), 1280, 720, 1, false, '歌手', dt);
  }
  replacement = byLane(f, 1);
  assert.ok(replacement && replacement !== outgoing, 'A returning name enters after completing exit and fresh safety confirmation');
  const shows = animations.filter(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 1);
  const exits = animations.filter(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 0);
  assert.equal(shows.length, 1, 'The retired card never starts another entrance');
  assert.equal(exits.length, 1, 'Forecast updates never restart its exit timer');
  await advance(500 / speed);
  assert.equal(replacement.querySelector('.overview-column').dataset.transition, 'open');
  f.ui.dispose();
}
setMusicMotionSpeed(1);

// A card already only 14 px from the top rail can accelerate from rest faster
// than a fresh 240 ms exit. Finish its existing WAAPI progress instead of using
// hard disposal at contact; the steady-motion tests above still require 240 ms.
for (const hz of [30, 60, 120]) for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  for (const kind of ['critical-start', 'critical-reverse', ...(speed === 1 ? ['fast-start'] : [])]) {
    const f = fixture(); f.ui.setActive(true, false);
    const criticalY = t => topAt(14) - 76 * (1 - (1 + 3.7 * t) * Math.exp(-3.7 * t));
    const at = t => [column(0, 400, 350), column(1, 800,
      kind === 'fast-start' ? topAt(14) - 120 * t :
        kind === 'critical-reverse' && t > .12 ? criticalY(.12) + 30 * (t - .12) : criticalY(t))];
    const dt = speed / hz, frameMs = 1000 / hz;
    f.ui.update(at(0), 1280, 720, 1, false, '歌手', 0); await advance(500 / speed);
    const original = byLane(f, 1), card = original.querySelector('.overview-column');
    let exit, complete = false, partialSamples = 0, previousAlpha = 1, wasAccelerated = false;
    for (let frame = 1; frame <= Math.ceil(1 / dt); frame++) {
      await advance(frameMs);
      const input = at(frame * dt);
      const beforeTime = exit?.currentTime;
      f.ui.update(input, 1280, 720, 1, false, '歌手', dt);
      exit ??= animations.findLast(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 0);
      if (exit && beforeTime !== undefined && !exit.completed)
        assert.equal(exit.currentTime, beforeTime, 'Deadline updates change playback rate without jumping currentTime or alpha');
      if (!f.container.children.includes(original)) {
        assert.ok(exit?.completed, `${kind}, ${hz} Hz, speed=${speed}: the existing fade must reach its end before node removal`);
        assert.equal(exit.currentTime, exit.options.duration, 'Removal follows complete WAAPI progress, not a cancelled remainder');
        complete = true; break;
      }
      assertProjection(original, input[1], 'Accelerating near-edge exit');
      assert.equal(original.style.opacity, '1', 'A deadline cannot replace the fade with a geometry opacity jump');
      assert.ok(overviewBoundaryClearance(input[1], 1280, 720) > 0, 'A painted name stays inside its full safe footprint');
      if (card.dataset.transition === 'closing') {
        const alpha = Number(getComputedStyle(card).opacity);
        assert.ok(alpha <= previousAlpha + 1e-8, 'Acceleration or reversal cannot brighten a closing card');
        if (alpha > 0 && alpha < 1) partialSamples++;
        previousAlpha = alpha;
        wasAccelerated ||= exit.playbackRate > speed + 1e-8;
      }
    }
    assert.ok(complete, 'A near-edge exit finishes within the finite trajectory');
    assert.ok(partialSamples >= 1, 'The fade paints intermediate opacity between its full and zero endpoints');
    if (kind !== 'critical-reverse') assert.ok(wasAccelerated, 'An insufficient contact deadline speeds the current fade');
    assert.equal(animations.filter(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 0).length, 1,
      'Acceleration and direction reversal cannot create a replacement exit animation');
    assert.equal(animations.filter(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 1).length, 1,
      'The outgoing card cannot restart entrance while its forecast changes');
    f.ui.dispose();
  }
}
setMusicMotionSpeed(1);
// The shared transition preserves its accelerated rate multiplier when the
// user changes global motion speed; a later loose deadline cannot slow it back.
{
  const root = new Element(), transition = new SurfaceTransition(root, undefined, 460, 240);
  let completed = 0;
  transition.hide(false, () => completed++);
  const fade = animations.findLast(animation => animation.element === root);
  await advance(80);
  const alpha = getComputedStyle(root).opacity, time = fade.currentTime;
  transition.finishWithin(60);
  assert.equal(fade.currentTime, time); assert.equal(getComputedStyle(root).opacity, alpha);
  assert.ok(Math.abs(fade.playbackRate - 160 / 60) < 1e-10);
  setMusicMotionSpeed(.5); assert.ok(Math.abs(fade.playbackRate - .5 * 160 / 60) < 1e-10);
  await advance(30); assert.ok(Math.abs(fade.currentTime - 120) < 1e-8);
  transition.finishWithin(200); assert.ok(Math.abs(fade.playbackRate - .5 * 160 / 60) < 1e-10,
    'A receding obstacle cannot prolong a previously accelerated exit');
  setMusicMotionSpeed(3); assert.ok(Math.abs(fade.playbackRate - 8) < 1e-10);
  await advance(14.99); assert.equal(completed, 0);
  await advance(.02); assert.equal(completed, 1); assert.equal(fade.completed, true); assert.equal(root.hidden, true);
  assert.equal(animations.filter(animation => animation.element === root).length, 1);
  transition.dispose(); setMusicMotionSpeed(1);
}

// Global overview close must not restart an already accelerated name exit.
// Reduced close remains the explicit immediate-completion path.
{
  const f = fixture(); f.ui.setActive(true, false);
  update(f, [column(0, 400), column(1, 750)]); await advance(500);
  const outgoing = byLane(f, 1), card = outgoing.querySelector('.overview-column');
  update(f, [column(0, 400), { ...column(1, 750), extent: .97 }]);
  f.ui.labels.get(1).transition.finishWithin(90);
  const fade = animations.findLast(animation => animation.element === card);
  await advance(60);
  assert.ok(Math.abs((fade.options.duration - fade.currentTime) / fade.playbackRate - 30) < 1e-8);
  const time = fade.currentTime, rate = fade.playbackRate;
  f.ui.setActive(false, false);
  assert.equal(animations.findLast(animation => animation.element === card), fade,
    'Global close preserves the existing accelerated WAAPI object');
  assert.equal(fade.currentTime, time); assert.equal(fade.playbackRate, rate);
  assert.equal(card.dataset.transition, 'closing');
  assert.equal(animations.filter(animation => animation.element === card && Number(animation.frames.at(-1).opacity) === 0).length, 1,
    'Global close cannot create another exit or reset its safety deadline');
  await advance(29.99); assert.equal(byLane(f, 1), outgoing);
  await advance(.02); assert.equal(byLane(f, 1), undefined); assert.equal(fade.completed, true);
  f.ui.dispose();

  const immediate = fixture(); immediate.ui.setActive(true, false);
  update(immediate, [column(0, 400), column(1, 750)]); await advance(500);
  update(immediate, [column(0, 400), { ...column(1, 750), extent: .97 }]);
  assert.equal(byLane(immediate, 1).querySelector('.overview-column').dataset.transition, 'closing');
  immediate.ui.setActive(false, true);
  assert.equal(immediate.container.children.length, 0, 'Reduced global close may complete all current exits immediately');
  assert.equal(immediate.surface.hidden, true); immediate.ui.dispose();
}

// Moving gaps must stay safe for 120 ms on the shared motion clock before a
// new name mounts. Short alternating gaps cannot repeatedly spawn entrance UI.
for (const hz of [30, 60, 120]) for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const f = fixture(); f.ui.setActive(true, false);
  const survivor = column(0, 350), candidate = column(1, 650), dt = speed / hz;
  f.ui.update([survivor], 1280, 720, 1, false, '歌手', 0); await advance(500 / speed);
  const stable = byLane(f, 0), burstFrames = Math.max(1, Math.floor((.1 + 1e-9) / dt));
  for (let burst = 0; burst < 4; burst++) {
    for (let frame = 0; frame < burstFrames; frame++) {
      f.ui.update([survivor, candidate], 1280, 720, 1, false, '歌手', dt);
      assert.equal(byLane(f, 1), undefined, 'A safe window shorter than 120 ms cannot mount a new name');
      assert.equal(byLane(f, 0), stable, 'An already readable name is not delayed by a neighbour waiting');
      await advance(1000 / hz);
    }
    f.ui.update([survivor, { ...candidate, extent: .5 }], 1280, 720, 1, false, '歌手', dt);
    await advance(1000 / hz);
  }
  let mountedAt = null;
  for (let frame = 1; frame <= Math.ceil(.12 / dt) + 1; frame++) {
    f.ui.update([survivor, candidate], 1280, 720, 1, false, '歌手', dt);
    const elapsed = frame * dt;
    if (elapsed < .12 - 1e-9) assert.equal(byLane(f, 1), undefined, 'Interrupted gaps do not accumulate safety credit');
    if (byLane(f, 1)) { mountedAt = elapsed; break; }
    await advance(1000 / hz);
  }
  assert.ok(mountedAt !== null && mountedAt >= .12 - 1e-9 && mountedAt <= .12 + dt + 1e-9,
    'A continuously safe candidate enters promptly after its 120 ms confirmation');
  const entered = byLane(f, 1);
  for (let frame = 0; frame < 10; frame++) {
    f.ui.update([survivor, candidate], 1280, 720, 1, false, '歌手', dt);
    assert.equal(byLane(f, 1), entered, 'A confirmed name is not sent through the waiting period again');
    await advance(1000 / hz);
  }
  await advance(500 / speed);
  assert.equal(entered.querySelector('.overview-column').dataset.transition, 'open');
  assert.equal(entered.style.opacity, '1'); f.ui.dispose();
}
setMusicMotionSpeed(1);
{
  const f = fixture(); f.ui.setActive(true, false);
  const base = column(0, 350), candidate = column(1, 650), dt = 1 / 60;
  f.ui.update([base], 1280, 720, 1, false, '歌手', 0);
  for (let frame = 0; frame < 6; frame++) f.ui.update([base, candidate], 1280, 720, 1, false, '歌手', dt);
  assert.equal(byLane(f, 1), undefined);
  const replacement = { ...candidate, physicalLane: 3 };
  for (let frame = 0; frame < 6; frame++) {
    f.ui.update([base, replacement], 1280, 720, 1, false, '歌手', dt);
    assert.equal(byLane(f, 1), undefined, 'A new physical copy cannot inherit partial confirmation from a previous copy');
  }
  for (let frame = 0; frame < 2; frame++) f.ui.update([base, replacement], 1280, 720, 1, false, '歌手', dt);
  assert.ok(byLane(f, 1)); f.ui.dispose();
  for (const reduced of [false, true]) {
    const instant = fixture(); instant.ui.setActive(true, reduced);
    instant.ui.update([base, candidate], 1280, 720, 1, reduced, '歌手', reduced ? dt : 0);
    assert.ok(byLane(instant, 1), 'Static samples and reduced motion keep immediate safe entry');
    instant.ui.dispose();
  }
}

// Regression for the permanently pale far labels. Freeze navigation for ten
// seconds and inspect every interactive name, not only the selected column.
for (const hz of [30, 60, 120]) for (const reduced of [false, true]) for (const speed of [.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  for (const kind of ['extent', 'boundary', 'collision']) {
    const f = fixture(); f.ui.setActive(true, reduced);
    f.ui.update([column(0, 350), column(1, 650)], 1280, 720, 1, reduced, '歌手');
    await advance(500 / speed);
    const stopped = kind === 'extent' ? [column(0, 350), { ...column(1, 650), extent: .5 }]
      : kind === 'boundary' ? [column(0, 350), column(1, leftAt(12))]
      : [column(0, 350), column(1, nextAt(350, 12))];
    for (let frame = 0; frame < hz * 10; frame++) {
      f.ui.update(stopped, 1280, 720, 1, reduced, '歌手');
      await advance(1000 / hz);
    }
    assert.ok(byLane(f, 0), 'A comfortably contained selected name remains reachable');
    assert.ok(!animations.some(animation => animation.playState === 'running' && f.container.contains(animation.element)),
      'Ten seconds after stopping, no name has a perpetual opacity animation');
    for (const anchor of f.container.children) {
      const card = anchor.querySelector('.overview-column'), name = anchor.querySelector('.overview-column-label');
      assert.equal(card.dataset.transition, 'open', 'Stopped navigation cannot leave an unbounded outgoing lifetime');
      assert.equal(anchor.inert, false); assert.equal(name.disabled, false);
      assert.equal(Number(anchor.style.opacity) * Number(getComputedStyle(card).opacity), 1,
        `${kind}, ${hz} Hz, reduced=${reduced}, speed=${speed}: every retained name is fully opaque`);
    }
    if (kind === 'extent') assert.equal(byLane(f, 1), undefined,
      'Half-expanded names are removed rather than parked at low alpha');
    f.ui.dispose();
  }
  // Finite exit deadline follows motion speed; hard safety can finish it early.
  const f = fixture(); f.ui.setActive(true, reduced);
  f.ui.update([column(0, 350), column(1, 650)], 1280, 720, 1, reduced, '歌手');
  await advance(500 / speed);
  f.ui.update([column(0, 350), column(1, leftAt(3.9))], 1280, 720, 1, reduced, '歌手');
  if (!reduced) assert.equal(byLane(f, 1).inert, true, 'Soft-boundary exit immediately disables interaction');
  await advance(reduced ? 0 : 240 / speed + 1000 / hz + 1);
  assert.equal(byLane(f, 1), undefined, 'A completed exit releases its DOM node at every motion speed');
  f.ui.dispose();
}
setMusicMotionSpeed(1);

// Exercise the actual name-click branch and actual selectOverviewColumn. The
// host supplies only scene selection; real pointer hit testing belongs to CUA.
{
  const appSource = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const appAst = ts.createSourceFile('music-app.ts', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selectNode = appAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectOverviewColumn');
  let nameBranch;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(appAst) === 'target.dataset.overviewLane !== undefined') nameBranch = node;
    ts.forEachChild(node, visit);
  };
  visit(appAst);
  assert.ok(selectNode && nameBranch, 'The real app name-click entry points are under test');
  const logic = ts.transpileModule(`${selectNode.getText(appAst)}\nfunction nameClick(target) { ${nameBranch.getText(appAst)} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 350), column(1, 650)]); await advance(500);
  let selected = 0; const calls = [];
  const click = new Function('archiveColumns','records','fileLocation','navigationSelection','resolveColumnSelection','scene','select','overviewUI',
    `${logic}; return nameClick;`)([{},{}],[{},{}], index => ({ lane: index }), () => selected,
      lane => ({ index: lane, row: 12 }), { musicColumnCell: (lane, row) => ({ lane: lane + 4, row }) },
      (index, navigation, navigate) => { selected = index; calls.push({ index, navigation, navigate }); }, f.ui);
  click({ dataset: { overviewLane: '1' } });
  assert.equal(selected, 1, 'Clicking an unselected name chooses its column');
  assert.deepEqual(calls, [{ index: 1, navigation: { cell: { lane: 5, row: 12 }, guided: true }, navigate: false }],
    'The name uses the real physical occurrence and keeps overview open');
  assert.equal(f.ui.canEnter(1), true); assert.equal(f.surface.inert, false); assert.equal(f.surface.hidden, false);
  assert.equal(byLane(f, 1).querySelector('.overview-column-label').attrs['aria-expanded'], 'true');
  assert.equal(byLane(f, 1).querySelector('.overview-enter').disabled, false);
  click({ dataset: { overviewLane: '1' } });
  assert.equal(calls.length, 1, 'Repeated name clicks preserve the pending selection instead of restarting travel');
  click({ dataset: { overviewLane: '99' } });
  assert.equal(calls.length, 1, 'Invalid name identities cannot navigate');
  assert.equal(f.ui.canEnter(1), true); f.ui.dispose();
}
// App lifecycle regression: return-camera acceleration must not begin while
// any real UI name still owns its exit. Execute the production app functions
// with the real UI/WAAPI fixture, and observe only scene command boundaries.
{
  const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['setOverview', 'updateOverview'];
  const methods = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
  assert.ok(methods.every(Boolean), 'The actual app entry and frame update functions must be present');
  const stateNames = ['overview', 'overviewRevealPending', 'overviewCameraExitPending'];
  const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations);
  const state = stateNames.map(name => {
    const declaration = declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
    assert.ok(declaration?.initializer, `Actual app state ${name} must have an initializer`);
    return `let ${name} = ${declaration.initializer.getText(ast)};`;
  }).join('\n');
  const logic = ts.transpileModule(`${state}\n${methods.map(method => method.getText(ast)).join('\n')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  function lifecycle(reduced = false) {
    const f = fixture(), stage = new Element(), browse = new Element(), toggle = new Element('button');
    Object.assign(stage, { clientWidth: 1280, clientHeight: 720 });
    const calls = [], scene = {
      musicOverviewProgress: 0,
      setMusicOverview(active) { calls.push(active); this.musicOverviewProgress = Number(active); },
      getOverviewColumns() { return [column(0, 400), column(1, 750)]; },
    };
    const $ = selector => selector === '#music-overview' ? f.surface : selector === '#music-browse' ? browse : toggle;
    const app = new Function('$', 'stage', 'overviewUI', 'scene', 'preferences', `
      const ready = true, albums = [{}], boot = undefined, panel = null, mode = 'archive';
      const sortLabel = {column: '歌手'}, browseTransition = {hide() {}};
      ${logic}
      return {setOverview, updateOverview, state: () => ({${stateNames.join(',')}})};
    `)($, stage, f.ui, scene, { reduced });
    return { ...f, app, calls, scene };
  }
  for (const speed of [.25, 1, 3]) {
    setMusicMotionSpeed(speed);
    const f = lifecycle();
    assert.equal(f.ui.hasLabels, false);
    f.app.setOverview(true); f.app.updateOverview(0); await advance(500 / speed);
    assert.equal(f.ui.hasLabels, true); f.calls.length = 0;
    f.app.setOverview(false);
    assert.equal(f.app.state().overviewCameraExitPending, true);
    assert.equal(f.ui.hasLabels, true, 'Closing labels still own their screen space');
    assert.deepEqual(f.calls, [], 'Return camera cannot start on the same click that starts name exits');
    await advance(239 / speed); f.app.updateOverview(speed / 60);
    assert.equal(f.ui.hasLabels, true); assert.deepEqual(f.calls, [], 'The final painted exit frame still holds overview framing');
    await advance(2 / speed);
    assert.equal(f.ui.hasLabels, false); assert.equal(f.surface.hidden, true);
    f.app.updateOverview(speed / 60);
    assert.deepEqual(f.calls, [false], 'The first frame after the last label ends starts the return even if the surface is already hidden');
    assert.equal(f.app.state().overviewCameraExitPending, false);
    f.app.updateOverview(speed / 60); assert.deepEqual(f.calls, [false], 'The pending camera return is consumed once');
    f.ui.dispose();

    const reopened = lifecycle();
    reopened.app.setOverview(true); reopened.app.updateOverview(0); await advance(500 / speed);
    reopened.calls.length = 0; reopened.app.setOverview(false); await advance(80 / speed);
    reopened.app.setOverview(true);
    assert.equal(reopened.app.state().overviewCameraExitPending, false, 'Reopen cancels the pending return command');
    assert.deepEqual(reopened.calls, [true]);
    await advance(500 / speed); reopened.app.updateOverview(0);
    assert.deepEqual(reopened.calls, [true], 'An old exit completion cannot pull a reopened overview camera back');
    assert.equal(reopened.scene.musicOverviewProgress, 1); assert.equal(reopened.ui.hasLabels, true);
    reopened.ui.dispose();
  }
  setMusicMotionSpeed(1);
  const reduced = lifecycle(true);
  reduced.app.setOverview(true); reduced.app.updateOverview(0);
  assert.equal(reduced.ui.hasLabels, true); reduced.calls.length = 0;
  reduced.app.setOverview(false);
  assert.equal(reduced.ui.hasLabels, false); assert.deepEqual(reduced.calls, [false], 'Reduced motion ends names and returns the camera immediately');
  assert.equal(reduced.app.state().overviewCameraExitPending, false);
  reduced.app.updateOverview(1 / 60); assert.deepEqual(reduced.calls, [false]); reduced.ui.dispose();
}
console.log('Overview UI: direct projection, fixed complete footprints, binary geometry safety, finite opacity lifetimes and full readability after settling, visibility-only collision selection, physical identities, complete exit lifetimes through forecast reversal and copy handoff, keyboard state, dynamic speed, reduced motion, and 30/60/120 Hz synthetic navigation passed.');
