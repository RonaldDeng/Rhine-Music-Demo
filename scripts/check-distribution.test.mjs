import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { inspectDistribution, requiredSourceFiles, legacyEvidence, allowedDistributionPath, createSourceZip } from './check-distribution.mjs'

const execute = promisify(execFile)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-distribution-check-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (file, data = '') => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), data)
  }
  for (const file of requiredSourceFiles) await write(file, '')
  for (const file of requiredSourceFiles.filter(file => file.endsWith('.command'))) await fs.chmod(path.join(root, file), 0o755)
  await write('package.json', JSON.stringify({ version: '0.5.0' }))
  await write('package-lock.json', JSON.stringify({ version: '0.5.0', packages: { '': { version: '0.5.0' } } }))
  await write('index.html', '<title>RHINE MUSIC · V0.5.0</title><script type="module" src="/assets/index-Abcdef12.js"></script>')
  for (const file of requiredSourceFiles.filter(file => file.startsWith('public/'))) await write(`dist/${file.slice(7)}`, '')
  await write('dist/index.html', '<title>RHINE MUSIC · V0.5.0</title><script type="module" src="/assets/index-Abcdef12.js"></script>')
  await write('dist/assets/index-Abcdef12.js', 'export {};')
  await write('dist/sw.js', '// Synthetic build fixture, not a real worker.')
  await write('dist/pwa-build.json', JSON.stringify({ files: ['index.html', 'assets/index-Abcdef12.js'] }))
  return { root, write }
}

test('clean synthetic source and build pass without changing files; workspace dependencies are never included', async t => {
  const f = await fixture(t)
  await f.write('node_modules/do-not-package/index.js', '// development-only dependency')
  await f.write('.tools/do-not-package.txt', 'local check output')
  const before = await fs.stat(path.join(f.root, 'package.json'))
  const report = await inspectDistribution(f.root)
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
  assert.ok(!report.sourceFiles.some(file => /node_modules|\.tools|^dist\//.test(file)))
  assert.deepEqual(report.omittedDirectories, ['.tools', 'node_modules'])
  assert.equal((await fs.stat(path.join(f.root, 'package.json'))).mtimeMs, before.mtimeMs)
  assert.ok(!report.sourceFiles.some(file => /\.zip$/.test(file)))
})

test('private, research, PV and unlisted content cannot enter source or dist even when ignored by Git', async t => {
  const f = await fixture(t)
  for (const file of [
    'music-data-test/library-index.json', 'promo/private-manifest.json',
    'public/lighting-reference/frame.jpg', 'reference/unreviewed.png',
    'public/audio/typing-preview.wav', 'docs/media/unreviewed.jpg',
    'dist/lighting-reference/frame.jpg', 'dist/audio/typing-preview.wav',
    'dist/library-index.json', 'dist/assets/index-Abcdef12.js.map',
  ]) await f.write(file, 'SYNTHETIC PLACEHOLDER ONLY')
  const report = await inspectDistribution(f.root)
  assert.equal(report.ok, false)
  for (const marker of ['music-data-test', 'promo', 'lighting-reference', 'typing-preview', 'unreviewed', 'library-index', '.js.map']) {
    assert.ok(report.errors.some(error => error.includes(marker)), marker)
  }
  assert.equal(allowedDistributionPath('assets/index-Abcdef12.js'), true)
  assert.equal(allowedDistributionPath('../library-index.json'), false)
  assert.equal(allowedDistributionPath('assets/private-music.flac'), false)
})

test('symlinks, missing runtime files, stale build resources and version mismatches fail', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.root, 'reference/cover-candidates/generator.mjs'))
  await fs.symlink('generator.d.mts', path.join(f.root, 'reference/cover-candidates/generator.mjs'))
  await fs.unlink(path.join(f.root, 'native/RhineAudio.swift'))
  await f.write('dist/fonts/NOTICE.txt', 'stale fixture')
  await f.write('package-lock.json', JSON.stringify({ version: '0.4.3', packages: { '': { version: '0.4.3' } } }))
  const report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('符号链接')))
  assert.ok(report.errors.some(error => error.includes('native/RhineAudio.swift') && error.includes('缺少')))
  assert.ok(report.errors.some(error => error.includes('dist/fonts/NOTICE.txt') && error.includes('不一致')))
  assert.ok(report.errors.some(error => error.includes('package-lock.json') && error.includes('不一致')))
})

test('runtime imports, sample symbols and private paths are inspected; generic placeholders are accepted', async t => {
  const f = await fixture(t)
  const missingImport = ['import ', '"./missing-runtime";'].join('')
  await f.write('src/main.ts', missingImport)
  await f.write('src/audio.ts', `export const ${['TYPING', 'PCM'].join('_')} = [];`)
  await f.write('src/music-app.ts', `const root = "${['', 'Users', 'synthetic-private-name', 'Music'].join('/')}";`)
  await f.write('README.md', ['Example: ', '/', 'Users', '/你的用户名/Music'].join(''))
  const report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('相对导入不在源码包内')))
  assert.ok(report.errors.some(error => error.includes('采样模块')))
  assert.ok(report.errors.some(error => error.includes('src/music-app.ts') && error.includes('本机用户绝对路径')))
  assert.ok(!report.errors.some(error => error.includes('README.md')))
})

test('fingerprint detection works after renaming or embedding a sample; fixtures contain no PV recording', () => {
  const synthetic = Buffer.from(Array.from({ length: 384 }, (_, index) => index % 251))
  const base64 = synthetic.toString('base64')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const fingerprints = { files: new Set(), base64: new Set([hash(base64)]), pcm: new Set([hash(synthetic)]) }
  assert.equal(legacyEvidence(Buffer.from(`const renamed = "${base64}";`), fingerprints), true)
  assert.equal(legacyEvidence(synthetic, fingerprints), true)
  assert.equal(legacyEvidence(Buffer.from('ordinary synthesis source'), fingerprints), false)
  assert.equal(legacyEvidence(synthetic), false)
})

test('default audit requires a build, PWA cannot reference absent assets, and non-executable launchers fail', async t => {
  const f = await fixture(t)
  await f.write('dist/pwa-build.json', JSON.stringify({ files: ['index.html', '../library-index.json'] }))
  await fs.chmod(path.join(f.root, '启动音乐播放器.command'), 0o644)
  let report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('离线清单')))
  assert.ok(report.errors.some(error => error.includes('可执行权限')))
  await fs.rm(path.join(f.root, 'dist'), { recursive: true })
  report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('先运行 npm run build')))
})

test('private exports cannot hide under approved documentation filenames and a failed check creates no ZIP', async t => {
  const f = await fixture(t)
  await f.write('docs/album-introductions/agent.md', '<!-- RHINE_ALBUM_TASK -->\n```json\n{"albums":[]}\n```\n<!-- /RHINE_ALBUM_TASK -->')
  await f.write('content/archives.json', JSON.stringify({ format: 'rhine-album-introductions-result', version: 1, albums: [] }))
  const report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('静态文档混入')))
  assert.ok(report.errors.some(error => error.includes('静态 JSON 混入')))
  const output = path.join(f.root, 'release', 'must-not-exist.zip')
  await assert.rejects(createSourceZip(f.root, output), /分发检查未通过/)
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
})

test('dist symlinks and escaping offline-cache paths are rejected without following them', async t => {
  const f = await fixture(t)
  await fs.symlink('../../package.json', path.join(f.root, 'dist', 'assets', 'linked-Abcdef12.js'))
  await f.write('dist/pwa-build.json', JSON.stringify({ files: ['/outside.json', '../outside.json', 'assets/../../outside.json'] }))
  const report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('linked-Abcdef12.js') && error.includes('符号链接')))
  assert.ok(report.errors.some(error => error.includes('离线清单')))
  assert.ok(!report.distFiles.includes('assets/linked-Abcdef12.js'))
})


test('removed assets and orphaned hashed bundles cannot return through a permissive filename rule', async t => {
  const f = await fixture(t)
  await f.write('dist/assets/unused-study-Abcdef12.js', 'export {};')
  await f.write('dist/assets/unused-study-Abcdef12.css', 'body {}')
  await f.write('dist/assets/music-case-v040.glb', 'SYNTHETIC OLD MODEL')
  await f.write('public/audio/observatory-preview.mp3', 'SYNTHETIC OLD PREVIEW')
  const report = await inspectDistribution(f.root)
  for (const file of ['unused-study-Abcdef12.js', 'unused-study-Abcdef12.css']) {
    assert.ok(report.errors.some(error => error.includes(file) && error.includes('孤立构建块')))
  }
  assert.equal(allowedDistributionPath('assets/music-case-v040.glb'), false)
  assert.equal(allowedDistributionPath('audio/observatory-preview.mp3'), false)
  assert.ok(report.errors.some(error => error.includes('observatory-preview.mp3')))
})

test('entry graph follows lazy chunks and their CSS; absent listed files and broken imports fail', async t => {
  const f = await fixture(t)
  await f.write('dist/assets/index-Abcdef12.js', ['void import', '("./lazy-Abcdef12.js"); const css = "assets/lazy-Abcdef12.css";'].join(''))
  await f.write('dist/assets/lazy-Abcdef12.js', 'export {};')
  await f.write('dist/assets/lazy-Abcdef12.css', 'body {}')
  assert.deepEqual((await inspectDistribution(f.root)).errors, [])
  await fs.unlink(path.join(f.root, 'dist/assets/lazy-Abcdef12.js'))
  await fs.unlink(path.join(f.root, 'scripts/check-interface-audio.mjs'))
  const report = await inspectDistribution(f.root)
  assert.ok(report.errors.some(error => error.includes('引用缺失的构建块')))
  assert.ok(report.errors.some(error => error.includes('check-interface-audio.mjs') && error.includes('缺少')))
})

test('real ZIP round trip preserves the exact source set, UTF-8 launcher names, bytes and permissions; existing outputs are never replaced', async t => {
  const f = await fixture(t)
  const launchers = requiredSourceFiles.filter(file => file.endsWith('.command'))
  for (const file of launchers) await f.write(file, '#!/bin/sh\n# 合成启动器：仅供打包验证\nexit 0\n')
  const model = requiredSourceFiles.find(file => file.startsWith('public/') && file.endsWith('.glb'))
  const binary = Buffer.from([0, 1, 127, 128, 255, 10])
  await f.write(model, binary)
  await f.write(`dist/${model.slice(7)}`, binary)
  await f.write('node_modules/omit.txt', 'not distributed')
  const destination = path.join(f.root, 'release', '中文输出 path', 'source.zip')
  const previousLocale = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
  let result
  try {
    // Packaging must select its own UTF-8 locale on macOS, even from a C shell.
    process.env.LANG = process.env.LC_ALL = 'C'
    result = await createSourceZip(f.root, destination)
  } finally {
    for (const [key, value] of Object.entries(previousLocale)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assert.equal(result.files, requiredSourceFiles.length)
  const archive = await fs.readFile(destination)
  const digest = createHash('sha256').update(archive).digest('hex')
  assert.equal(result.sha256, digest)
  assert.equal(await fs.readFile(result.checksumFile, 'utf8'), `${digest}  source.zip\n`)

  // Read the ZIP directory itself, independently of locale-sensitive CLI text.
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0)
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const names = []
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50)
    const length = archive.readUInt16LE(offset + 28)
    const name = archive.subarray(offset + 46, offset + 46 + length).toString('utf8')
    if (!name.endsWith('/')) names.push(name)
    if (/[^\x00-\x7f]/.test(name)) {
      assert.ok(archive.readUInt16LE(offset + 8) & 0x800, `${name}: central UTF-8 flag`)
      const local = archive.readUInt32LE(offset + 42)
      assert.equal(archive.readUInt32LE(local), 0x04034b50)
      assert.ok(archive.readUInt16LE(local + 6) & 0x800, `${name}: local UTF-8 flag`)
      assert.equal(archive.subarray(local + 30, local + 30 + archive.readUInt16LE(local + 26)).toString('utf8'), name)
    }
    offset += 46 + length + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32)
  }
  assert.deepEqual(names.sort(), requiredSourceFiles.map(file => `V0.5.0/${file}`).sort())
  const extractors = [['unzip', ['-q', destination, '-d']]]
  if (process.platform === 'darwin') extractors.push(['/usr/bin/tar', ['-xf', destination, '-C']])
  for (const [index, [command, args]] of extractors.entries()) {
    const output = path.join(f.root, '.tools', `extract-${index}`)
    await fs.mkdir(output, { recursive: true })
    await execute(command, [...args, output])
    assert.deepEqual(await fs.readdir(output), ['V0.5.0'])
    const restored = path.join(output, 'V0.5.0')
    const report = await inspectDistribution(restored, { requireDist: false })
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.sourceFiles, [...requiredSourceFiles].sort())
    for (const file of requiredSourceFiles) {
      assert.deepEqual(await fs.readFile(path.join(restored, file)), await fs.readFile(path.join(f.root, file)), file)
      assert.equal((await fs.stat(path.join(restored, file))).mode & 0o777, (await fs.stat(path.join(f.root, file))).mode & 0o777, file)
    }
  }
  await assert.rejects(createSourceZip(f.root, destination), /已存在，不覆盖/)
  assert.deepEqual(await fs.readFile(destination), archive)
  const blocked = path.join(f.root, 'release', 'checksum-only.zip')
  await fs.writeFile(`${blocked}.sha256`, 'do not overwrite')
  await assert.rejects(createSourceZip(f.root, blocked), /已存在，不覆盖/)
  await assert.rejects(fs.stat(blocked), { code: 'ENOENT' })
  assert.equal(await fs.readFile(`${blocked}.sha256`, 'utf8'), 'do not overwrite')
  await assert.rejects(createSourceZip(f.root, path.join(f.root, 'release', 'wrong.txt')), /必须以 \.zip 结尾/)
})
