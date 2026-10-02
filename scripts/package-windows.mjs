// Builds the Windows release: a portable, prebuilt package with its own Node.js
// runtime plus "Rhine Music.exe". Windows 10 or newer; run it on Windows.
//
//   node scripts/package-windows.mjs [--node-version 22.x.y] [--skip-build] [--keep-staging]
//
// Output (git-ignored): release/Rhine-Music-Demo-v<version>-Windows.zip, its .sha256,
// and release/Rhine Music.exe. Downloaded Node.js archives are cached in .tools/.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { npmInvocation } from './platform.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf8'))
const VERSION = manifest.version
const RELEASE_DIR = path.join(PROJECT_DIR, 'release')
const TOOLS_DIR = path.join(PROJECT_DIR, '.tools')
const STAGING_ROOT = path.join(RELEASE_DIR, '.staging')
const PACKAGE_DIR_NAME = `V${VERSION}`
const ZIP_NAME = `Rhine-Music-Demo-v${VERSION}-Windows.zip`
// Runtime files the music service loads; the front end ships prebuilt in dist/.
const RUNTIME_SCRIPTS = ['launch-music.mjs', 'music-server.mjs', 'music-library.mjs', 'album-introductions.mjs', 'online-sources.mjs', 'platform.mjs']

const log = (message) => console.log(`[package-windows] ${message}`)
const exists = (file) => fs.access(file).then(() => true, () => false)

if (process.platform !== 'win32') throw new Error('Windows 安装包只能在 Windows 上构建（需要 .NET Framework 编译器和 tar.exe）。')

function run(command, commandArgs, { cwd = PROJECT_DIR, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} ${commandArgs.join(' ')} 失败（退出码 ${code}）\n${output}`)))
  })
}
const npm = (npmArgs, cwd) => { const { command, args: a } = npmInvocation(npmArgs); return run(command, a, { cwd }) }

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, target) {
  log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`)
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
}

async function nodeRuntime() {
  let version = option('--node-version')?.replace(/^v/, '')
  if (!version) {
    const index = await (await fetch('https://nodejs.org/dist/index.json')).json()
    // Node 22 is the oldest line this project supports on Windows 10 and is in maintenance LTS.
    version = index.find((entry) => entry.version.startsWith('v22.') && entry.lts)?.version.slice(1)
    if (!version) throw new Error('无法确定 Node.js 22 LTS 版本，请使用 --node-version 指定。')
  }
  const name = `node-v${version}-win-x64`
  const archive = path.join(TOOLS_DIR, `${name}.zip`)
  await fs.mkdir(TOOLS_DIR, { recursive: true })
  const sums = await (await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)).text()
  const expected = sums.split('\n').find((line) => line.trim().endsWith(`${name}.zip`))?.split(/\s+/)[0]
  if (!expected) throw new Error(`SHASUMS256.txt 中没有 ${name}.zip`)
  if (!await exists(archive) || await sha256(archive) !== expected) {
    await download(`https://nodejs.org/dist/v${version}/${name}.zip`, archive)
    if (await sha256(archive) !== expected) throw new Error('Node.js 压缩包校验失败，已中止。')
  }
  log(`Node.js v${version}（SHA-256 已校验）`)
  const extracted = path.join(TOOLS_DIR, name)
  if (!await exists(path.join(extracted, 'node.exe'))) await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', TOOLS_DIR])
  return { version, directory: extracted }
}

async function compileLauncher(target) {
  const framework = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET')
  const csc = [path.join(framework, 'Framework64/v4.0.30319/csc.exe'), path.join(framework, 'Framework/v4.0.30319/csc.exe')].find(existsSync)
  if (!csc) throw new Error('找不到 .NET Framework 4 的 csc.exe（Windows 10/11 自带，请检查系统组件）。')
  const windows = path.join(PROJECT_DIR, 'windows')
  if (!await exists(path.join(windows, 'app.ico'))) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(windows, 'make-icon.ps1')])
  await run(csc, ['-nologo', '-target:winexe', '-optimize+', '-codepage:65001', `-win32icon:${path.join(windows, 'app.ico')}`, `-win32manifest:${path.join(windows, 'app.manifest')}`, '-r:System.Windows.Forms.dll', `-out:${target}`, path.join(windows, 'RhineMusic.cs')])
  log(`已编译 ${path.basename(target)}`)
}

async function copyInto(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true })
}

async function main() {
  await fs.rm(STAGING_ROOT, { recursive: true, force: true })
  const staging = path.join(STAGING_ROOT, PACKAGE_DIR_NAME)
  await fs.mkdir(staging, { recursive: true })
  await fs.mkdir(RELEASE_DIR, { recursive: true })

  if (!args.includes('--skip-build')) {
    log('安装依赖并构建界面…')
    await npm(['ci'], PROJECT_DIR)
    await npm(['run', 'build'], PROJECT_DIR)
  }
  if (!await exists(path.join(PROJECT_DIR, 'dist/index.html'))) throw new Error('缺少 dist/，请先运行 npm run build。')

  log('整理运行文件…')
  await copyInto(path.join(PROJECT_DIR, 'dist'), path.join(staging, 'dist'))
  await fs.writeFile(path.join(staging, 'dist/.music-build.json'), `${JSON.stringify({ prebuilt: true, platform: 'win32-x64', version: VERSION, builtAt: new Date().toISOString() }, null, 2)}\n`)
  for (const script of RUNTIME_SCRIPTS) await copyInto(path.join(PROJECT_DIR, 'scripts', script), path.join(staging, 'scripts', script))
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE.md', '启动音乐播放器.bat']) await copyInto(path.join(PROJECT_DIR, file), path.join(staging, file))
  await copyInto(path.join(PROJECT_DIR, 'windows/README-Windows.txt'), path.join(staging, '使用说明-Windows.txt'))

  log('安装生产依赖（npm ci --omit=dev）…')
  await npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging)

  const runtime = await nodeRuntime()
  await copyInto(path.join(runtime.directory, 'node.exe'), path.join(staging, 'runtime/node.exe'))
  await copyInto(path.join(runtime.directory, 'LICENSE'), path.join(staging, 'runtime/LICENSE-Node.js.txt'))
  await fs.writeFile(path.join(staging, 'runtime/README.txt'), `Node.js v${runtime.version} (win-x64), unmodified, from https://nodejs.org/\r\nSHA-256 of the official archive was verified at build time.\r\n`)

  await compileLauncher(path.join(staging, 'Rhine Music.exe'))
  await fs.copyFile(path.join(staging, 'Rhine Music.exe'), path.join(RELEASE_DIR, 'Rhine Music.exe'))

  log(`压缩为 ${ZIP_NAME}…`)
  const zip = path.join(RELEASE_DIR, ZIP_NAME)
  await fs.rm(zip, { force: true })
  await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', STAGING_ROOT, PACKAGE_DIR_NAME])
  const digest = await sha256(zip)
  await fs.writeFile(`${zip}.sha256`, `${digest}  ${ZIP_NAME}\n`)
  if (!args.includes('--keep-staging')) await fs.rm(STAGING_ROOT, { recursive: true, force: true })
  const size = (await fs.stat(zip)).size
  log(`完成：${zip}\n  大小 ${(size / 1048576).toFixed(1)} MB\n  SHA-256 ${digest}`)
}

main().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1 })
