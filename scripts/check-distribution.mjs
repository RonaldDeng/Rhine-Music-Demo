/** Read-only by default. --zip creates a local source archive; never uploads or publishes. */
import { constants, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await fs.readFile(new URL('./distribution-files.json', import.meta.url), 'utf8'))
export const allowedSourceFiles = Object.freeze([...manifest.files])
const allowed = new Set(allowedSourceFiles)
const sourceDirectories = new Set(allowedSourceFiles.flatMap(file => {
  const parts = file.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}))
const localOnlyDirectories = new Set(['node_modules', '.git', '.tools', 'release'])
const publicFiles = allowedSourceFiles.filter(file => file.startsWith('public/'))
const publicPaths = new Set(publicFiles.map(file => file.slice('public/'.length)))
// Every reviewed entry must exist. Deleted historical files cannot remain as
// dormant allowances that silently permit their return in a future package.
export const requiredSourceFiles = allowedSourceFiles
const requiredDistFiles = ['index.html', 'manifest.webmanifest', 'favicon.svg', 'sw.js', 'pwa-build.json']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const exampleUsers = new Set(['username', 'your-user', 'example', '你的用户名'])
const hasPersonalPath = text => [...text.matchAll(/\/(?:Users|home)\/([^\s/'"<>]+)\//g)].some(match => !exampleUsers.has(match[1]))
const hasCredential = text => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)

// Only fingerprints are retained. No original recording or sample payload is a test fixture.
const legacyFileHashes = new Set([
  'c3692433e5dd34dc4b65b78b149932ee6132250c0120254f996a4a9ec94599a8',
  '89eb2ed9de5da1ca0cce7332ad736c46a7677cee14a09c066f96c58b4c25b5ff',
])
const legacyBase64Hashes = new Set([
  '1cb30f2fcd21d0a910358f3dfbbe9c8db29dd30b3d3cfaf65b7b27cc63ac9647',
  '39619ad12b2fbecf0131047e2dbbce8da86813cf2e5ab5baac3d90730b177031',
  'acfddc48a65e2330a10ade4b50ace880785e9343a1d3c70cf0e6ac563596553f',
])
const legacyPcmHashes = new Set([
  'a367c5aeb310fe005f3ca9e5dc064f097193d1f001f9307f2ffa1af26f58bc92',
  '257839b5b849654392d6d01794c7ea07699128ff6c23430ab55767b7b33d12e6',
  '9fc32c0ac0302e3524997dbe32e65f385cd5273e905d3e7720178b3ea3c806b1',
])

export function legacyEvidence(bytes, fingerprints = {}) {
  const fileHashes = fingerprints.files ?? legacyFileHashes
  const base64Hashes = fingerprints.base64 ?? legacyBase64Hashes
  const pcmHashes = fingerprints.pcm ?? legacyPcmHashes
  if (fileHashes.has(sha256(bytes)) || pcmHashes.has(sha256(bytes))) return true
  for (const match of bytes.toString('utf8').matchAll(/[A-Za-z0-9+/]{256,}={0,2}/g)) {
    if (base64Hashes.has(sha256(match[0])) || pcmHashes.has(sha256(Buffer.from(match[0], 'base64')))) return true
  }
  return false
}

function forbiddenPath(file) {
  return /^(?:public\/)?(?:assets\/(?:music-case-v040|music-cd)\.glb|audio\/(?:observatory-preview\.mp3|score\.json))$/.test(file)
    || /(?:^|\/)(?:music-data[^/]*|artwork|private(?:-[^/]*)?|promo|lighting-reference|motion-research)(?:\/|$)/i.test(file)
    || /(?:^|\/)(?:library-index|genre-rules|config|private-manifest|introductions-result)(?:[.-]|$)/i.test(file)
    || /(?:^|\/)(?:typing-(?:samples|preview|source|original)|extract-typing-audio|analyze-reference-audio|promo-[^/]*|film-review)(?:[./-]|$)/i.test(file)
    || /(?:^|\/)\.env(?:\.|$)|\.(?:mp4|mov|flac|m4a|aac|ape|dsf|dff|log|backup|blend1)$/i.test(file)
}

export function allowedDistributionPath(file) {
  return !forbiddenPath(file) && (publicPaths.has(file)
    || requiredDistFiles.includes(file)
    || /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(file))
}

/** Errors identify paths and categories only; never print a credential or private file contents. */
export async function inspectDistribution(root, { requireDist = true } = {}) {
  root = path.resolve(root)
  const errors = [], sourceFiles = [], distFiles = [], omittedDirectories = []
  const fail = (file, reason) => errors.push(`${file}: ${reason}`)
  async function walk(directory, prefix, kind) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (/[^\S ]|[\x00-\x1f\x7f]/.test(entry.name)) { fail(relative, '文件名含控制字符'); continue }
      if (kind === 'source' && !prefix && localOnlyDirectories.has(entry.name)) { omittedDirectories.push(entry.name); continue }
      if (kind === 'source' && !prefix && entry.name === 'dist') continue
      if (entry.isSymbolicLink()) { fail(relative, '不允许符号链接'); continue }
      if (entry.name === '.DS_Store' && kind === 'source') continue
      if (forbiddenPath(relative)) { fail(relative, '含私人数据、原片素材或已移除采样路径'); continue }
      if (entry.isDirectory()) {
        const permitted = kind === 'source' ? sourceDirectories.has(relative)
          : [...publicPaths, ...requiredDistFiles].some(file => file.startsWith(`${relative}/`)) || relative === 'assets'
        if (!permitted) { fail(relative, '目录不在显式分发清单内；未读取目录内容'); continue }
        await walk(path.join(directory, entry.name), relative, kind)
      } else if (entry.isFile()) {
        const permitted = kind === 'source' ? allowed.has(relative) : allowedDistributionPath(relative)
        if (!permitted) { fail(relative, '文件不在显式分发清单内'); continue }
        ;(kind === 'source' ? sourceFiles : distFiles).push(relative)
      } else fail(relative, '只允许普通文件和目录')
    }
  }
  await walk(root, '', 'source')
  for (const file of requiredSourceFiles) if (!sourceFiles.includes(file)) fail(file, '缺少分发清单文件；删除文件时须同步收缩清单')
  let version
  try {
    if (!['package.json', 'package-lock.json', 'index.html'].every(file => sourceFiles.includes(file))) throw new Error('Unlisted metadata')
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
    version = pkg.version
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) fail('package.json', '版本格式无效')
    if (version !== lock.version || version !== lock.packages?.['']?.version) fail('package-lock.json', '根包版本与 package.json 不一致')
    const html = await fs.readFile(path.join(root, 'index.html'), 'utf8')
    if (!html.includes(`V${version}</title>`)) fail('index.html', '标题版本与 package.json 不一致')
  } catch { fail('package.json / package-lock.json / index.html', '无法读取版本信息') }

  for (const file of sourceFiles) {
    const absolute = path.join(root, file)
    const bytes = await fs.readFile(absolute)
    const text = bytes.toString('utf8')
    if (legacyEvidence(bytes)) fail(file, '检出已移除的原 PV 采样指纹')
    if (hasPersonalPath(text)) fail(file, '含本机用户绝对路径，需改为通用示例')
    if (hasCredential(text)) fail(file, '疑似凭据或私钥')
    if (/\.md$/.test(file) && /^<!-- RHINE_(?:ALBUM_TASK|LOCAL_SERVICE) -->\s*\r?\n```json\b/m.test(text)) fail(file, '静态文档混入了用户导出的曲库任务或本机服务数据块')
    if (/\.json$/.test(file)) {
      try {
        const data = JSON.parse(text)
        if (data && (['rhine-album-introductions-task', 'rhine-album-introductions-result'].includes(data.format) || Array.isArray(data.albums) && Array.isArray(data.roots))) fail(file, '静态 JSON 混入了私人曲库或 AI 任务／结果导出')
      } catch { /* Structural validation belongs to each source format's own checks. */ }
    }
    if (/\.(?:[cm]?js|[cm]?ts|tsx|jsx|css|html|json|md|txt|py|swift|command)$/.test(file)) {
      if (/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(file)) {
        if (file.startsWith('src/') && (text.includes(['TYPING', 'PCM'].join('_')) || text.includes('typing-' + 'samples'))) fail(file, '仍引用已移除的原 PV 采样模块')
        for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.[^'"\n]+)\1/g)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2].split('?')[0]))
          const choices = [target, ...['.ts', '.mts', '.js', '.mjs', '.css', '.json'].map(extension => target + extension)]
          if (!choices.some(candidate => sourceFiles.includes(candidate))) fail(file, `相对导入不在源码包内：${match[2]}`)
        }
      }
    }
  }
  for (const file of sourceFiles.filter(file => file.endsWith('.command'))) {
    if (!((await fs.stat(path.join(root, file))).mode & 0o111)) fail(file, '启动器缺少可执行权限')
  }

  if (requireDist) {
    const dist = path.join(root, 'dist')
    try {
      const stat = await fs.lstat(dist)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('dist', '必须是本工程的普通构建目录')
      else await walk(dist, '', 'dist')
    } catch (error) {
      if (error.code === 'ENOENT') fail('dist', '缺少构建产物，请先运行 npm run build')
      else throw error
    }
    for (const file of requiredDistFiles) if (!distFiles.includes(file)) fail(`dist/${file}`, '缺少构建产物')
    if (!distFiles.some(file => /^assets\/index-.+\.js$/.test(file))) fail('dist/assets', '缺少应用入口 JS')
    for (const file of distFiles) {
      const bytes = await fs.readFile(path.join(dist, file))
      const text = bytes.toString('utf8')
      if (legacyEvidence(bytes)) fail(`dist/${file}`, '检出已移除的原 PV 采样指纹')
      if (hasPersonalPath(text)) fail(`dist/${file}`, '含本机用户绝对路径')
      if (hasCredential(text)) fail(`dist/${file}`, '疑似凭据或私钥')
      if (/\.(?:js|css|html|json)$/.test(file)) {
        if (text.includes(['TYPING', 'PCM'].join('_')) || text.includes('typing-' + 'samples')) fail(`dist/${file}`, '含已移除采样模块')
      }
    }
    // Audit the actual browser bundle graph, not merely filename patterns or
    // the PWA list: an unused hashed chunk must not hitchhike into distribution.
    const chunks = distFiles.filter(file => /^assets\/.+\.(?:js|css)$/.test(file))
    const reached = new Set(), queue = distFiles.includes('index.html') ? ['index.html'] : []
    while (queue.length) {
      const file = queue.shift()
      if (reached.has(file)) continue
      reached.add(file)
      const source = await fs.readFile(path.join(dist, file), 'utf8')
      for (const match of source.matchAll(/(['"])([^'"\r\n]+?\.(?:js|css)(?:\?[^'"\r\n]*)?)\1/g)) {
        const raw = match[2].split('?')[0]
        if (raw.length > 512 || !/^[\w@./%+-]+$/.test(raw) || raw.startsWith('//')) continue
        const target = raw.startsWith('/') ? path.posix.normalize(raw.slice(1))
          : distFiles.includes(raw) ? raw : path.posix.normalize(path.posix.join(path.posix.dirname(file), raw))
        if (chunks.includes(target)) queue.push(target)
        else if (/^assets\/[\w-]+-[\w-]{8,}\.(?:js|css)$/.test(target)) fail(`dist/${file}`, `引用缺失的构建块：${target}`)
      }
    }
    for (const file of chunks) if (!reached.has(file)) fail(`dist/${file}`, '孤立构建块：应用入口未引用，需清理过期或研究产物')
    for (const file of publicFiles.filter(file => sourceFiles.includes(file))) {
      const relative = file.slice('public/'.length)
      if (!distFiles.includes(relative)) fail(`dist/${relative}`, '缺少 public 资源副本')
      else if (sha256(await fs.readFile(path.join(root, file))) !== sha256(await fs.readFile(path.join(dist, relative)))) fail(`dist/${relative}`, '与 public 源资源不一致，请重新构建')
    }
    if (distFiles.includes('index.html') && version && !(await fs.readFile(path.join(dist, 'index.html'), 'utf8')).includes(`V${version}</title>`)) fail('dist/index.html', '构建版本与源码不一致')
    if (distFiles.includes('pwa-build.json')) {
      try {
        const pwa = JSON.parse(await fs.readFile(path.join(dist, 'pwa-build.json'), 'utf8'))
        if (!Array.isArray(pwa.files) || pwa.files.some(file => typeof file !== 'string' || !distFiles.includes(file))) fail('dist/pwa-build.json', '离线清单包含缺失或禁止的资源')
        else if (new Set(pwa.files).size !== pwa.files.length) fail('dist/pwa-build.json', '离线清单包含重复资源')
      } catch { fail('dist/pwa-build.json', '离线清单无法解析') }
    }
  }
  return { ok: errors.length === 0, version, sourceFiles: sourceFiles.sort(), distFiles: distFiles.sort(), omittedDirectories: omittedDirectories.sort(), errors }
}

async function run(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: process.platform === 'darwin'
        ? { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', COPYFILE_DISABLE: '1' }
        : process.env,
    })
    let output = '', error = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} 失败 (${code})：${error.trim()}`)))
  })
}

/** Optional local packaging. Copies only audited files; never follows repository symlinks or overwrites an archive. */
export async function createSourceZip(root, destination) {
  root = path.resolve(root)
  destination = path.resolve(destination)
  if (!destination.endsWith('.zip')) throw new Error('输出文件必须以 .zip 结尾。')
  const report = await inspectDistribution(root)
  if (!report.ok) throw new Error(`分发检查未通过：\n${report.errors.join('\n')}`)
  const checksumFile = `${destination}.sha256`
  for (const file of [destination, checksumFile]) {
    try { await fs.lstat(file); throw new Error(`输出文件已存在，不覆盖：${path.basename(file)}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-source-package-'))
  const folder = `V${report.version}`, staged = path.join(temporary, folder)
  try {
    for (const file of report.sourceFiles) {
      const input = path.join(root, file), output = path.join(staged, file)
      const stat = await fs.lstat(input)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`打包时文件类型发生变化：${file}`)
      await fs.mkdir(path.dirname(output), { recursive: true })
      const handle = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await fs.writeFile(output, await handle.readFile(), { flag: 'wx', mode: stat.mode & 0o777 }) }
      finally { await handle.close() }
    }
    const stagedReport = await inspectDistribution(staged, { requireDist: false })
    if (!stagedReport.ok) throw new Error(`暂存源码检查失败：\n${stagedReport.errors.join('\n')}`)
    if (stagedReport.version !== report.version || JSON.stringify(stagedReport.sourceFiles) !== JSON.stringify(report.sourceFiles)) throw new Error('打包期间版本或源码清单发生变化，请重新检查。')
    const archive = path.join(temporary, 'source.zip')
    // Apple's Info-ZIP writes UTF-8 filename bytes without their ZIP encoding
    // flag, and its list output can replace valid Chinese bytes with '?'.
    // libarchive records the encoding explicitly; suppress host metadata too.
    const macOS = process.platform === 'darwin'
    if (macOS) await run('/usr/bin/tar', ['-a', '-cf', archive, '--uid', '0', '--gid', '0', '--no-xattrs', '--no-mac-metadata', folder], temporary)
    else await run('zip', ['-q', '-X', '-r', archive, folder], temporary)
    const listing = macOS ? await run('/usr/bin/tar', ['-tf', archive], temporary)
      : await run('unzip', ['-Z1', archive], temporary)
    const listed = listing.trim().split('\n').filter(file => !file.endsWith('/')).sort()
    const expected = report.sourceFiles.map(file => `${folder}/${file}`).sort()
    if (JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error('ZIP 文件清单与已检查源码不一致。')
    await run('unzip', ['-tq', archive], temporary)
    const extracted = path.join(temporary, 'extracted')
    await fs.mkdir(extracted)
    await run('unzip', ['-q', archive, '-d', extracted], temporary)
    if (JSON.stringify(await fs.readdir(extracted)) !== JSON.stringify([folder])) throw new Error('ZIP 解压后的根目录不一致。')
    const restored = path.join(extracted, folder)
    const restoredReport = await inspectDistribution(restored, { requireDist: false })
    if (!restoredReport.ok || JSON.stringify(restoredReport.sourceFiles) !== JSON.stringify(report.sourceFiles)) throw new Error('ZIP 解压后的源码清单或安全检查失败。')
    for (const file of report.sourceFiles) {
      const before = path.join(staged, file), after = path.join(restored, file)
      if (sha256(await fs.readFile(before)) !== sha256(await fs.readFile(after))) throw new Error(`ZIP 解压后的文件内容不一致：${file}`)
      if (((await fs.stat(before)).mode & 0o777) !== ((await fs.stat(after)).mode & 0o777)) throw new Error(`ZIP 解压后的文件权限不一致：${file}`)
    }
    const digest = sha256(await fs.readFile(archive))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(archive, destination, constants.COPYFILE_EXCL)
    await fs.writeFile(checksumFile, `${digest}  ${path.basename(destination)}\n`, { flag: 'wx' })
    return { destination, checksumFile, sha256: digest, files: expected.length }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--zip')) throw new Error('用法：node scripts/check-distribution.mjs [--zip /path/to/source.zip]')
    if (args[0] === '--zip') {
      const result = await createSourceZip(projectRoot, args[1])
      console.log(`已生成本地源码 ZIP：${result.destination}\nSHA-256：${result.sha256}\n未上传或发布。`)
    } else {
      const report = await inspectDistribution(projectRoot)
      if (!report.ok) { console.error(`分发检查失败（${report.errors.length} 项）：\n${report.errors.map(error => `- ${error}`).join('\n')}`); process.exitCode = 1 }
      else console.log(`分发检查通过：V${report.version}，${report.sourceFiles.length} 个源码文件、${report.distFiles.length} 个构建文件。\n只读检查，未打包或发布。版权归属仍以 NOTICE 和各项来源许可为准。`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
