// Shared 800px typography renderer: production uses B; the study keeps A/B/C.
export const SIZE = 800;
export const variants = [
  { id: 'a', label: 'A · 暖纸排印', note: '常规字重、宽松行距；最贴近暖昼界面的留白。', weight: 400, maximum: 184, minimum: 38, leading: 1.08, pad: 50, ink: '#252b29', muted: '#6c726d', rule: '#9da49a', palettes: ['#e8e5e1', '#e4e5de', '#e9e3da'] },
  { id: 'b', label: 'B · 深夜字块', note: '粗字重、紧凑行距；缩略视图下识别更强。', weight: 700, maximum: 182, minimum: 38, leading: 1.015, pad: 46, ink: '#e9eef2', muted: '#a0adae', rule: '#5e6e70', palettes: ['#252c2f', '#292f2c', '#292c33'] },
  { id: 'c', label: 'C · 冷灰轻字', note: '轻字重、更大呼吸间隔；接近界面细线与透明材质。', weight: 300, maximum: 176, minimum: 38, leading: 1.15, pad: 54, ink: '#3e4d4e', muted: '#687b7b', rule: '#8b9b98', palettes: ['#d7ddda', '#ddded7', '#d5dfe0'] },
];
export const samples = [
  { id: 'zh', albumKey: 'field-notes', title: '风经过的地方', artist: '林间回声', language: '中文 / 短标题' },
  { id: 'en', albumKey: 'field-notes', title: 'Where the Wind Goes', artist: 'Forest Echo', language: 'ENGLISH / SHORT TITLE' },
  { id: 'mixed-long', albumKey: 'field-notes-2', title: '在城市醒来以前（Before the Morning）· 夜行记录第二辑', artist: '林间回声 / Forest Echo', language: '中英混排 / 长标题' },
  { id: 'en-long', albumKey: 'field-notes-3', title: 'An Uninterrupted Conversation with the Night and Everything We Left Unsaid', artist: 'Forest Echo', language: 'ENGLISH / LONG TITLE' },
];
const words = new Intl.Segmenter('zh', { granularity: 'word' });
const closing = /^[，。！？、；：）》」』】〉〕·,.!?;:)\]}”’]+$/u;
const opening = /^[（《「『【〈〔(\[{“‘]+$/u;
const joiner = /^[-‐‑/'’ʼ&]+$/u;
const nonCjkWord = /^[\p{Letter}\p{Number}\p{Mark}]+(?:[.'’ʼ][\p{Letter}\p{Number}\p{Mark}]+)*$/u;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const clean = (value, fallback) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim() || fallback;
const hash = (value) => [...value].reduce((h, c) => Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0, 2166136261);

// Units are indivisible at every font size, including the ellipsis fallback.
// Protect a known artist's name before dictionary segmentation of CJK titles.
export function coverWords(value, protectedTerms = []) {
  const text = clean(value, '');
  const terms = [...new Set(protectedTerms.map(term => clean(term, '')).filter(Boolean))].sort((a, b) => b.length - a.length);
  const raw = [];
  let cursor = 0;
  let chunkStart = 0;
  const segment = (chunk) => raw.push(...[...words.segment(chunk)].map(({ segment }) => segment));
  while (cursor < text.length) {
    const term = terms.find(term => {
      if (!text.startsWith(term, cursor)) return false;
      const latinStart = /^[\p{Script=Latin}\p{Number}]/u.test(term);
      const latinEnd = /[\p{Script=Latin}\p{Number}]$/u.test(term);
      return !(latinStart && /[\p{Letter}\p{Number}]$/u.test(text.slice(0, cursor))) &&
        !(latinEnd && /^[\p{Letter}\p{Number}]/u.test(text.slice(cursor + term.length)));
    });
    if (!term) { cursor += 1; continue; }
    segment(text.slice(chunkStart, cursor));
    raw.push(term);
    cursor += term.length;
    chunkStart = cursor;
  }
  segment(text.slice(chunkStart));
  const joined = [];
  const isWord = token => nonCjkWord.test(token) && !cjk.test(token);
  for (let i = 0; i < raw.length; i += 1) {
    let token = raw[i];
    if (isWord(token)) {
      while (joiner.test(raw[i + 1] ?? '') && isWord(raw[i + 2] ?? '')) {
        token += raw[i + 1] + raw[i + 2];
        i += 2;
      }
    }
    joined.push(token);
  }
  const output = [];
  let spaceBefore = false;
  let prefix = '';
  let prefixSpace = false;
  for (const token of joined) {
    if (/^\s+$/u.test(token)) {
      if (prefix) prefix += ' ';
      else spaceBefore = output.length > 0;
      continue;
    }
    const quote = token === '"';
    const opens = opening.test(token) || (quote && (!output.length || spaceBefore || prefix));
    if (opens) {
      if (!prefix) prefixSpace = spaceBefore;
      prefix += token;
      spaceBefore = false;
    } else if ((closing.test(token) || quote) && output.length && !prefix) {
      output.at(-1).text += (spaceBefore ? ' ' : '') + token;
      spaceBefore = false;
    } else {
      output.push({ text: prefix + token, spaceBefore: prefix ? prefixSpace : spaceBefore });
      prefix = '';
      spaceBefore = false;
    }
  }
  // Malformed trailing opening punctuation is retained with the preceding unit.
  if (prefix) {
    if (output.length) output.at(-1).text += (prefixSpace ? ' ' : '') + prefix;
    else output.push({ text: prefix, spaceBefore: false });
  }
  return output;
}
const lineText = units => units.map((unit, i) => `${i && unit.spaceBefore ? ' ' : ''}${unit.text}`).join('');
function wrap(context, units, width) {
  const output = [];
  let line = [];
  for (const unit of units) {
    if (line.length && context.measureText(lineText([...line, unit])).width > width) {
      output.push(line);
      line = [];
    }
    line.push(unit);
  }
  if (line.length) output.push(line);
  return output;
}
const setFont = (context, weight, size) => { context.font = `${weight} ${size}px "MiSans", sans-serif`; };
const textHeight = (metrics) => Math.max(...metrics.map(m => m.actualBoundingBoxAscent)) + Math.max(...metrics.map(m => m.actualBoundingBoxDescent));
function ellipsis(context, units, width) {
  const kept = [...units];
  while (kept.length && context.measureText(lineText(kept) + '…').width > width) kept.pop();
  return lineText(kept) + '…';
}
function titleLayout(context, title, variant, protectedTerms) {
  const maxWidth = SIZE - variant.pad * 2;
  const maxHeight = 550;
  const units = coverWords(title, protectedTerms);
  const atSize = (size) => {
    setFont(context, variant.weight, size);
    const lines = wrap(context, units, maxWidth).map(lineText);
    const metrics = lines.map(line => context.measureText(line));
    const height = (lines.length - 1) * size * variant.leading + textHeight(metrics);
    return { lines, size, height, fits: height <= maxHeight && metrics.every(m => m.width <= maxWidth) };
  };
  for (let size = variant.maximum; size >= variant.minimum; size -= 2) {
    const layout = atSize(size);
    if (layout.fits) { const { fits, ...result } = layout; return { ...result, truncated: false }; }
  }
  // A very long word can use a smaller font, but is never sliced into letters.
  // Ordinary multi-line titles retain the normal 38px readability floor.
  if (units.some(unit => context.measureText(unit.text).width > maxWidth)) {
    for (let size = variant.minimum - 2; size >= 12; size -= 2) {
      const layout = atSize(size);
      if (layout.fits) { const { fits, ...result } = layout; return { ...result, truncated: false }; }
    }
  }
  const size = variant.minimum;
  setFont(context, variant.weight, size);
  const rows = wrap(context, units, maxWidth);
  const glyphHeight = textHeight(rows.map(row => context.measureText(lineText(row))));
  const maxLines = Math.max(1, Math.floor((maxHeight - glyphHeight) / (size * variant.leading)) + 1);
  const kept = [];
  for (const row of rows) {
    if (kept.length >= maxLines || context.measureText(lineText(row)).width > maxWidth) break;
    kept.push(row);
  }
  if (!kept.length) kept.push([]);
  const lines = kept.map(lineText);
  lines[lines.length - 1] = ellipsis(context, kept.at(-1), maxWidth);
  return { lines, size, height: (lines.length - 1) * size * variant.leading + textHeight(lines.map(line => context.measureText(line))), truncated: true };
}
function leftText(context, text, x, baseline) {
  const metrics = context.measureText(text);
  context.fillText(text, x + metrics.actualBoundingBoxLeft, baseline);
}
function fitFooter(context, text, width) {
  for (let size = 22; size >= 12; size -= 1) {
    setFont(context, 400, size);
    if (context.measureText(text).width <= width) return text;
  }
  return ellipsis(context, coverWords(text), width);
}
export async function loadFonts() {
  await Promise.all([300, 400, 700].map(weight => document.fonts.load(`${weight} 100px "MiSans"`, '风经过的地方 Where the Wind Goes')));
  await document.fonts.ready;
}
export function drawCover(canvas, metadata, variantId) {
  const variant = variants.find(v => v.id === variantId) ?? variants[0];
  const context = canvas.getContext('2d');
  canvas.width = canvas.height = SIZE;
  const title = clean(metadata.title, '未命名专辑');
  const artist = clean(metadata.artist, '未知艺术家');
  const seed = hash(metadata.albumKey || `${title}\u241f${artist}`);
  context.fillStyle = variant.palettes[seed % variant.palettes.length];
  context.fillRect(0, 0, SIZE, SIZE);
  context.textBaseline = 'alphabetic';
  const layout = titleLayout(context, title, variant, [artist]);
  setFont(context, variant.weight, layout.size);
  context.fillStyle = variant.ink;
  const ascent = Math.max(...layout.lines.map(line => context.measureText(line).actualBoundingBoxAscent));
  layout.lines.forEach((line, i) => leftText(context, line, variant.pad, variant.pad + ascent + i * layout.size * variant.leading));
  context.strokeStyle = variant.rule;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(variant.pad, 669.5);
  context.lineTo(SIZE - variant.pad, 669.5);
  context.stroke();
  setFont(context, 400, 22);
  context.fillStyle = variant.ink;
  leftText(context, fitFooter(context, artist, SIZE - variant.pad * 2 - 92), variant.pad, 713);
  return { variant: variant.id, title, artist, ...layout, titleHeight: layout.height, width: SIZE, height: SIZE };
}
