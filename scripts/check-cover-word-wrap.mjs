import assert from 'node:assert/strict';
import { drawCover, coverWords, variants } from '../reference/cover-candidates/generator.mjs';

// Deterministic text metrics verify content and layout contracts. Real MiSans
// canvas rendering is checked separately in the browser, not simulated here.
class TextCanvas {
  width = 0;
  height = 0;
  calls = [];
  context = {
    font: '',
    measureText: (text) => {
      const size = Number(this.context.font.match(/([\d.]+)px/u)?.[1] ?? 22);
      const ems = [...text].reduce((total, glyph) => total + (
        /\s/u.test(glyph) ? 0.3 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(glyph) ? 1 : /[\p{Letter}\p{Number}]/u.test(glyph) ? 0.58 : 0.35
      ), 0);
      return { width: ems * size, actualBoundingBoxLeft: 0, actualBoundingBoxAscent: size * 0.78, actualBoundingBoxDescent: size * 0.2 };
    },
    fillText: (text, x, y) => this.calls.push({ text, x, y, font: this.context.font, metrics: this.context.measureText(text) }),
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  getContext(kind) { assert.equal(kind, '2d'); return this.context; }
}

const noSpaces = (text) => text.replace(/\s/gu, '');
const englishUnits = (text) => text.match(/[A-Za-z]+(?:['’ʼ/\-‐‑][A-Za-z]+)*/gu) ?? [];
function render(title, variant, artist = 'Synthetic Artist') {
  const canvas = new TextCanvas();
  const layout = drawCover(canvas, { title, artist, albumKey: 'synthetic-word-wrap-check' }, variant.id);
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 800);
  const titleCalls = canvas.calls.slice(0, layout.lines.length);
  assert.deepEqual(titleCalls.map(call => call.text), layout.lines);
  for (const call of titleCalls) {
    assert.ok(call.x >= variant.pad, 'left aligned within the title margin');
    assert.ok(call.metrics.width <= 800 - 2 * variant.pad + 1e-6, `title overflows horizontally: ${call.text}`);
    assert.ok(call.y - call.metrics.actualBoundingBoxAscent >= variant.pad - 1e-6, 'title is not cropped at the top');
    assert.ok(call.y + call.metrics.actualBoundingBoxDescent <= variant.pad + 550 + 1e-6, 'title stays clear of the footer');
    assert.ok(!/^[，。！？、；：）》」』】〉〕,.!?;:)\]}”’]/u.test(call.text), 'no orphaned closing punctuation');
    assert.ok(!/[（《「『【〈〔(\[{“‘]$/u.test(call.text), 'no orphaned opening punctuation');
  }
  const footer = canvas.calls.find(call => call.y === 713);
  assert.ok(footer.metrics.width <= 800 - variant.pad * 2 - 92 + 1e-6, 'artist footer remains within its column');
  return { canvas, layout, footer };
}

const cases = [
  'Where the Wind Goes',
  'An Uninterrupted Conversation with the Night and Everything We Left Unsaid',
  'Supercalifragilisticexpialidocious',
  'Pneumonoultramicroscopicsilicovolcanoconiosis Live',
  "Can't Stop the Rock’n’Roll After-hours AC/DC",
  'After‐hours After‑hours They’re OʼConnor',
  'Somewhere (Uninterrupted Conversation) Tonight!',
  'First, Second! Third? “Uninterrupted Conversation”',
  '《夜行记录》·（Before the Morning）',
  'Night （Supercalifragilisticexpialidocious） Again',
  '在城市醒来以前（Before the Morning）· 夜行记录第二辑',
  'A Café Café\u0301 déjà-vu Encore',
  'Hello 👩🏽‍🚀 Goodbye',
];
for (const variant of variants) {
  for (const title of cases) {
    const { layout } = render(title, variant);
    assert.equal(layout.truncated, false, `ordinary title was shortened: ${title}`);
    assert.equal(noSpaces(layout.lines.join('')), noSpaces(title.normalize('NFC')), 'wrapping preserves all title characters');
    for (const word of englishUnits(title.normalize('NFC'))) {
      assert.ok(layout.lines.some(line => line.includes(word)), `word split across lines: ${word}`);
    }
  }

  const properName = render('几个薛之谦的故事', variant, '薛之谦').layout;
  assert.ok(properName.lines.some(line => line.includes('薛之谦')), 'artist names in a CJK title remain whole');
  assert.equal(noSpaces(properName.lines.join('')), '几个薛之谦的故事');

  const longToken = 'W'.repeat(80);
  const scaled = render(longToken, variant).layout;
  assert.equal(scaled.truncated, false, 'a single long word can shrink below the normal font floor');
  assert.deepEqual(scaled.lines, [longToken], 'long words are never sliced into letter fragments');
  assert.ok(scaled.size < variant.minimum);

  const impossibleToken = 'Z'.repeat(5000);
  const pathological = render(`Opening ${impossibleToken} Closing`, variant).layout;
  assert.equal(pathological.truncated, true);
  assert.ok(pathological.lines.at(-1).endsWith('…'));
  assert.ok(!pathological.lines.some(line => /Z/u.test(line)), 'unfit token is omitted whole, never partially printed');

  const longTitle = Array.from({ length: 350 }, (_, i) => `Word${i}`).join(' ');
  const shortened = render(longTitle, variant).layout;
  assert.equal(shortened.truncated, true);
  assert.ok(shortened.lines.at(-1).endsWith('…'));
  const displayed = shortened.lines.join(' ').replace(/…$/u, '').trim().split(/\s+/u);
  assert.deepEqual(displayed, longTitle.split(' ').slice(0, displayed.length), 'ellipsis retains a prefix of complete original words');

  const artist = `Opening ${'Unbroken'.repeat(100)} Closing`;
  const { footer } = render('Short title', variant, artist);
  assert.ok(footer.text.endsWith('…'));
  assert.ok(!footer.text.includes('Unbroken'), 'footer also omits an overlong word whole');
}

for (const unit of ["Can't", 'Rock’n’Roll', 'After-hours', 'After‐hours', 'After‑hours', 'OʼConnor', 'AC/DC', 'R&B', 'AT&T']) {
  assert.ok(coverWords(`Before ${unit} After`).some(token => token.text === unit), `${unit} is an indivisible unit`);
}
assert.deepEqual(coverWords('First, (Second)! “Third”').map(token => token.text), ['First,', '(Second)!', '“Third”'], 'punctuation remains bound to a complete word');
assert.ok(coverWords('几个薛之谦', ['薛之谦']).some(token => token.text === '薛之谦'), 'provided proper names override ambiguous segmentation');
for (const phrase of ['中文测试', '（Hello world）', "Can't stop", 'After-hours AC/DC']) {
  const tokens = coverWords(phrase);
  const reconstructed = tokens.map(token => `${token.spaceBefore ? ' ' : ''}${token.text}`).join('');
  assert.equal(reconstructed, phrase, 'tokenization preserves punctuation and spacing');
}
console.log('Cover word wrapping: whole English units, CJK proper names, bounds, font fitting, and whole-word ellipsis passed for A/B/C.');
