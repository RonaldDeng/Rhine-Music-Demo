import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/music-lyrics-timeline.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { parseTimelineLrc, lyricGroupAt } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('LRC timestamps, repeated labels, offsets and translations retain exact timeline order', () => {
  const lines = parseTimelineLrc('\uFEFF[ar:Original fixture]\r\n[offset:250]\r\n[00:20.250][00:01.5]First\r\n[00:01.50]Translation\r\n[00:01.50]Translation\r\n[00:02:125]<00:02.12>Next\r\n[00:03]\r\n[00:99]Invalid');
  assert.deepEqual(lines, [
    { time: 1.25, text: 'First' }, { time: 1.25, text: 'Translation' },
    { time: 1.875, text: 'Next' }, { time: 2.75, text: '' }, { time: 20, text: 'First' },
  ]);
  assert.deepEqual(parseTimelineLrc('[00:00.12]Start\n[offset:-1000]'), [{ time: 1.12, text: 'Start' }]);
  assert.deepEqual(parseTimelineLrc('[offset:+2000]\n[00:01]Start'), [{ time: 0, text: 'Start' }]);
  assert.deepEqual(parseTimelineLrc('[ti:Metadata]\nPlain text'), []);
  assert.deepEqual(parseTimelineLrc('[00:02]<b>inert text</b>'), [{ time: 2, text: '<b>inert text</b>' }]);
});

test('groups use the inclusive bilingual range and handle seek, blank cues and end of song', () => {
  const lines = parseTimelineLrc('[00:02]Original\n[00:02]Translation\n[00:04]\n[00:06.5]Last');
  assert.equal(lyricGroupAt(lines, 1.999), null);
  assert.deepEqual(lyricGroupAt(lines, 2), { start: 0, end: 1, time: 2 });
  assert.deepEqual(lyricGroupAt(lines, 3.99), { start: 0, end: 1, time: 2 });
  assert.deepEqual(lyricGroupAt(lines, 4), { start: 2, end: 2, time: 4 });
  assert.deepEqual(lyricGroupAt(lines, 100), { start: 3, end: 3, time: 6.5 });
  assert.deepEqual(lyricGroupAt(lines, 2.1), { start: 0, end: 1, time: 2 });
  for (const time of [-1, NaN, Infinity]) assert.equal(lyricGroupAt(lines, time), null);
  assert.equal(lyricGroupAt([{ time: null }], 10), null);
  assert.equal(lyricGroupAt([], 10), null);
});
