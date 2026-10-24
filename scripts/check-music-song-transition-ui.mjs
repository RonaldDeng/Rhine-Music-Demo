import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { normalizeSongTransition } from '../src/music-song-transition.ts';
import { DEFAULT_LYRICS_PREFERENCES, LYRICS_FONT_OPTIONS, LYRICS_FONT_SIZE_MIN, LYRICS_FONT_SIZE_MAX } from '../src/music-lyrics-preferences.ts';

const modes = ['fade-out', 'fade-in-out', 'gapless'];
for (const mode of modes) for (const legacy of [undefined, true, false, null, 'false', 0])
  assert.equal(normalizeSongTransition(mode, legacy), mode, 'An explicit new mode wins over legacy fade preferences');
for (const invalid of [undefined, null, false, true, '', 'fade', 'GAPLESS', 0, {}, [], ['gapless']]) {
  assert.equal(normalizeSongTransition(invalid, false), 'gapless');
  for (const legacy of [undefined, true, null, 'false', 0])
    assert.equal(normalizeSongTransition(invalid, legacy), 'fade-in-out');
}

// Run the production preference load, player options, settings markup and
// change branch. Browser storage and player effects are isolated from music.
const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const variable = name => {
  const node = tree.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name));
  assert.ok(node, `Production variable ${name} exists`);
  return node.getText(tree);
};
const functionSource = name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production function ${name} exists`);
  return node.getText(tree);
};
const normalization = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(tree) === 'preferences.songTransition');
const visibilityNormalization = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(tree) === 'preferences.showSongTransitionControl');
const retireLegacy = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isDeleteExpression(node.expression) && node.expression.expression.getText(tree) === 'preferences.songFade');
assert.ok(normalization && retireLegacy, 'Legacy settings are normalized before the obsolete key is retired');
assert.ok(visibilityNormalization, 'The control visibility preference is normalized independently of playback');
assert.ok(normalization.pos < retireLegacy.pos);
const settings = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderDisplaySettings');
const changeListener = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'document.addEventListener' &&
  node.expression.arguments[0]?.text === 'change');
const changeBranch = changeListener.expression.arguments[1].body.statements.find(node =>
  ts.isIfStatement(node) && node.expression.getText(tree) === 'el.id === "song-fade-setting"');
const visibilityBranch = changeListener.expression.arguments[1].body.statements.find(node =>
  ts.isIfStatement(node) && node.expression.getText(tree) === 'el.id === "show-song-transition-control"');
assert.ok(changeBranch, 'The production change branch retains the established control id');
assert.ok(visibilityBranch, 'A separate settings control changes only shortcut visibility');
const clickListener = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'document.addEventListener' &&
  node.expression.arguments[0]?.text === 'click');
const actionSwitch = clickListener.expression.arguments[1].body.statements.find(node =>
  ts.isSwitchStatement(node) && node.expression.getText(tree) === 'action');
const toggleCase = actionSwitch.caseBlock.clauses.find(node =>
  ts.isCaseClause(node) && node.expression.text === 'song-transition');
assert.ok(toggleCase, 'The real toolbar click dispatcher handles the transition shortcut');
const subscription = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'player.subscribe');
assert.ok(subscription.expression.arguments[0].body.statements.some(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'syncSongTransitionControl'),
  'Playback updates synchronize the icon, including asynchronous gapless warnings');
const transpile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(saved, { rawStorage, denyStorage = false, settingsOpen = true } = {}) {
  const storage = new Map(saved === undefined ? [] : [['rhine-music-preferences', JSON.stringify(saved)]]);
  if (rawStorage !== undefined) storage.set('rhine-music-preferences', rawStorage);
  const localStorage = {
    getItem(key) { if (denyStorage) throw new Error('Unavailable storage'); return storage.get(key) ?? null; },
    setItem(key, value) { if (denyStorage) throw new Error('Unavailable storage'); storage.set(key, value); },
  };
  const calls = [], notices = [];
  const playback = { albumId: 'album-kept', trackId: 'track-kept', playing: true, position: 87.25 };
  const makeElement = () => {
    const attributes = new Map();
    return { hidden: false, dataset: {}, value: '', checked: false, title: '',
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
    };
  };
  const button = makeElement(), selectControl = makeElement(), visibilityControl = makeElement();
  const stage = { dataset: {} };
  const elements = new Map([['#song-transition-toggle', button]]);
  if (settingsOpen) {
    elements.set('#song-fade-setting', selectControl);
    elements.set('#show-song-transition-control', visibilityControl);
  }
  const document = { querySelector: selector => elements.get(selector) ?? null };
  const $ = selector => {
    assert.ok(elements.has(selector), `The production UI targets a known element: ${selector}`);
    return elements.get(selector);
  };
  class MusicPlayer {
    constructor(options) {
      this.options = { ...options };
      this.state = { songTransitionMode: options.songTransitionMode, transitionWarning: null };
    }
    setSongTransitionMode(mode) {
      calls.push({ method: 'setSongTransitionMode', mode });
      this.state.songTransitionMode = mode;
      this.state.transitionWarning = this.nextWarning ?? null;
      this.nextWarning = null;
    }
    playTrack() { assert.fail('Changing a preference must not select or restart a track'); }
    stop() { assert.fail('Changing a preference must not stop playback'); }
  }
  const code = `
    const preferencesKey = 'rhine-music-preferences', isReviewMode = false;
    ${variable('read')}
    ${variable('save')}
    ${variable('preferences')}
    ${normalization.getText(tree)}
    ${visibilityNormalization.getText(tree)}
    ${retireLegacy.getText(tree)}
    ${variable('player')}
    ${variable('songTransitionNames')}
    ${functionSource('savePrefs')}
    ${functionSource('syncSongTransitionControl')}
    ${functionSource('applySongTransition')}
    ${functionSource('toggleSongTransition')}
    let selected = 37;
    const select = () => { throw new Error('Unexpected album selection'); };
    const setMode = () => { throw new Error('Unexpected navigation'); };
    function change(value) {
      const el = { id: 'song-fade-setting', value };
      ${changeBranch.getText(tree)}
      return el.value;
    }
    function changeVisibility(checked) {
      const el = { id: 'show-song-transition-control', checked };
      ${visibilityBranch.getText(tree)}
    }
    function click() {
      const action = 'song-transition';
      switch (action) { ${toggleCase.getText(tree)} }
    }
    function markup() {
      const panel = { innerHTML: '' }, $ = () => panel;
      const themeNames = { day: '晨雾', night: '月影' };
      const sortLabels = { genre: { name: '按流派' }, artist: { name: '按歌手' }, album: { name: '按专辑名' } };
      const audioOutputMarkup = () => '', qualityMarkup = () => '', renderQuality = {};
      const lightingLab = false, appVersion = '0.5.0';
      const { DEFAULT_LYRICS_PREFERENCES, LYRICS_FONT_OPTIONS, LYRICS_FONT_SIZE_MIN, LYRICS_FONT_SIZE_MAX } = lyricsDefaults;
      const getLyricsPreferences = () => ({ ...DEFAULT_LYRICS_PREFERENCES }), esc = value => value;
      ${functionSource('lyricsSettingsMarkup')}
      ${settings.body.statements[0].getText(tree)}
      return panel.innerHTML;
    }
    syncSongTransitionControl();
    return { preferences, player, change, changeVisibility, click, markup, sync: syncSongTransitionControl,
      toggle: toggleSongTransition, selected: () => selected };
  `;
  const ports = new Function('localStorage', 'normalizeSongTransition', 'MusicPlayer', '$', 'document', 'stage', 'notify', 'lyricsDefaults', transpile(code))(
    localStorage, normalizeSongTransition, MusicPlayer, $, document, stage, message => notices.push(message),
    { DEFAULT_LYRICS_PREFERENCES, LYRICS_FONT_OPTIONS, LYRICS_FONT_SIZE_MIN, LYRICS_FONT_SIZE_MAX },
  );
  return { ...ports, storage, calls, playback, button, selectControl, visibilityControl, stage, notices };
}

const optionState = markup => {
  const control = markup.match(/<select\b[^>]*\bid="song-fade-setting"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(control, 'Song transitions use a native select');
  assert.match(control[0], /aria-label="歌曲衔接方式"/);
  assert.doesNotMatch(markup, /<input\b[^>]*\bid="song-fade-setting"/);
  const options = [...control[1].matchAll(/<option\b([^>]*)>([^<]+)<\/option>/g)].map(([, attrs, label]) => ({
    value: attrs.match(/\bvalue="([^"]+)"/)[1], label, selected: /\bselected\b/.test(attrs),
  }));
  assert.deepEqual(options.map(({ value, label }) => [value, label]), [
    ['fade-out', '淡出但不淡入'], ['fade-in-out', '淡入淡出'], ['gapless', '无缝播放'],
  ]);
  assert.equal(options.filter(option => option.selected).length, 1, 'Exactly one persisted mode is selected');
  return options.find(option => option.selected).value;
};
const labels = { 'fade-out': '淡出但不淡入', 'fade-in-out': '淡入淡出', gapless: '无缝播放' };
const checkControl = (f, mode, visible = true) => {
  assert.equal(f.button.hidden, !visible);
  assert.equal(f.stage.dataset.transitionControl, String(visible));
  assert.equal(f.button.dataset.transition, mode, 'The icon uses the actual playback mode, including legacy fade-out');
  assert.equal(f.button.getAttribute('aria-pressed'), String(mode !== 'gapless'));
  const next = mode === 'gapless' ? 'fade-in-out' : 'gapless';
  assert.ok(f.button.getAttribute('aria-label').includes(`歌曲衔接：${labels[mode]}`));
  assert.ok(f.button.getAttribute('aria-label').includes(`点击切换为${labels[next]}`));
  assert.ok(f.button.title.includes(labels[mode]));
};
const visibilityState = markup => {
  const input = markup.match(/<input\b[^>]*\bid="show-song-transition-control"[^>]*>/);
  assert.ok(input, 'Settings retain an independent shortcut visibility checkbox');
  assert.match(input[0], /\btype="checkbox"/);
  return /\bchecked\b/.test(input[0]);
};

for (const [saved, expected] of [
  [undefined, 'fade-in-out'], [{}, 'fade-in-out'], [null, 'fade-in-out'],
  [{ songFade: true }, 'fade-in-out'], [{ songFade: false }, 'gapless'],
  [{ songFade: 'false' }, 'fade-in-out'], [{ songFade: 0 }, 'fade-in-out'],
  [{ songTransition: null, songFade: false }, 'gapless'],
  [{ songTransition: 'invalid' }, 'fade-in-out'],
  [{ songTransition: 'invalid', songFade: false }, 'gapless'],
  ...modes.map(mode => [{ songTransition: mode, songFade: false }, mode]),
]) {
  const f = fixture(saved);
  assert.equal(f.preferences.songTransition, expected);
  assert.equal(f.player.options.songTransitionMode, expected, 'Playback starts with the normalized persisted mode');
  assert.ok(!Object.hasOwn(f.preferences, 'songFade'), 'Only the new setting survives normalization');
  assert.equal(optionState(f.markup()), expected);
  assert.equal(f.preferences.showSongTransitionControl, true, 'The shortcut is visible for existing installations');
  checkControl(f, expected);
  assert.equal(visibilityState(f.markup()), true);
  assert.deepEqual(f.calls, [], 'Loading settings does not issue playback commands');
}

for (const mode of modes) {
  const f = fixture({ songFade: false, volume: .42, bgm: false, bgmVolume: .21,
    sound: false, soundVolume: .18, rememberColumnPosition: false });
  const originalPlayback = { ...f.playback }, originalSelection = f.selected();
  assert.equal(f.change(mode), mode);
  assert.equal(f.preferences.songTransition, mode);
  checkControl(f, mode);
  assert.equal(f.selectControl.value, mode);
  assert.deepEqual(f.notices, [], 'Settings changes remain quiet; the shortcut owns the confirmation toast');
  assert.deepEqual(f.calls, [{ method: 'setSongTransitionMode', mode }]);
  assert.equal(f.selected(), originalSelection);
  assert.deepEqual(f.playback, originalPlayback);
  const persisted = JSON.parse(f.storage.get('rhine-music-preferences'));
  assert.equal(persisted.songTransition, mode);
  assert.ok(!Object.hasOwn(persisted, 'songFade'), 'Saving removes the retired legacy boolean');
  for (const key of ['volume', 'bgm', 'bgmVolume', 'sound', 'soundVolume', 'rememberColumnPosition'])
    assert.equal(persisted[key], f.preferences[key], `Saving preserves ${key}`);
  const reloaded = fixture(persisted);
  assert.equal(reloaded.preferences.songTransition, mode);
  assert.equal(reloaded.player.options.songTransitionMode, mode);
  assert.equal(optionState(reloaded.markup()), mode);
}

const malformed = fixture(undefined, { rawStorage: '{broken' });
assert.equal(malformed.preferences.songTransition, 'fade-in-out');
assert.equal(malformed.change('invalid'), 'fade-in-out');
assert.equal(optionState(malformed.markup()), 'fade-in-out');
const unavailable = fixture(undefined, { denyStorage: true });
assert.equal(unavailable.preferences.songTransition, 'fade-in-out');
assert.doesNotThrow(() => unavailable.change('fade-out'), 'Unavailable storage does not block a live settings change');
assert.equal(unavailable.preferences.songTransition, 'fade-out');

for (const saved of [undefined, null, true, false, 'false', 0]) {
  const f = fixture({ showSongTransitionControl: saved });
  const visible = saved !== false;
  assert.equal(f.preferences.showSongTransitionControl, visible);
  assert.equal(visibilityState(f.markup()), visible);
  assert.equal(f.visibilityControl.checked, visible);
  checkControl(f, 'fade-in-out', visible);
}

for (const mode of modes) {
  const f = fixture({ songTransition: mode, volume: .42, rememberColumnPosition: false });
  const originalPlayback = { ...f.playback }, originalSelection = f.selected();
  const next = mode === 'gapless' ? 'fade-in-out' : 'gapless';
  f.click();
  checkControl(f, next);
  assert.equal(f.preferences.songTransition, next);
  assert.equal(f.selectControl.value, next, 'An already open settings select follows toolbar changes');
  assert.deepEqual(f.calls, [{ method: 'setSongTransitionMode', mode: next }]);
  assert.deepEqual(f.notices, [`已切换为${labels[next]}`], 'Each toolbar click emits one confirmation via the existing toast');
  f.click();
  const second = next === 'gapless' ? 'fade-in-out' : 'gapless';
  checkControl(f, second);
  assert.equal(f.calls.length, 2, 'The click dispatcher applies exactly one mode change per click');
  assert.equal(f.selected(), originalSelection);
  assert.deepEqual(f.playback, originalPlayback);
  const persisted = JSON.parse(f.storage.get('rhine-music-preferences'));
  assert.equal(persisted.songTransition, second);
  assert.equal(persisted.volume, .42);
  assert.equal(persisted.rememberColumnPosition, false);
  checkControl(fixture(persisted), second);
}

for (const mode of modes) {
  const f = fixture({ songTransition: mode });
  const originalPlayback = { ...f.playback };
  f.changeVisibility(false);
  checkControl(f, mode, false);
  assert.equal(f.preferences.songTransition, mode, 'Hiding the shortcut never changes the selected transition');
  assert.equal(visibilityState(f.markup()), false);
  assert.deepEqual(f.calls, [], 'Visibility does not command the audio engine');
  assert.deepEqual(f.notices, []);
  f.click();
  assert.deepEqual(f.calls, [], 'A hidden shortcut cannot toggle playback mode through the dispatcher');
  const persisted = JSON.parse(f.storage.get('rhine-music-preferences'));
  const reloaded = fixture(persisted);
  checkControl(reloaded, mode, false);
  for (const setting of modes) {
    f.change(setting);
    checkControl(f, setting, false);
    assert.equal(optionState(f.markup()), setting, 'All settings remain usable with the shortcut hidden');
  }
  const callsBeforeShow = f.calls.length;
  f.changeVisibility(true);
  checkControl(f, 'gapless');
  assert.equal(f.calls.length, callsBeforeShow, 'Showing the shortcut also leaves the audio engine alone');
  assert.deepEqual(f.playback, originalPlayback);
  assert.deepEqual(f.notices, []);
}

const closed = fixture({ songTransition: 'fade-in-out' }, { settingsOpen: false });
assert.doesNotThrow(() => closed.click(), 'The shortcut works when settings are not mounted');
checkControl(closed, 'gapless');
const warning = '无缝播放未能及时准备下一首，本次队列改用普通播放。';
closed.player.state.transitionWarning = warning;
closed.sync();
assert.ok(closed.button.title.includes(warning), 'A fallback warning remains available on the current mode control');
assert.ok(closed.button.getAttribute('aria-label').includes(warning), 'Assistive technology receives the same fallback warning');
closed.click();
assert.ok(!closed.button.title.includes(warning), 'Changing modes clears obsolete fallback status');
closed.player.nextWarning = warning;
closed.click();
assert.equal(closed.notices.at(-1), warning, 'A synchronous fallback warning replaces an inaccurate success toast');
checkControl(closed, 'gapless');
closed.player.state.transitionWarning = null;
closed.sync();
assert.ok(!closed.button.title.includes(warning), 'Recovered playback clears the warning without requiring a preference change');

const live = fixture({ songTransition: 'fade-in-out' });
live.player.state.songTransitionMode = 'gapless';
live.sync();
checkControl(live, 'gapless');
live.click();
checkControl(live, 'fade-in-out');
assert.deepEqual(live.calls, [{ method: 'setSongTransitionMode', mode: 'fade-in-out' }],
  'Click direction follows live playback state instead of a stale preference');
assert.doesNotThrow(() => unavailable.changeVisibility(false));
checkControl(unavailable, 'fade-out', false);
assert.doesNotThrow(() => unavailable.changeVisibility(true));
assert.doesNotThrow(() => unavailable.click());
checkControl(unavailable, 'gapless');

console.log('Song-transition UI passed: legacy migration, three-mode settings, real click dispatch, mode icons and accessible labels, visibility persistence, independent settings, open/closed panel sync, fallback warnings, confirmation toasts and storage failures.');
