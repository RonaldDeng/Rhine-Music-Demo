import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Execute the actual settings renderer and navigation handlers. This small DOM
// port checks ownership/lifetime, not layout or browser focus rendering (visual QA).
const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = (name, kind = 'function') => {
  const node = tree.statements.find(node => kind === 'function'
    ? ts.isFunctionDeclaration(node) && node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(tree) === name));
  assert.ok(node, `Production ${kind} ${name} exists`);
  return node.getText(tree);
};
const listener = event => tree.statements.filter(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'document.addEventListener' &&
  node.expression.arguments[0]?.text === event).at(-1).expression.arguments[1].body;
const branch = (event, condition) => {
  const node = listener(event).statements.find(node => ts.isIfStatement(node) && node.expression.getText(tree) === condition);
  assert.ok(node, `Production ${event} branch: ${condition}`);
  return node.getText(tree);
};
const actionSwitch = listener('click').statements.find(node => ts.isSwitchStatement(node));
const actionCase = name => actionSwitch.caseBlock.clauses.find(node => ts.isCaseClause(node) && node.expression.text === name).getText(tree);
const transpile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const transitionSource = await readFile(new URL('../src/ui-transitions.ts', import.meta.url), 'utf8');
const transitionTree = ts.createSourceFile('ui-transitions.ts', transitionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const transitionCode = transitionTree.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(transitionTree).replace(/^export\s+/, '')).join('\n');
const motionSources = await Promise.all(['music-motion-settings.ts', 'music-motion-ui.ts'].map(async name => {
  const contents = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(name, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return parsed.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(parsed).replace(/^export\s+/, '')).join('\n');
}));
const lyricPreferencesSource = await readFile(new URL('../src/music-lyrics-preferences.ts', import.meta.url), 'utf8');
const lyricPreferencesTree = ts.createSourceFile('music-lyrics-preferences.ts', lyricPreferencesSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lyricPreferencesCode = lyricPreferencesTree.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(lyricPreferencesTree).replace(/^export\s+/, '')).join('\n');
const animations = [];
class Animation {
  currentTime = 0; playbackRate = 1; playState = 'running';
  constructor(element, frames, options) {
    Object.assign(this, { element, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {}); animations.push(this);
  }
  updatePlaybackRate(rate) { this.playbackRate = rate; }
  finish() { this.playState = 'finished'; this.currentTime = this.options.duration; this.resolve(); }
  cancel() { if (this.playState !== 'finished') this.reject(new Error('cancelled')); this.playState = 'idle'; }
}
const computedStyle = element => {
  const fade = animations.findLast(animation => animation.element === element && animation.playState === 'running' && 'opacity' in animation.frames[0]);
  const progress = fade ? fade.currentTime / fade.options.duration : 1;
  return { opacity: String(fade ? Number(fade.frames[0].opacity) * (1 - progress) + Number(fade.frames[1].opacity) * progress : 1), transform: 'none' };
};
// Keep the production transitions and global speed subscription. Only WAAPI's
// clock/computed opacity are simulated; browser QA checks actual painted frames.
const { ProductionSurfaceTransition, ProductionContentTransition, setMusicMotionSpeed } = new Function('getComputedStyle',
  `${transpile([...motionSources, transitionCode].join('\n'))}; return {
    ProductionSurfaceTransition: SurfaceTransition, ProductionContentTransition: ContentTransition, setMusicMotionSpeed,
  };`)(computedStyle);
const microtasks = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const finishAnimations = async () => {
  animations.filter(animation => animation.playState === 'running').forEach(animation => animation.finish());
  await microtasks();
};

let document;
class Element {
  children = []; attrs = {}; style = {}; dataset = {}; hidden = false; inert = false; scrollTop = 0; tabIndex = 0; value = ''; writes = 0;
  constructor(tag = 'div') { this.tag = tag; }
  classList = { toggle() {} };
  animate(frames, options) { return new Animation(this, frames, options); }
  append(child) { child.parent = this; this.children.push(child); }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'hidden' || key === 'inert') this[key] = true;
    if (key === 'tabindex') this.tabIndex = Number(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  matches(selector) {
    if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
    if (selector.startsWith('.')) return (this.attrs.class ?? '').split(' ').includes(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return attr ? (attr[2] === undefined ? Object.hasOwn(this.attrs, attr[1]) : this.attrs[attr[1]] === attr[2]) : this.tag === selector;
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    const parts = selector.split(' ');
    return this.descendants().filter(node => {
      if (!node.matches(parts.at(-1))) return false;
      let parent = node.parent;
      for (const part of parts.slice(0, -1).reverse()) {
        while (parent && !parent.matches(part)) parent = parent.parent;
        if (!parent) return false;
        parent = parent.parent;
      }
      return true;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  focus() { document.activeElement = this; }
  get isConnected() { return this === document || !!this.parent?.isConnected; }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
  set innerHTML(markup) {
    this.writes++; this.markup = markup; this.replaceChildren();
    const stack = [this];
    for (const tag of markup.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
      if (tag[0].startsWith('</')) { if (stack.at(-1).tag === tag[1]) stack.pop(); continue; }
      const child = new Element(tag[1]);
      for (const attr of tag[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) child.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).append(child);
      if (!['input', 'br', 'hr', 'img', 'meta', 'link'].includes(child.tag)) stack.push(child);
    }
  }
}
document = new Element('document');
document.innerHTML = '<div id="stage"><div id="music-overview"></div><button data-action="overview"></button><div id="music-browse"></div><div id="music-detail"></div><header class="music-header"></header><div id="three-scene"></div><div id="music-panel-root"></div></div>';
const $ = selector => { const node = document.querySelector(selector); assert.ok(node, `DOM port resolves ${selector}`); return node; };
const calls = { mount: 0, transitions: [], requests: 0, search: 0, deferRequests: false, pendingRequests: [],
  motionCleanup: { trackFocus: 0, tabTransition: 0, lyricsPane: 0, detailView: 0 } };
const code = `
  const { getLyricsPreferences, lyricsFontFamily, LYRICS_FONT_OPTIONS, LYRICS_FONT_SIZE_MIN, LYRICS_FONT_SIZE_MAX } = (() => {
    ${lyricPreferencesCode}
    return { getLyricsPreferences, lyricsFontFamily, LYRICS_FONT_OPTIONS, LYRICS_FONT_SIZE_MIN, LYRICS_FONT_SIZE_MAX };
  })();
  let panel = null, panelClosing = false, pendingPanelAfter, panelFocus, panelTransition, introductionExchange, searchGenre = '';
  ${['settingsPage', 'settingsPageTransition', 'settingsScroll', 'libraryMainScroll'].map(name => declaration(name, 'variable')).join('\n')}
  const preferences = { theme: 'day', volume: 0, songTransition: 'fade-in-out', showSongTransitionControl: true,
    soundVolume: 0, bgmVolume: 0, sortMode: 'artist', arrayMode: 'filled', rememberColumnPosition: true };
  const themeNames = { day: '晨雾', night: '月影' }, sortLabels = { genre: { name: '按流派' }, artist: { name: '按歌手' }, album: { name: '按专辑名' } };
  const appVersion = '0.6.1', renderQuality = {}, apiAvailable = false, demo = true;
  const library = { roots: [], albums: [], genres: [] }, stage = $('#stage');
  const esc = value => value, cancelTrackReveal = () => {}, effects = { play() {} }, notify = () => {};
  const presentation = { phase: 'archive' }, overview = false;
  const transportTitleMotion = { setReduced() {} }, browseTransition = { finish() {} }, detailTransition = { finish() {} }, overviewUI = { finish() {} };
  const detailViewTransition = { finish() { calls.motionCleanup.detailView++; } };
  const trackFocus = { cancel() { calls.motionCleanup.trackFocus++; } };
  const tabTransition = { cancel() { calls.motionCleanup.tabTransition++; } };
  const lyricsPane = { finishMotion() { calls.motionCleanup.lyricsPane++; } };
  const syncSelectionMotion = () => {}, scene = { setReduced() {} }, updateSelection = () => {}, savePrefs = () => {};
  class SurfaceTransition extends ProductionSurfaceTransition {
    constructor(...args) { super(...args); calls.transitions.push(this); }
    dispose() { super.dispose(); this.disposed = true; }
  }
  const audioOutputMarkup = () => '', qualityMarkup = () => '', updateQuality = () => {}, syncAudioOutputUI = () => {}, syncSongTransitionControl = () => {};
  const audioOutputsChecked = true, outputBusy = false;
  const renderMusicBrainzSettings = () => {}, updateScanStatus = () => {}, updateIntroductionStatus = () => {}, updateCreditsStatus = () => {};
  const renderSearchPanel = () => { calls.search++; $('#panel-body').innerHTML = '<input id="album-search">'; };
  const introductionExchangeMarkup = () => '<div id="introduction-ai"><textarea data-intro-result></textarea><div data-intro-changes></div></div>';
  const mountIntroductionExchange = () => { calls.mount++; return { focusSelected() { $('[data-intro-result]').focus(); } }; };
  const request = async () => {
    calls.requests++;
    return calls.deferRequests ? new Promise(resolve => calls.pendingRequests.push(resolve)) : { groups: [] };
  };
  ${['openPanel', 'closePanel', 'renderSettingsPanel', 'renderLibraryPanel', 'libraryArrangementMarkup', 'introductionSectionMarkup', 'creditsSettingsMarkup', 'lyricsSettingsMarkup', 'syncLyricsSettingsUI', 'renderDisplaySettings', 'selectSettingsPage', 'showGenreEditor', 'editGenres'].map(name => declaration(name)).join('\n')}
  function clickTab(page) {
    const target = { dataset: { settingsTab: page } };
    ${branch('click', 'target.dataset.settingsTab === "library" || target.dataset.settingsTab === "display"')}
  }
  function clickAction(action) {
    ${branch('click', '["library", "search", "settings"].includes(action || "")')}
    switch (action) { ${['library-settings-back', 'introduction-ai'].map(actionCase).join('\n')} }
  }
  function key(e) { ${branch('keydown', 'panel')} }
  function reduceMotion(checked) {
    const el = { id: 'reduced-motion', checked };
    ${branch('change', 'el.id === "reduced-motion"')}
  }
  return { openPanel, closePanel, clickTab, clickAction, key, editGenres, reduceMotion,
    state: () => ({ panel, settingsPage, settingsScroll, settingsPageTransition, introductionExchange }) };
`;
const fixture = new Function('document', '$', 'calls', 'ProductionSurfaceTransition', 'ContentTransition', 'localStorage', transpile(code))(
  document, $, calls, ProductionSurfaceTransition, ProductionContentTransition, { getItem: () => null });
const selected = name => {
  assert.equal(document.querySelectorAll('.settings-page').filter(page => !page.hidden).length, 1,
    'Exactly one settings page participates in layout at every sampled instant');
  for (const page of ['library', 'display']) {
    const active = page === name, content = $(`#settings-page-${page}`), tab = $(`#settings-tab-${page}`);
    assert.equal(content.hidden, !active, `${page} is visible only while selected`);
    assert.equal(content.inert, !active, `${page} input eligibility`);
    assert.equal(content.getAttribute('aria-hidden'), String(!active), `${page} accessibility eligibility changes immediately`);
    assert.equal(tab.getAttribute('aria-selected'), String(active));
    assert.equal(tab.tabIndex, active ? 0 : -1, 'Exactly the selected tab is in the tab order');
    assert.equal(tab.getAttribute('aria-controls'), content.getAttribute('id'));
    assert.equal(content.getAttribute('aria-labelledby'), tab.getAttribute('id'));
  }
  assert.equal(fixture.state().settingsPage, name);
};
const runningContentAnimation = () => animations.findLast(animation => animation.element === $('#panel-body') && animation.playState === 'running');
const sampleSwitch = name => {
  const animation = runningContentAnimation();
  assert.ok(animation, 'A real ContentTransition runs on the shared content container');
  for (const time of [0, 1, 16, 48, 96, 160, 240, 320, 359, 360]) {
    animation.currentTime = time;
    selected(name);
  }
  assert.ok(animation.frames.every(frame => Object.keys(frame).every(key => key === 'opacity')),
    'Tab content uses the detail-page opacity reveal without translation or overlapping page animations');
  return animation;
};
fixture.clickAction('settings'); selected('display');
assert.equal(animations.some(animation => animation.element === $('#panel-body')), false, 'First page appears with the dialog, without a second entrance');
await finishAnimations();
assert.equal(fixture.state().panel, 'settings');
assert.equal(calls.mount, 1, 'Library settings initialize once alongside display settings');
const intro = $('#introduction-ai'), draft = $('[data-intro-result]'), preview = $('[data-intro-changes]');
draft.value = '{"albums":[]}'; preview.reviewed = { canApply: true };
const controller = fixture.state().introductionExchange;
const unchanged = () => {
  assert.equal($('#introduction-ai'), intro);
  assert.equal($('[data-intro-result]'), draft);
  assert.equal(draft.value, '{"albums":[]}');
  assert.equal($('[data-intro-changes]'), preview);
  assert.equal(preview.reviewed.canApply, true);
  assert.equal(fixture.state().introductionExchange, controller);
  assert.equal(calls.mount, 1, 'Navigation must not remount the import controller');
  assert.equal(calls.transitions.length, 1, 'In-dialog navigation reuses the dialog controller');
};
$('#settings-page-display').scrollTop = 315;
fixture.clickTab('library'); selected('library'); unchanged();
const libraryPage = $('#settings-page-library'), displayPage = $('#settings-page-display');
assert.equal(displayPage.hidden, true, 'Old text leaves the layout before the new content reveal starts');
const initialContentAnimation = sampleSwitch('library');
assert.deepEqual(initialContentAnimation.frames, [{ opacity: '0.35' }, { opacity: 1 }]);
const detailTabTransition = new Function('ContentTransition', transpile(`${declaration('tabTransition', 'variable')}; return tabTransition;`))(ProductionContentTransition);
const detailContent = new Element();
detailTabTransition.reveal(detailContent, false);
const detailAnimation = animations.at(-1);
assert.deepEqual(initialContentAnimation.options, detailAnimation.options, 'Settings matches the actual detail 01/02 duration and easing');
assert.equal(initialContentAnimation.options.duration, 360);
assert.equal(initialContentAnimation.options.easing, 'cubic-bezier(0.22, 1, 0.36, 1)');
detailTabTransition.cancel();
await finishAnimations(); selected('library');
assert.equal(displayPage.hidden, true);
$('#settings-page-library').scrollTop = 880;
fixture.clickTab('display'); selected('display'); unchanged();
assert.equal($('#settings-page-display').scrollTop, 315);
fixture.clickAction('library'); selected('library'); unchanged();
assert.equal($('#settings-page-library').scrollTop, 880, 'Legacy library route restores its page and scroll');
fixture.clickAction('settings'); selected('library'); unchanged();

for (const [key, expected] of [['ArrowRight', 'display'], ['ArrowLeft', 'library'], ['End', 'display'], ['Home', 'library']]) {
  let prevented = false;
  fixture.key({ key, target: $(`#settings-tab-${fixture.state().settingsPage}`), preventDefault() { prevented = true; } });
  assert.equal(prevented, true); selected(expected); unchanged();
  assert.equal(document.activeElement, $(`#settings-tab-${expected}`), 'Keyboard activation moves focus to its selected tab');
}
await fixture.editGenres();
const editor = $('#genre-json'); editor.value = '{"groups":["unfinished"]}';
assert.equal($('#library-settings-content').hidden, true);
assert.equal($('#library-settings-content').inert, true);
assert.equal($('#genre-editor-panel').hidden, false);
assert.equal(document.activeElement, editor);
assert.equal($('#settings-page-library').scrollTop, 0);
$('#settings-page-library').scrollTop = 75;
fixture.clickTab('display'); fixture.clickTab('library');
assert.equal($('#settings-page-library').scrollTop, 75, 'Editor scroll survives tab switches');
assert.equal($('#genre-json'), editor); assert.equal(editor.value, '{"groups":["unfinished"]}'); unchanged();
fixture.clickAction('library-settings-back');
assert.equal($('#library-settings-content').hidden, false);
assert.equal($('#library-settings-content').inert, false);
assert.equal($('#genre-editor-panel').hidden, true);
assert.equal($('#genre-editor-panel').inert, true);
assert.equal($('#settings-page-library').scrollTop, 880, 'Returning restores library settings scroll');
assert.equal(document.activeElement, $('[data-action="edit-genres"]')); unchanged();
await fixture.editGenres();
assert.equal(calls.requests, 1, 'Reopening keeps an unfinished genre draft without another request');
assert.equal($('#genre-json'), editor);
fixture.clickAction('introduction-ai'); selected('library'); unchanged();
assert.equal($('#genre-editor-panel').hidden, true);
assert.equal($('#introduction-ai-details').open, true);
assert.equal(document.activeElement, draft, 'Album-introduction shortcut reveals the existing editor');
const oldContent = $('#panel-body');
fixture.clickAction('search');
assert.equal(fixture.state().panel, 'search');
assert.equal(calls.search, 1, 'Search/library content remains a separate browsing dialog');
assert.match($('#music-panel-root').markup, /MUSIC LIBRARY/);
assert.match($('#music-panel-root').markup, /音乐库/);
assert.equal(calls.transitions[0].disposed, true, 'Opening search disposes the previous dialog controller');
assert.ok(animations.filter(animation => animation.element === oldContent).every(animation => animation.playState === 'idle'),
  'Opening search cancels every previous settings content animation');
assert.equal(animations.some(animation => animation.element === libraryPage || animation.element === displayPage), false,
  'The individual settings pages never run overlapping surface transitions');

// Rapid switching uses the same ContentTransition as detail 01/02. The old
// page is hidden immediately, while the common container keeps its opacity.
fixture.clickAction('settings'); await finishAnimations();
fixture.clickTab('display'); await finishAnimations();
const pageController = fixture.state().settingsPageTransition;
const firstPage = $('#settings-page-display'), secondPage = $('#settings-page-library');
fixture.clickTab('library');
const interrupted = runningContentAnimation();
interrupted.currentTime = 70;
const interruptedOpacity = computedStyle($('#panel-body')).opacity;
selected('library');
fixture.clickTab('display'); selected('display');
assert.equal(fixture.state().settingsPageTransition, pageController, 'A rapid switch reuses the common content controller');
assert.equal(interrupted.playState, 'idle', 'The previous content animation is cancelled');
assert.equal(runningContentAnimation().frames[0].opacity, interruptedOpacity, 'The new reveal continues at the current container opacity');
const activeAnimation = runningContentAnimation(), beforeRepeatedClick = animations.length;
fixture.clickTab('display'); selected('display');
assert.equal(animations.length, beforeRepeatedClick, 'Clicking the active tab does not restart the reveal');
assert.equal(runningContentAnimation(), activeAnimation);
for (const next of ['library', 'display', 'library', 'display']) {
  const previous = runningContentAnimation();
  previous.currentTime = 23;
  const previousOpacity = computedStyle($('#panel-body')).opacity;
  fixture.clickTab(next); selected(next);
  assert.equal(previous.playState, 'idle');
  assert.equal(runningContentAnimation().frames[0].opacity, previousOpacity, 'Every rapid continuation retains its current opacity');
  sampleSwitch(next);
}
setMusicMotionSpeed(2);
assert.equal(runningContentAnimation().playbackRate, 2, 'An active settings reveal follows live changes to the global animation speed');
fixture.clickTab('library'); selected('library');
assert.equal(runningContentAnimation().playbackRate, 2, 'A newly started reveal uses the current global speed');
assert.equal(runningContentAnimation().options.duration, 360, 'Speed changes do not rewrite the shared base duration');
setMusicMotionSpeed(0.5);
assert.equal(runningContentAnimation().playbackRate, 0.5);
setMusicMotionSpeed(1);
sampleSwitch('library');
fixture.clickTab('display');
await finishAnimations(); selected('display');
assert.equal(firstPage.hidden, false); assert.equal(secondPage.hidden, true);
fixture.clickTab('library');
const reducedAnimation = runningContentAnimation();
reducedAnimation.currentTime = 85;
fixture.reduceMotion(true); await microtasks(); selected('library');
assert.deepEqual(calls.motionCleanup, { trackFocus: 1, tabTransition: 1, lyricsPane: 1, detailView: 1 },
  'Enabling reduced motion cancels track focus, detail tab reveal, and lyric scrolling once');
assert.equal(firstPage.hidden, true, 'Enabling reduced motion keeps only the selected page visible');
assert.equal(reducedAnimation.playState, 'idle', 'Enabling reduced motion cancels an in-flight content animation');
assert.equal(computedStyle($('#panel-body')).opacity, '1', 'Cancellation restores fully opaque text immediately');
assert.equal(runningContentAnimation(), undefined);
const beforeReducedSwitch = animations.length;
fixture.clickTab('display'); selected('display');
assert.equal(animations.length, beforeReducedSwitch, 'Reduced-motion tab changes do not schedule animation');
fixture.reduceMotion(false);
assert.deepEqual(calls.motionCleanup, { trackFocus: 1, tabTransition: 1, lyricsPane: 1, detailView: 1 },
  'Disabling reduced motion does not cancel or finish unrelated controllers again');
fixture.clickTab('library');
const closingContent = $('#panel-body'), closingAnimation = runningContentAnimation();
fixture.closePanel();
await finishAnimations();
assert.equal(fixture.state().panel, null);
assert.equal(closingAnimation.playState, 'idle', 'Closing clears the settings content animation');
assert.equal(closingContent.isConnected, false);
assert.equal($('#music-panel-root').children.length, 0);
fixture.clickAction('settings'); await finishAnimations();
fixture.clickTab('display');
const retiringBody = $('#panel-body'), retiringAnimation = runningContentAnimation();
fixture.closePanel();
// Resolve the closing animations, then reopen before their promise callbacks.
animations.filter(animation => animation.playState === 'running').forEach(animation => animation.finish());
fixture.openPanel('settings');
const reopenedPage = $('#settings-page-display');
await microtasks();
assert.equal(fixture.state().panel, 'settings', 'A queued old close cannot remove a reopened dialog');
assert.equal($('#settings-page-display'), reopenedPage);
assert.equal(retiringAnimation.playState, 'idle', 'Reopening cancels the old content animation even before its dialog close resolves');
assert.equal(retiringBody.isConnected, false);
assert.equal(computedStyle($('#panel-body')).opacity, '1', 'A reopened dialog is not faded by its retired content animation');
await finishAnimations(); selected('display');
fixture.clickTab('library'); sampleSwitch('library'); await finishAnimations(); selected('library');
fixture.closePanel(); await finishAnimations();
assert.ok(animations.every(animation => animation.playState === 'idle'), 'No dialog or page animation remains owned after closing');

// Reading genre rules may finish after the user changes pages or dialogs.
// Keep the response useful without stealing focus or showing a hidden editor.
calls.deferRequests = true;
fixture.clickAction('library'); await finishAnimations();
$('#settings-page-library').scrollTop = 487;
const waitingBody = $('#genre-editor-panel'), beforeRequest = calls.requests;
const loadingRules = fixture.editGenres();
assert.equal(waitingBody.getAttribute('aria-busy'), 'true');
await fixture.editGenres();
assert.equal(calls.requests, beforeRequest + 1, 'Double-clicking edit while loading sends only one request');
fixture.clickTab('display'); await finishAnimations();
$('#settings-tab-display').focus();
$('#settings-page-display').scrollTop = 233;
calls.pendingRequests.shift()({ groups: ['downloaded rules'] });
await loadingRules; selected('display');
assert.equal(waitingBody.getAttribute('aria-busy'), 'false');
assert.equal(waitingBody.hidden, true);
assert.equal(waitingBody.inert, true);
assert.equal($('#library-settings-content').hidden, false, 'An inactive-page response cannot replace the library content');
assert.equal($('#settings-page-library').scrollTop, 487);
assert.equal($('#settings-page-display').scrollTop, 233);
assert.equal(document.activeElement, $('#settings-tab-display'), 'A background response does not steal focus');
const loadedRules = $('#genre-json');
assert.match(waitingBody.markup, /downloaded rules/, 'The completed response is retained for the next explicit edit');
fixture.clickTab('library'); await finishAnimations();
await fixture.editGenres();
assert.equal(calls.requests, beforeRequest + 1, 'Explicitly opening the loaded editor does not fetch again');
assert.equal($('#genre-json'), loadedRules);
assert.equal(waitingBody.hidden, false);
assert.equal(document.activeElement, loadedRules);
fixture.clickAction('library-settings-back');
assert.equal($('#settings-page-library').scrollTop, 487, 'Deferred editor entry preserves the original library scroll');

fixture.closePanel(); await finishAnimations();
fixture.clickAction('library'); await finishAnimations();
const abandonedBody = $('#genre-editor-panel');
const abandonedRequest = fixture.editGenres();
fixture.closePanel(); await finishAnimations();
fixture.clickAction('library'); await finishAnimations();
const replacementBody = $('#genre-editor-panel');
$('#settings-page-library').scrollTop = 144;
$('#settings-tab-library').focus();
calls.pendingRequests.shift()({ groups: ['stale old dialog'] });
await abandonedRequest; selected('library');
assert.equal(abandonedBody.isConnected, false);
assert.equal($('#genre-editor-panel'), replacementBody);
assert.equal(replacementBody.querySelector('#genre-json'), null, 'An old dialog response cannot populate the new editor');
assert.equal(replacementBody.hidden, true);
assert.equal($('#library-settings-content').hidden, false);
assert.equal($('#settings-page-library').scrollTop, 144);
assert.equal(document.activeElement, $('#settings-tab-library'));
assert.equal(replacementBody.getAttribute('aria-busy'), null, 'Old-request cleanup does not alter the new dialog');
fixture.closePanel(); await finishAnimations();
console.log('Settings panel passed: exactly one visible page at all sampled times; detail 01/02 ContentTransition cadence; interrupted-opacity continuity and live global speed; ARIA/inert/roving focus; independent scroll and stable drafts/previews; legacy/AI routes; deferred genre loading; reduced motion and close/reopen cancellation.');
