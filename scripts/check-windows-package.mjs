// End-to-end smoke test of the Windows release package (run after `npm run package:windows`).
//
//   node scripts/check-windows-package.mjs [path-to-zip]
//
// Simulates a PC without Node.js: extracts the zip into a folder with Chinese characters,
// spaces and parentheses, starts "Rhine Music.exe" with a PATH that contains no node,
// then checks scanning, ranged audio, artwork, service reuse and port fallback.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { samePath } from './platform.mjs'

if (process.platform !== 'win32') throw new Error('只能在 Windows 上运行。')
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version
const zip = path.resolve(process.argv[2] ?? path.join(PROJECT_DIR, 'release', `Rhine-Music-Demo-v${version}-Windows.zip`))
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const portFree = (port) => new Promise((resolve) => { const probe = http.createServer(); probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true))) })
const steps = []
const ok = (message) => { steps.push(message); console.log(`  ✔ ${message}`) }

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine 验证 (包) '))
const pkg = path.join(base, `V${version}`)
const dataDir = path.join(base, 'music-data-v3')
const library = path.join(base, '我的 音乐 (测试)')
const killers = new Set()
let blocker

function wav(seconds = 1) {
  const rate = 8000, samples = rate * seconds, data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function put(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function launchExe(extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'music_data_dir', 'music_roots'].includes(key.toLowerCase())))
  Object.assign(env, { PATH: system32, RHINE_NO_BROWSER: '1', MUSIC_DATA_DIR: dataDir, MUSIC_ROOTS: library, ...extraEnv })
  return await new Promise((resolve, reject) => {
    const child = spawn(path.join(pkg, 'Rhine Music.exe'), [], { cwd: os.tmpdir(), env, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Rhine Music.exe 超过 90 秒未退出')) }, 90000)
    child.once('error', reject)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return response.status === 200 ? await response.json() : undefined
  } catch { return undefined }
}

async function findService(ports = Array.from({ length: 10 }, (_, index) => 5175 + index)) {
  for (const port of ports) { const body = await health(port); if (body?.service === 'rhine-local-music' && samePath(body.projectDir, pkg)) return { port, ...body } }
}

const stop = (pid) => spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })

try {
  console.log(`包：${zip}\n临时目录：${base}`)
  await fs.access(zip)
  const extract = spawnSync(path.join(system32, 'tar.exe'), ['-xf', zip, '-C', base], { encoding: 'utf8' })
  assert.equal(extract.status, 0, extract.stderr)
  for (const file of ['Rhine Music.exe', '启动音乐播放器.bat', '使用说明-Windows.txt', 'runtime/node.exe', 'dist/index.html', 'dist/.music-build.json', 'scripts/launch-music.mjs', 'scripts/online-sources.mjs', 'node_modules/music-metadata/package.json', 'LICENSE']) await fs.access(path.join(pkg, file))
  const names = new Set(await fs.readdir(pkg))
  for (const unwanted of ['src', 'public', 'AGENTS.md', 'verification', 'reference']) assert.ok(!names.has(unwanted), `包内不应含 ${unwanted}`)
  ok('解压到含中文、空格、括号的目录，文件齐全，且不含源码与开发资料')

  await put(path.join(library, '单曲 一.wav'), wav())
  await put(path.join(library, '专辑 甲 (Deluxe)', '01 开场.wav'), wav())
  await put(path.join(library, '专辑 甲 (Deluxe)', '02 终章.wav'), wav(2))
  await put(path.join(library, '专辑 甲 (Deluxe)', '._01 开场.wav'), 'appledouble')
  await put(path.join(library, '$RECYCLE.BIN', 'S-1-5', 'junk.wav'), wav())
  await fs.copyFile(path.join(PROJECT_DIR, 'public/icons/icon-192.png'), path.join(library, '专辑 甲 (Deluxe)', 'cover.png'))

  if (!await portFree(5175)) throw new Error('端口 5175 已被占用（可能是另一份正在运行的播放器）。冒烟测试需要 5175 空闲：请先关闭它再运行，测试不会去结束别人的进程。')
  const code = await launchExe()
  assert.equal(code, 0, `Rhine Music.exe 退出码 ${code}`)
  const service = await findService()
  assert.ok(service, '没有找到本包的音乐服务')
  killers.add(service.pid)
  assert.equal(service.port, 5175, `默认应使用 5175，实际 ${service.port}`)
  ok(`无 Node.js 的 PATH 下，exe 启动服务成功（端口 ${service.port}，PID ${service.pid}）`)

  const window = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${service.pid}).MainWindowHandle`], { encoding: 'utf8' })
  assert.equal(window.stdout.trim(), '0', '后台服务不应有窗口')
  ok('后台服务没有控制台窗口')

  let snapshot
  for (let attempt = 0; attempt < 60; attempt++) {
    snapshot = await (await fetch(`http://127.0.0.1:${service.port}/api/library`)).json()
    if (snapshot.albums?.length && !snapshot.scan?.running) break
    await wait(500)
  }
  assert.equal(snapshot.albums.length, 2, `应有 2 张专辑，实际 ${snapshot.albums.length}`)
  const tracks = snapshot.albums.flatMap((album) => album.tracks)
  assert.deepEqual(tracks.map((track) => path.basename(track.relativePath)).sort(), ['01 开场.wav', '02 终章.wav', '单曲 一.wav'].sort())
  ok('扫描中文/空格/括号目录：2 张专辑、3 首曲目，回收站与 ._ 文件被忽略')

  const album = snapshot.albums.find((entry) => entry.tracks.length === 2)
  const track = tracks.find((entry) => entry.relativePath.endsWith('02 终章.wav'))
  const range = await fetch(`http://127.0.0.1:${service.port}/api/audio/${track.id}`, { headers: { Range: 'bytes=100-199' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range')?.startsWith('bytes 100-199/'), true)
  assert.equal((await range.arrayBuffer()).byteLength, 100)
  const whole = await fetch(`http://127.0.0.1:${service.port}/api/audio/${track.id}`)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  ok('音频 Range 请求（拖动进度所需）返回 206，整段返回 200')

  const origin = `http://127.0.0.1:${service.port}`
  const onlineShelf = await (await fetch(`${origin}/api/online/library`)).json()
  assert.deepEqual([onlineShelf.albums, onlineShelf.roots], [[], []])
  const onlineSources = await (await fetch(`${origin}/api/online/sources`)).json()
  assert.equal(onlineSources.sources.find((source) => source.id === 'subsonic').configured, false)
  assert.equal((await fetch(`${origin}/api/online/audio/onlinetrack-unknown`)).status, 404)
  ok('在线专辑架接口可用，默认为空，未配置自有音乐服务（不联网）')

  assert.ok(album.coverUrl, '文件夹封面 cover.png 应被识别')
  const artwork = await fetch(`http://127.0.0.1:${service.port}${album.coverUrl}`)
  assert.equal(artwork.status, 200)
  assert.equal(artwork.headers.get('content-type'), 'image/png')
  const page = await fetch(`http://127.0.0.1:${service.port}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id=/)
  for (const url of ['/index.html::$DATA', '/C:/Windows/win.ini', '/..%5Cpackage.json']) assert.equal((await fetch(`http://127.0.0.1:${service.port}${url}`)).status, 400, url)
  ok('前端页面可访问；NTFS 数据流、盘符和反斜杠路径被拒绝')

  assert.equal(await launchExe(), 0)
  const again = await findService()
  assert.equal(again.pid, service.pid, '第二次启动应复用同一服务')
  ok('再次双击 exe：复用同一服务，不重复启动')

  const unc = `\\\\localhost\\${library[0]}$\\${library.slice(3)}`
  const uncReadable = await fs.access(unc).then(() => true, () => false)
  if (uncReadable) {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: [`"${unc}"`] }) })
    assert.equal(response.status, 200, await response.text())
    await fetch(`http://127.0.0.1:${service.port}/api/library/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    let uncSnapshot
    for (let attempt = 0; attempt < 60; attempt++) {
      uncSnapshot = await (await fetch(`http://127.0.0.1:${service.port}/api/library`)).json()
      if (uncSnapshot.albums?.length === 2 && !uncSnapshot.scan?.running) break
      await wait(500)
    }
    assert.equal(uncSnapshot.albums.length, 2, 'UNC 路径扫描失败')
    const uncTrack = uncSnapshot.albums.flatMap((entry) => entry.tracks)[0]
    assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/audio/${uncTrack.id}`, { headers: { Range: 'bytes=0-9' } })).status, 206)
    ok('UNC 路径（\\\\localhost\\盘符$\\…，含引号）可保存、扫描并播放')
  } else console.log('  - 跳过 UNC 检查：当前账户无法访问管理共享')

  stop(service.pid)
  await wait(1000)
  assert.equal(await health(5175), undefined)
  blocker = http.createServer((_, response) => response.end('<html>other app</html>'))
  await new Promise((resolve) => blocker.listen(5175, '127.0.0.1', resolve))
  assert.equal(await launchExe(), 0)
  const moved = await findService()
  assert.ok(moved && moved.port === 5176, `端口被占用时应顺延到 5176，实际 ${moved?.port}`)
  killers.add(moved.pid)
  ok('5175 被其他程序占用时，自动顺延到 5176，不动别人的进程')

  console.log(`\n全部通过（${steps.length} 项）。`)
} catch (error) {
  console.error(`\n✖ 失败：${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  blocker?.close()
  for (const pid of killers) stop(pid)
  await wait(800)
  await fs.rm(base, { recursive: true, force: true }).catch((error) => console.log(`清理临时目录失败（可手动删除）：${base}\n${error.message}`))
}
