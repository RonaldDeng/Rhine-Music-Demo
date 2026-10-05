import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { browserInvocation, canonicalPath, npmInvocation, samePath } from './platform.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SERVICE_ID = 'rhine-local-music'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const exists = async (file) => fs.access(file).then(() => true, () => false)

export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number)
  return major === 20 ? minor >= 19 : major === 22 ? minor >= 12 : major > 22
}

function requestJson(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 1500 }, (response) => {
      const chunks = []
      let length = 0
      response.on('data', (chunk) => {
        length += chunk.length
        if (length > 16 * 1024 * 1024) return response.destroy(new Error('服务响应过大'))
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        resolve({ status: response.statusCode, body })
      })
    })
    request.on('timeout', () => request.destroy(new Error('服务响应超时')))
    request.on('error', reject)
  })
}

// Older running versions have no health endpoint. Verify both their executable
// script and working directory before using their legacy API as identification.
// Only macOS shipped such versions, so other platforms never need this probe.
export function sameLegacyProcess(port, projectDir, run = spawnSync) {
  if (process.platform !== 'darwin') return false
  const output = run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  const pids = [...new Set((output.stdout ?? '').trim().split(/\s+/))].filter((pid) => /^\d+$/.test(pid))
  return pids.some((pid) => {
    const cwd = run('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout ?? ''
    if (!cwd.split('\n').includes(`n${projectDir}`)) return false
    const command = (run('/bin/ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout ?? '').trim()
    const match = /^(?:\S*\/)?node\s+(.+)$/.exec(command)
    if (!match) return false
    return ['scripts/music-server.mjs', './scripts/music-server.mjs', path.join(projectDir, 'scripts/music-server.mjs')].some((script) => match[1] === script || match[1].startsWith(`${script} `))
  })
}

export async function probeMusicService(port, projectDir, { request = requestJson, legacy = sameLegacyProcess } = {}) {
  let response
  try { response = await request(port, '/api/health') } catch (error) {
    if (error.code === 'ECONNREFUSED') return { kind: 'free', port }
    return { kind: legacy(port, projectDir) ? 'starting' : 'occupied', port }
  }
  const health = response.body
  if (response.status === 200 && health?.service === SERVICE_ID && typeof health.projectDir === 'string' && samePath(health.projectDir, projectDir) && Number.isSafeInteger(health.pid)) return { kind: 'ours', port }
  if (!legacy(port, projectDir)) return { kind: 'occupied', port }
  try {
    const [config, library] = await Promise.all([request(port, '/api/config'), request(port, '/api/library')])
    if (config.status === 200 && Array.isArray(config.body?.roots) && library.status === 200 && library.body?.version === 1 && Array.isArray(library.body.albums) && Array.isArray(library.body.genres)) return { kind: 'ours', port }
  } catch {}
  return { kind: 'starting', port }
}

// skip: ports that looked free but could not be bound (reserved by Windows/Hyper-V, or taken a moment ago).
export async function choosePort(projectDir, probe = probeMusicService, preferred = 5175, skip = new Set()) {
  const ports = [...new Set([...Array.from({ length: 10 }, (_, index) => preferred + index), 5173])]
  const states = await Promise.all(ports.map((port) => probe(port, projectDir)))
  const ours = states.find((state) => state.kind === 'ours')
  if (ours) return ours
  if (states.some((state) => state.kind === 'starting')) throw new Error('本工程的音乐服务正在启动或暂时没有响应。请稍后再双击；启动器没有重启它。')
  const available = states.find((state) => state.kind === 'free' && state.port !== 5173 && !skip.has(state.port))
  if (!available && skip.size) throw new Error(`端口 ${preferred}–${preferred + 9} 都无法使用：被其他程序占用，或被系统保留（Windows 的 Hyper-V、WSL、Docker 会保留一段端口）。请关闭不需要的程序或重启电脑后重试；启动器不会结束这些进程。`)
  if (!available) throw new Error(`端口 ${preferred}–${preferred + 9} 均被其他程序占用。请关闭不需要的程序后重试；启动器不会结束这些进程。`)
  return available
}

async function runNpm(args, projectDir) {
  await new Promise((resolve, reject) => {
    const npm = npmInvocation(args)
    const child = spawn(npm.command, npm.args, { cwd: projectDir, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} 未完成（退出码 ${code}）。请查看上方信息后重试。`)))
  })
}

// production: only the runtime dependencies are required (prebuilt packages).
export async function dependenciesReady(projectDir, { production = false } = {}) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'))
    const lock = JSON.parse(await fs.readFile(path.join(projectDir, 'package-lock.json'), 'utf8'))
    const installed = JSON.parse(await fs.readFile(path.join(projectDir, 'node_modules/.package-lock.json'), 'utf8'))
    const sections = production ? ['dependencies'] : ['dependencies', 'devDependencies']
    for (const section of sections) {
      const declared = manifest[section] ?? {}, locked = lock.packages?.['']?.[section] ?? {}
      if (Object.keys(declared).length !== Object.keys(locked).length || Object.entries(declared).some(([name, version]) => locked[name] !== version)) return false
    }
    for (const name of Object.keys(production ? manifest.dependencies : { ...manifest.dependencies, ...manifest.devDependencies })) {
      const location = `node_modules/${name}`
      // Some dependencies are ESM-only or type declarations with no executable
      // entry point, so require.resolve(name) is not a valid install check.
      const actual = JSON.parse(await fs.readFile(path.join(projectDir, location, 'package.json'), 'utf8'))
      const expected = lock.packages?.[location]?.version
      if (!expected || actual.version !== expected || installed.packages?.[location]?.version !== expected) return false
    }
    for (const [location, expected] of Object.entries(lock.packages ?? {})) {
      if (!location || (!installed.packages?.[location] && expected.optional) || (production && expected.dev)) continue
      if (installed.packages?.[location]?.version !== expected.version || !await exists(path.join(projectDir, location, 'package.json'))) return false
    }
    if (!production && (!await exists(path.join(projectDir, 'node_modules/.bin/vite')) || !await exists(path.join(projectDir, 'node_modules/.bin/tsc')))) return false
    return true
  } catch { return false }
}

const TEXT_FILE = /\.(?:[cm]?[jt]s|json|css|html|svg|webmanifest|txt|md)$/i

export async function buildFingerprint(projectDir) {
  const hash = createHash('sha256')
  const roots = ['src', 'public', 'content', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/export-records.mjs', 'scripts/archive-content.mjs', 'scripts/build-pwa.mjs', 'scripts/pwa-worker.js']
  for (const entry of await fs.readdir(projectDir)) if (/^(?:vite\.config\.|tsconfig\.).+/.test(entry) && !roots.includes(entry)) roots.push(entry)
  async function append(relative) {
    const file = path.join(projectDir, relative)
    const stat = await fs.stat(file)
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(file)).sort()) await append(path.join(relative, entry))
    } else if (stat.isFile()) {
      // Separator and line-ending neutral so a Windows checkout (CRLF, backslashes)
      // fingerprints the same as the original sources.
      hash.update(relative.split(path.sep).join('/')).update('\0')
      if (TEXT_FILE.test(file)) hash.update(Buffer.from((await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n')))
      else for await (const chunk of createReadStream(file)) hash.update(chunk)
      hash.update('\0')
    }
  }
  for (const root of roots.sort()) if (await exists(path.join(projectDir, root))) await append(root)
  return hash.digest('hex')
}

async function distIntact(projectDir) {
  const index = path.join(projectDir, 'dist/index.html')
  if (!await exists(index)) return false
  const html = await fs.readFile(index, 'utf8')
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1])
  return assets.length > 0 && (await Promise.all(assets.map((asset) => exists(path.join(projectDir, 'dist', asset))))).every(Boolean)
}

export async function prepareBuild(projectDir) {
  if (!supportedNode(process.versions.node)) throw new Error(`当前 Node.js ${process.versions.node} 不满足要求。请安装 Node.js 22.12 或更新的 LTS 版本。`)
  const marker = path.join(projectDir, 'dist/.music-build.json')
  let previous
  try { previous = JSON.parse(await fs.readFile(marker, 'utf8')) } catch {}
  // Prebuilt release packages ship dist and runtime dependencies; they need no npm.
  if (previous?.prebuilt === true) {
    if (await dependenciesReady(projectDir, { production: true }) && await distIntact(projectDir)) return
    throw new Error('预编译包文件不完整。请重新解压完整的 Windows 压缩包后再启动。')
  }
  const npm = npmInvocation(['--version'])
  if (spawnSync(npm.command, npm.args, { stdio: 'ignore', windowsHide: true }).status !== 0) throw new Error('没有找到 npm。请重新安装包含 npm 的 Node.js LTS 版本。')
  if (!await dependenciesReady(projectDir)) {
    console.log('首次准备或依赖已更新：正在安装锁定版本的依赖（需要联网）…')
    await runNpm(['ci'], projectDir)
  }
  const fingerprint = await buildFingerprint(projectDir)
  const complete = previous?.fingerprint === fingerprint && await distIntact(projectDir)
  if (!complete) {
    console.log('正在构建播放器界面（完成后下次可直接启动）…')
    await runNpm(['run', 'build'], projectDir)
    await fs.writeFile(marker, JSON.stringify({ fingerprint: await buildFingerprint(projectDir), builtAt: new Date().toISOString() }, null, 2))
  }
}

const LOCK_STALE_MS = 30_000
const LOCK_HEARTBEAT_MS = 5_000
const GUARD_STALE_MS = 10_000
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }

async function inspectLock(file) {
  try {
    const stat = await fs.stat(file)
    let owner
    try { owner = JSON.parse(await fs.readFile(file, 'utf8')) } catch {}
    return { stat, owner }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A lock is stale when its owner process is gone, or when nobody has refreshed it
// for a long time (a crashed or killed launcher whose process id was reused, a
// power cut). A live launcher refreshes its lock, so a long npm install stays valid.
function lockState(lock, { alive, now, staleMs }) {
  const pid = lock.owner?.pid
  const valid = Number.isSafeInteger(pid) && pid > 0
  if (valid && !alive(pid)) return 'stale'
  if (now() - lock.stat.mtimeMs > staleMs) return 'stale'
  return valid ? 'live' : 'unready'
}

// Only the holder of the .takeover directory may delete a stale lock, and it deletes
// it only if it is still the very lock that was judged stale. Two launches that find
// the same dead lock therefore can never remove each other's new lock.
async function removeStaleLock(file, expected, now) {
  const guard = `${file}.takeover`
  try { await fs.mkdir(guard) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const stat = await fs.stat(guard).catch(() => null)
    // A takeover interrupted half way must not block every later launch.
    if (stat && now() - stat.mtimeMs <= GUARD_STALE_MS) throw new Error('另一个启动器正在准备播放器，请等待它完成。')
    await fs.rmdir(guard).catch(() => {})
    return
  }
  try {
    const current = await inspectLock(file)
    if (current && current.stat.mtimeMs === expected.stat.mtimeMs && current.owner?.token === expected.owner?.token) await fs.unlink(file)
  } finally { await fs.rmdir(guard).catch(() => {}) }
}

export async function startupLock(dataDir, { alive = pidAlive, now = Date.now, staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
  const file = path.join(dataDir, 'launcher.lock')
  const token = randomUUID()
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await fs.open(file, 'wx')
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await handle.close() }
      const heartbeat = setInterval(() => { const at = new Date(); fs.utimes(file, at, at).catch(() => {}) }, heartbeatMs)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        try {
          if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file)
        } catch {}
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const lock = await inspectLock(file)
      if (!lock) continue
      const state = lockState(lock, { alive, now, staleMs })
      if (state === 'unready') throw new Error(`启动锁尚未就绪。请稍后再次双击；如果持续出现，可删除 ${file} 后重试。`)
      if (state === 'live') throw new Error('另一个启动器正在准备播放器，请等待它完成。')
      await removeStaleLock(file, lock, now)
    }
  }
  throw new Error('无法取得启动锁，请稍后重试。')
}

// "listen EACCES" = port reserved by the system (Windows excluded port ranges); "listen EADDRINUSE" = taken meanwhile.
export const portFailure = (text) => /listen (?:EACCES|EADDRINUSE)\b/.test(text)

async function startOnAvailablePort(projectDir, dataDir, state, probe, start) {
  const unusable = new Set()
  while (state.kind !== 'ours') {
    try { await start(projectDir, dataDir, state.port); return state } catch (error) {
      if (error.code !== 'PORT_UNAVAILABLE') throw error
      unusable.add(state.port)
      console.log(`端口 ${state.port} 无法使用（被系统保留或刚被其他程序占用），改用下一个端口…`)
      state = await choosePort(projectDir, probe, undefined, unusable)
    }
  }
  return state
}

export async function startServer(projectDir, dataDir, port) {
  const logPath = path.join(dataDir, 'player-service.log')
  const logOffset = (await fs.stat(logPath).catch(() => null))?.size ?? 0
  const log = await fs.open(logPath, 'a')
  await log.write(`\n[${new Date().toISOString()}] 启动播放器，端口 ${port}\n`)
  let child
  let startupError
  try {
    child = spawn(process.execPath, [path.join(projectDir, 'scripts/music-server.mjs'), '--port', String(port)], {
      cwd: projectDir, detached: true, windowsHide: true,
      env: { ...process.env, MUSIC_DATA_DIR: dataDir },
      stdio: ['ignore', log.fd, log.fd],
    })
    child.once('error', (error) => { startupError = error })
  } finally { await log.close() }
  child.unref()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || child.exitCode !== null || child.signalCode) break
    const state = await probeMusicService(port, projectDir)
    if (state.kind === 'ours') {
      console.log(`服务日志：${logPath}`)
      return
    }
    await wait(250)
  }
  const logBytes = await fs.readFile(logPath)
  if (child.exitCode !== null && portFailure(logBytes.subarray(logOffset).toString('utf8'))) throw Object.assign(new Error(`端口 ${port} 无法使用。`), { code: 'PORT_UNAVAILABLE', port })
  const tail = logBytes.toString('utf8').split('\n').slice(-16).join('\n')
  throw new Error(`播放器尚未就绪。${startupError?.message ?? ''}\n日志：${logPath}\n${tail}`)
}

function openBrowser(url) {
  if (process.env.RHINE_NO_BROWSER) return console.log(`已按 RHINE_NO_BROWSER 跳过自动打开浏览器：${url}`)
  const { command, args } = browserInvocation(url)
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) console.log(`浏览器未自动打开，请手动访问：${url}`)
}

export async function launchMusic({ projectDir = PROJECT_DIR, dataDir, probe = probeMusicService, prepare = prepareBuild, start = startServer, open = openBrowser } = {}) {
  projectDir = canonicalPath(await fs.realpath(projectDir))
  dataDir = path.resolve(projectDir, dataDir ?? process.env.MUSIC_DATA_DIR ?? '../music-data-v3')
  let state = await choosePort(projectDir, probe)
  if (state.kind !== 'ours') {
    await fs.mkdir(dataDir, { recursive: true })
    const release = await startupLock(dataDir)
    try {
      state = await choosePort(projectDir, probe)
      if (state.kind !== 'ours') {
        await prepare(projectDir)
        state = await choosePort(projectDir, probe)
        state = await startOnAvailablePort(projectDir, dataDir, state, probe, start)
      }
    } finally { await release() }
  }
  const url = `http://127.0.0.1:${state.port}/`
  console.log(`${state.kind === 'ours' ? '播放器已在运行，直接打开' : '播放器已启动'}：${url}`)
  await open(url)
  console.log('现在可以关闭此终端窗口；播放器服务会在后台继续运行。')
  return { url, port: state.port, reused: state.kind === 'ours' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchMusic().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1 })
}
