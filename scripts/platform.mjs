// Cross-platform helpers shared by the launcher, the music server and the
// music library. Everything that differs between macOS, Windows and Linux lives
// here so the rest of the code can stay platform-neutral.
import { existsSync, realpathSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const isWindows = process.platform === 'win32'
const pathFor = (platform) => platform === 'win32' ? path.win32 : path.posix

/** Absolute, symlink-free directory path. Windows: no \\?\ prefix, upper-case drive letter. */
export function canonicalPath(target, platform = process.platform) {
  let resolved = pathFor(platform).resolve(target)
  if (platform === process.platform) { try { resolved = realpathSync.native(resolved) } catch {} }
  if (platform === 'win32') {
    resolved = resolved.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/^[a-z]:/, (drive) => drive.toUpperCase())
  }
  return resolved
}

/** Comparison key: Windows paths are case-insensitive and accept both separators. */
export function pathKey(target, platform = process.platform) {
  const resolved = pathFor(platform).resolve(target)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const samePath = (a, b, platform = process.platform) => pathKey(a, platform) === pathKey(b, platform)

/** True when child is parent or lives below it. */
export function isInside(parent, child, platform = process.platform) {
  const flavour = pathFor(platform)
  const relative = flavour.relative(pathKey(parent, platform), pathKey(child, platform))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(relative))
}

/** Accepts C:\dir, C:/dir and \\server\share\dir; rejects \dir (current-drive relative) and C:dir. */
export function isFullyQualified(target, platform = process.platform) {
  if (typeof target !== 'string' || target.includes('\0')) return false
  if (platform === 'win32') return /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/])/.test(target)
  return path.posix.isAbsolute(target)
}

/** Explorer's "Copy as path" wraps paths in quotes; accept them for convenience. */
export function cleanRootInput(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length > 1 && /^(["'])[\s\S]*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed
}

/**
 * How to run npm. On Windows npm is npm.cmd, which Node cannot spawn without a
 * shell, so run npm-cli.js with the current node binary whenever it is available.
 */
export function npmInvocation(args, { platform = process.platform, execPath = process.execPath, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return { command: 'npm', args }
  const win = path.win32
  const candidates = [
    /npm-cli\.js$/i.test(env.npm_execpath ?? '') ? env.npm_execpath : undefined,
    win.join(win.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const cli = candidates.find((file) => exists(file))
  if (cli) return { command: execPath, args: [cli, ...args] }
  // Arguments are fixed, shell-safe words (ci, run, build, --version).
  return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
}

/** Command used to open a URL in the default browser. */
export function browserInvocation(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

/** Folders and files that are never part of a music library. */
const IGNORED_DIRECTORIES = new Set(['$recycle.bin', 'system volume information', 'recycler', '$winreagent', '.trashes', '.spotlight-v100', '.fseventsd'])
export const isIgnoredDirectory = (name) => name.startsWith('.') || IGNORED_DIRECTORIES.has(name.toLowerCase())
/** macOS AppleDouble sidecars (._song.mp3) show up on exFAT/FAT drives shared with a Mac. */
export const isIgnoredFile = (name) => name.startsWith('._')

/** rename() can fail briefly on Windows while antivirus or the indexer holds the target. */
export async function renameWithRetry(from, to, { retries = 6, delay = 40, rename = fs.rename, platform = process.platform } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)))
    }
  }
}
