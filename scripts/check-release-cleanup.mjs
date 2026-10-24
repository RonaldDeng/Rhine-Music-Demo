import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const retired = [
  'public/layout-lab', 'scripts/layout-lab.mjs',
  'tools/launchers/启动布局调节.command', 'tools/launchers/启动光照实验.command',
  'src/music-layout-tuning.ts', 'src/music-layout-tuning.css',
  'src/music-lighting-lab.ts', 'src/music-lighting-lab.css', 'src/music-motion-lab.ts',
  'src/music-review-fixture.ts', 'src/lyrics-review.lrc', 'src/music-frame-timing.ts',
  'docs/v0.6.0b',
];
for (const file of retired) {
  await assert.rejects(fs.stat(path.join(root, file)), { code: 'ENOENT' }, `Retired development entry returned: ${file}`);
}
const markers = ['window.rhineMusic', 'window.rhine =', 'dataset.startupPreparation',
  'class="lighting-lab', 'class="motion-lab', 'layoutLab', 'lyricsDemo', 'createSilentLyricsClock',
  'music-layout-tuning', 'music-lighting-lab', 'music-review-fixture', 'lyrics-review.lrc'];
async function inspect(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await inspect(file);
    else if (/\.(?:ts|js|css|html)$/.test(file)) {
      const source = await fs.readFile(file, 'utf8');
      for (const marker of markers) assert.ok(!source.includes(marker), `${path.relative(root, file)} retains ${marker}`);
    }
  }
}
await inspect(path.join(root, 'src'));
await inspect(path.join(root, 'dist'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
for (const entry of ['lab', 'layout:lab', 'check:v060b']) assert.equal(pkg.scripts[entry], undefined);
console.log('Release cleanup passed: no experiment pages, launchers, debug hooks, preview clocks or retired script entries in source/build.');
