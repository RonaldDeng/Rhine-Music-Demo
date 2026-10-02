import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  browserInvocation, canonicalPath, cleanRootInput, isFullyQualified, isIgnoredDirectory, isIgnoredFile,
  isInside, isWindows, npmInvocation, pathKey, renameWithRetry, samePath,
} from './platform.mjs'
import { safeRootList, walkAlbums } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'

test('Windows paths compare case-insensitively and across separators', () => {
  assert.equal(samePath('D:\\Music', 'd:/music/', 'win32'), true)
  assert.equal(samePath('D:\\Music', 'D:\\Music2', 'win32'), false)
  assert.equal(pathKey('C:\\A\\b', 'win32'), 'c:\\a\\b')
  assert.equal(samePath('/Music', '/music', 'linux'), false)
})

test('isInside follows nesting, not string prefixes or drives', () => {
  assert.equal(isInside('D:\\Music', 'd:\\music\\Live\\2024', 'win32'), true)
  assert.equal(isInside('D:\\Music', 'D:\\Music', 'win32'), true)
  assert.equal(isInside('D:\\Music', 'D:\\Music2', 'win32'), false)
  assert.equal(isInside('D:\\Music', 'E:\\Music\\Live', 'win32'), false)
  assert.equal(isInside('D:\\', 'D:\\Music', 'win32'), true)
  assert.equal(isInside('/a/b', '/a/bc', 'linux'), false)
  assert.equal(isInside('/a/b', '/a/b/c', 'linux'), true)
})

test('fully qualified Windows paths: drive and UNC accepted; drive-relative and root-relative rejected', () => {
  for (const ok of ['C:\\Music', 'c:/Music', 'D:\\音乐 与 空格', '\\\\nas\\share\\Music']) assert.equal(isFullyQualified(ok, 'win32'), true, ok)
  for (const bad of ['C:Music', '\\Music', 'Music', '..\\Music', '\\\\?\\C:\\Music', '\\\\.\\pipe\\x', '', 'C:\\Mu\0sic']) assert.equal(isFullyQualified(bad, 'win32'), false, bad)
  assert.equal(isFullyQualified('/Users/me/Music', 'darwin'), true)
  assert.equal(isFullyQualified('Music', 'darwin'), false)
})

test('quotes from Explorer "Copy as path" are accepted, other input is only trimmed', () => {
  assert.equal(cleanRootInput('  "D:\\My Music"  '), 'D:\\My Music')
  assert.equal(cleanRootInput("'/Users/me/Music'"), '/Users/me/Music')
  assert.equal(cleanRootInput('D:\\Music'), 'D:\\Music')
  assert.equal(cleanRootInput('"unbalanced'), '"unbalanced')
  assert.equal(cleanRootInput(5), 5)
})

test('canonicalPath strips the long-path prefix and upper-cases the drive letter', () => {
  assert.equal(canonicalPath('\\\\?\\c:\\Users\\me', 'win32'), 'C:\\Users\\me')
  assert.equal(canonicalPath('\\\\?\\UNC\\nas\\share\\x', 'win32'), '\\\\nas\\share\\x')
  assert.equal(canonicalPath('c:\\Users\\中文 目录', 'win32'), 'C:\\Users\\中文 目录')
})

test('npm is started without a shell on Windows when npm-cli.js exists, else through cmd.exe', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmInvocation(['ci'], { platform: 'win32', execPath, env: {}, exists: (file) => file === cli }), { command: execPath, args: [cli, 'ci'] })
  const viaEnv = 'D:\\tools\\npm\\bin\\npm-cli.js'
  assert.deepEqual(npmInvocation(['run', 'build'], { platform: 'win32', execPath, env: { npm_execpath: viaEnv }, exists: (file) => file === viaEnv }), { command: execPath, args: [viaEnv, 'run', 'build'] })
  assert.deepEqual(npmInvocation(['--version'], { platform: 'win32', execPath, env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, exists: () => false }), { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'npm', '--version'] })
  assert.deepEqual(npmInvocation(['ci'], { platform: 'darwin' }), { command: 'npm', args: ['ci'] })
})

test('browser launch command per platform', () => {
  assert.deepEqual(browserInvocation('http://127.0.0.1:5175/', 'win32'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:5175/'] })
  assert.equal(browserInvocation('http://x/', 'darwin').command, '/usr/bin/open')
  assert.equal(browserInvocation('http://x/', 'linux').command, 'xdg-open')
})

test('system folders and AppleDouble sidecars are never scanned', () => {
  for (const name of ['$RECYCLE.BIN', '$Recycle.Bin', 'System Volume Information', '.hidden', '.Trashes']) assert.equal(isIgnoredDirectory(name), true, name)
  for (const name of ['Album', '周杰伦', 'Music 2024']) assert.equal(isIgnoredDirectory(name), false, name)
  assert.equal(isIgnoredFile('._01 Intro.mp3'), true)
  assert.equal(isIgnoredFile('01 Intro.mp3'), false)
})

test('rename is retried only for transient Windows errors', async () => {
  let calls = 0
  const flaky = async () => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }) }
  await renameWithRetry('a', 'b', { rename: flaky, platform: 'win32', delay: 1 })
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(renameWithRetry('a', 'b', { rename: flaky, platform: 'darwin', delay: 1 }), { code: 'EPERM' })
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(renameWithRetry('a', 'b', { rename: async () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, platform: 'win32', delay: 1 }), { code: 'ENOENT' })
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(renameWithRetry('a', 'b', { rename: async () => { calls++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }) }, platform: 'win32', delay: 1, retries: 2 }), { code: 'EBUSY' })
  assert.equal(calls, 3)
})

test('safeRootList validates, de-duplicates and removes nested roots on this platform', { skip: !isWindows }, () => {
  assert.deepEqual(safeRootList(['D:\\Music', 'd:\\music\\Live', 'D:/MUSIC/', '"E:\\音乐 与 空格"']), ['D:\\Music', 'E:\\音乐 与 空格'])
  assert.deepEqual(safeRootList(['D:\\Music', 'D:\\Music2']), ['D:\\Music', 'D:\\Music2'])
  for (const bad of [['\\Users\\me'], ['D:Music'], ['Music'], [''], 'D:\\Music', [5]]) assert.throws(() => safeRootList(bad), /绝对路径/)
})

test('safeRootList keeps POSIX behaviour', { skip: isWindows }, () => {
  assert.deepEqual(safeRootList(['/music', '/music/live', '/music2', '"/other dir"']), ['/music', '/music2', '/other dir'])
  assert.throws(() => safeRootList(['music']), /绝对路径/)
})

test('album scan skips recycle bin, hidden folders, AppleDouble files and unreadable names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-platform-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const file of ['单曲.mp3', 'Album 一/01 开场.mp3', 'Album 一/._01 开场.mp3', 'Album 一/02.flac', '$RECYCLE.BIN/S-1/junk.mp3', 'System Volume Information/x.mp3', '.hidden/secret.mp3', 'Album 一/子 目录/03.mp3']) {
    const full = path.join(root, file)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, 'x')
  }
  const found = (await walkAlbums(root)).map((entry) => ({ folder: path.relative(root, entry.folder), tracks: entry.tracks.map((track) => path.basename(track)) }))
  assert.deepEqual(found.sort((a, b) => a.folder.localeCompare(b.folder)), [
    { folder: '', tracks: ['单曲.mp3'] },
    { folder: 'Album 一', tracks: ['01 开场.mp3', '02.flac'] },
    { folder: path.join('Album 一', '子 目录'), tracks: ['03.mp3'] },
  ])
})

async function serverRequest(server, url, headers = { host: '127.0.0.1:5175' }) {
  return new Promise((resolve) => {
    let status
    server.emit('request', { method: 'GET', url, headers }, { setHeader() {}, headersSent: false, writeHead(value) { status = value }, end(body) { resolve({ status, body }) }, destroy() { resolve({ status: 'destroyed' }) } })
  })
}

test('server rejects NTFS stream and drive-qualified routes on Windows', { skip: !isWindows }, async () => {
  const { server } = await createMusicServer({ store: {}, autoScan: false })
  for (const url of ['/index.html::$DATA', '/assets/x.js:stream', '/C:/Windows/win.ini', '/..%5Cpackage.json']) assert.equal((await serverRequest(server, url)).status, 400, url)
  assert.equal((await serverRequest(server, '/api/health')).status, 200)
})

test('server never serves files outside dist for traversal attempts', async () => {
  const { server } = await createMusicServer({ store: {}, autoScan: false })
  for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json', '/..%2Fpackage.json']) {
    const { status } = await serverRequest(server, url)
    assert.ok([400, 403, 404].includes(status), `${url} -> ${status}`)
  }
})
