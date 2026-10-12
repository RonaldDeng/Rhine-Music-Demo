import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'
import { validateIntroductionResult, INTRODUCTION_EXCHANGE_LIMIT, INTRODUCTION_HISTORY_LIMITS } from './album-introduction-exchange.mjs'

async function fixture(t, count = 2) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-introduction-exchange-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'private-music-root')
  await fs.mkdir(root)
  for (let i = 0; i < count; i += 1) {
    await fs.mkdir(path.join(root, `Album ${i}`))
    await fs.writeFile(path.join(root, `Album ${i}`, '01.flac'), 'synthetic metadata fixture only')
  }
  let onlineCalls = 0
  const metadataParser = async (file) => ({
    common: { album: path.basename(path.dirname(file)), artist: '测试歌手', year: 2001, title: '测试曲目', track: { no: 1 }, disk: { no: 1 }, comment: [{ text: 'PRIVATE_LOCAL_NOTE' }] },
    format: { duration: 123 },
  })
  const store = await new MusicLibraryStore({
    dataDir: path.join(temporary, 'data'), defaultRoots: [root], metadataParser,
    fetcher: async () => { onlineCalls += 1; throw new Error('external network forbidden') },
    introductionProvider: { lookup: async () => { onlineCalls += 1; throw new Error('external lookup forbidden') } },
  }).init()
  await store.scan()
  return { store, root, temporary, metadataParser, calls: () => onlineCalls }
}

function resultFor(task, indexes = task.albums.map((_, i) => i)) {
  return {
    format: 'rhine-album-introductions-result', version: 1,
    albums: indexes.map((i) => {
      const { id, title, artist, year, expectedRevision } = task.albums[i]
      return { id, title, artist, year, expectedRevision, status: 'matched', description: `${title} 的人工核对摘要。\n\n第二段说明创作背景。`, sources: [{ name: '合成测试来源', url: `https://example.com/albums/${i}`, author: '测试作者', kind: 'editorial', publishedAt: '2001-01-01' }] }
    }),
  }
}

test('task export uses a metadata whitelist; scopes and stable revisions need no external requests', async (t) => {
  const { store, root, calls } = await fixture(t)
  const album = store.index.albums[0]
  album._cover = { path: '/private/secret-cover.jpg', version: 'private-token' }
  album.tracks[0].account = 'PRIVATE_ACCOUNT'
  const before = await fs.readFile(path.join(store.dataDir, 'library-index.json'), 'utf8')
  const task = store.introductionTask()
  assert.equal(task.format, 'rhine-album-introductions-task')
  assert.equal(task.albums.length, 2)
  assert.deepEqual(task.albums[0].tracks, [{ title: '测试曲目', discNumber: 1, trackNumber: 1, duration: 123 }])
  const exported = JSON.stringify(task)
  for (const secret of [root, 'PRIVATE_LOCAL_NOTE', 'PRIVATE_ACCOUNT', 'secret-cover', 'private-token', '_path', 'audioUrl', 'folder', 'relativePath']) assert.ok(!exported.includes(secret), secret)
  assert.match(task.albums[0].expectedRevision, /^[a-f0-9]{64}$/)
  assert.equal(store.introductionTask().albums[0].expectedRevision, task.albums[0].expectedRevision)
  assert.equal(store.introductionTask({ scope: 'selected', albumId: album.id }).albums.length, 1)
  assert.throws(() => store.introductionTask({ scope: 'selected', albumId: 'unknown' }), /所选专辑/)
  assert.throws(() => store.introductionTask({ scope: 'unknown' }), /scope/)
  assert.equal(await fs.readFile(path.join(store.dataDir, 'library-index.json'), 'utf8'), before)
  assert.equal(calls(), 0)
})

test('preview is read-only; apply backs up, persists attribution, reloads and survives rescan', async (t) => {
  const { store, metadataParser, root, calls } = await fixture(t)
  const indexFile = path.join(store.dataDir, 'library-index.json')
  const before = await fs.readFile(indexFile, 'utf8')
  const result = resultFor(store.introductionTask(), [0])
  const preview = store.previewIntroductions(result)
  assert.equal(preview.canApply, true)
  assert.deepEqual(preview.counts, { add: 1, replace: 0, skip: 0, conflict: 0 })
  assert.equal(await fs.readFile(indexFile, 'utf8'), before)
  assert.equal(store.index.albums[0].description, undefined)
  const applied = await store.importIntroductions(result)
  assert.equal(applied.imported, 1)
  assert.equal(await fs.readFile(path.join(store.dataDir, applied.backup), 'utf8'), before)
  assert.equal((await fs.stat(path.join(store.dataDir, applied.backup))).mode & 0o777, 0o600)
  const album = applied.library.albums[0]
  assert.equal(album.descriptionSource.method, 'external-ai')
  assert.deepEqual(album.descriptionSource.references, result.albums[0].sources)
  assert.ok(album.descriptionSource.batchId)
  assert.equal(album.introduction.status, 'matched')
  assert.equal(album.introduction.method, 'external-ai')
  const restored = await new MusicLibraryStore({ dataDir: store.dataDir, metadataParser }).init()
  assert.deepEqual(restored.snapshot().albums[0].descriptionSource, album.descriptionSource)
  await restored.scan()
  assert.deepEqual(restored.snapshot().albums[0].descriptionSource, album.descriptionSource)
  assert.equal(restored.snapshot().albums[0].description, result.albums[0].description)
  assert.equal(store.introductionTask().albums.length, 1)
  const exported = store.introductionTask({ scope: 'all' })
  assert.deepEqual(exported.albums[0].existingIntroduction.sources, result.albums[0].sources)
  assert.ok(!JSON.stringify(exported).includes(root))
  assert.equal(calls(), 0)
})

test('identity, edition tracks, duplicate IDs and stale revisions conflict the entire batch', async (t) => {
  const { store } = await fixture(t)
  const task = store.introductionTask()
  const indexFile = path.join(store.dataDir, 'library-index.json')
  const before = await fs.readFile(indexFile, 'utf8')
  for (const mutate of [
    (value) => { value.albums[0].title += ' (wrong edition)' },
    (value) => { value.albums[0].artist = '另一歌手' },
    (value) => { value.albums[0].year = 2002 },
    (value) => { value.albums[0].id = 'unknown-album' },
    (value) => { value.albums[0].expectedRevision = 'f'.repeat(64) },
    (value) => { value.albums.push(structuredClone(value.albums[0])) },
  ]) {
    const result = resultFor(task)
    mutate(result)
    const preview = store.previewIntroductions(result)
    assert.equal(preview.canApply, false)
    assert.ok(preview.counts.conflict > 0)
    await assert.rejects(store.importIntroductions(result), (error) => error.status === 409 && error.preview.counts.conflict > 0)
    assert.equal(await fs.readFile(indexFile, 'utf8'), before)
    assert.ok(store.index.albums.every((album) => !album.description))
  }
  const result = resultFor(task)
  assert.equal(store.previewIntroductions(result).canApply, true)
  store.index.albums[0].tracks[0].title = 'changed after preview'
  await assert.rejects(store.importIntroductions(result), { status: 409 })
  assert.equal(store.previewIntroductions(result).entries[0].action, 'conflict')
  assert.equal(await fs.readFile(indexFile, 'utf8'), before)
})

test('existing introductions require explicit replacement; uncertain and not-found never write', async (t) => {
  const { store } = await fixture(t, 3)
  await store.importIntroductions(resultFor(store.introductionTask(), [0]))
  const task = store.introductionTask({ scope: 'all' })
  const result = resultFor(task)
  result.albums[0].description = '经过用户审阅的新介绍。'
  for (let i = 1; i < 3; i += 1) {
    result.albums[i].status = i === 1 ? 'uncertain' : 'not-found'
    result.albums[i].notes = '没有足够证据，不编写介绍。'
    delete result.albums[i].description
    delete result.albums[i].sources
  }
  const preview = store.previewIntroductions(result)
  assert.deepEqual(preview.counts, { add: 0, replace: 0, skip: 3, conflict: 0 })
  assert.equal(preview.canApply, false)
  await assert.rejects(store.importIntroductions(result), { status: 409 })
  const replace = store.previewIntroductions(result, { allowReplace: true })
  assert.deepEqual(replace.counts, { add: 0, replace: 1, skip: 2, conflict: 0 })
  const applied = await store.importIntroductions(result, { allowReplace: true })
  assert.equal(applied.imported, 1)
  assert.equal(applied.library.albums[0].description, '经过用户审阅的新介绍。')
  assert.equal(applied.library.albums[1].introduction, undefined)
  assert.equal(applied.library.albums[2].description, undefined)
  await assert.rejects(store.importIntroductions(result, { allowReplace: true }), { status: 409 })
})

test('malformed and unsafe payloads are rejected globally before preview or write', async (t) => {
  const { store } = await fixture(t)
  const base = resultFor(store.introductionTask())
  for (const mutate of [
    (value) => { value.version = 2 },
    (value) => { value.extra = 'not supported' },
    (value) => { value.albums[0].filePath = '/private/audio.flac' },
    (value) => { value.albums[0].sources = [] },
    (value) => { value.albums[0].sources = Array(9).fill(value.albums[0].sources[0]) },
    (value) => { value.albums[0].sources[0].url = 'javascript:alert(1)' },
    (value) => { value.albums[0].sources[0].url = 'https://user:password@example.com/review' },
    (value) => { value.albums[0].sources[0].url = 'http://example.com/review' },
    (value) => { value.albums[0].sources[0].url = 'file:///private/review' },
    (value) => { value.albums[0].description = '<img src=x onerror=alert(1)>' },
    (value) => { value.albums[0].description = '[标题](javascript:alert(1))' },
    (value) => { value.albums[0].description = 'a'.repeat(8001) },
    (value) => { value.albums[0].description = '\u0000hidden' },
    (value) => { value.albums[0].status = 'uncertain' },
    (value) => { delete value.albums[0].year },
  ]) {
    const result = structuredClone(base)
    mutate(result)
    assert.throws(() => store.previewIntroductions(result), { status: 400 })
  }
  const massive = { ...base, extra: 'a'.repeat(INTRODUCTION_EXCHANGE_LIMIT) }
  assert.throws(() => validateIntroductionResult(massive), { status: 413 })
  assert.throws(() => store.previewIntroductions(base, { allowReplace: 'true' }), { status: 400 })
  assert.ok(store.index.albums.every((album) => !album.description))
})

test('import excludes concurrent scan/metadata jobs in both directions and guards root changes', async (t) => {
  const { store } = await fixture(t)
  const result = resultFor(store.introductionTask())
  for (const key of ['scanPromise', 'enrichPromise', 'introductionsPromise', 'creditsPromise']) {
    store[key] = Promise.resolve()
    assert.throws(() => store.previewIntroductions(result), { status: 409 })
    await assert.rejects(store.importIntroductions(result), { status: 409 })
    store[key] = null
  }
  let release
  store.saveChain = new Promise((resolve) => { release = resolve })
  const applying = store.importIntroductions(result)
  for (const start of [() => store.scan(), () => store.enrich(), () => store.updateIntroductions(), () => store.updateCredits(), () => store.updateConfig({ roots: [] }), () => store.importIntroductions(result)]) await assert.rejects(start(), { status: 409 })
  release()
  assert.equal((await applying).imported, 2)
  assert.equal(store.introductionImportRunning, false)
})

test('failed backup or index writes leave memory and persisted library unchanged and unlock retries', async (t) => {
  const { store } = await fixture(t)
  const result = resultFor(store.introductionTask())
  const file = path.join(store.dataDir, 'library-index.json')
  const before = await fs.readFile(file, 'utf8')
  const memory = structuredClone(store.index)
  const rename = fs.rename
  t.after(() => { fs.rename = rename })
  for (const failAt of ['backup', 'index']) {
    fs.rename = async (from, to) => {
      if (failAt === 'backup' ? path.basename(to).startsWith('library-index.before-introductions-') : to === file) throw new Error(`fixture ${failAt} write failed`)
      return rename(from, to)
    }
    await assert.rejects(store.importIntroductions(result), /fixture.*write failed/)
    fs.rename = rename
    assert.equal(await fs.readFile(file, 'utf8'), before)
    assert.deepEqual(store.index, memory)
    assert.equal(store.introductionImportRunning, false)
    assert.ok(!(await fs.readdir(store.dataDir)).some((name) => name.endsWith('.tmp')))
  }
  assert.equal((await store.importIntroductions(result)).imported, 2)
})

test('automatic encyclopedia and MusicBrainz refresh cannot replace imported text even with force', async (t) => {
  const { store, calls } = await fixture(t, 1)
  await store.importIntroductions(resultFor(store.introductionTask()))
  const before = structuredClone(store.index.albums[0].descriptionSource)
  await store.updateIntroductions({ force: true })
  assert.equal(calls(), 0)
  assert.equal(store.introductionsStatus.total, 0)
  const id = '11111111-1111-1111-1111-111111111111'
  store.index.albums[0].online = { releaseId: id }
  store.musicBrainz = async (route) => route.startsWith('release-group/') ? {} : { 'release-group': { id }, genres: [], media: [] }
  store.albumIntroduction = async () => { throw new Error('imported text must not trigger a redundant encyclopedia lookup') }
  await store.enrich({ force: true })
  assert.equal(store.index.albums[0].online.status, 'matched')
  assert.equal(store.index.albums[0].online.descriptionError, undefined)
  assert.deepEqual(store.index.albums[0].descriptionSource, before)
})

test('loopback API exposes preview/apply with the existing Origin boundary and conflict responses', async (t) => {
  const { store, temporary } = await fixture(t, 1)
  const { server } = await createMusicServer({ store, distDir: temporary, autoScan: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/api/library/introductions`
  const exported = await fetch(`${endpoint}/task?scope=all`)
  assert.equal(exported.status, 200)
  assert.equal(exported.headers.get('cache-control'), 'no-store')
  const result = resultFor(await exported.json())
  const post = (suffix, value, headers = {}) => fetch(`${endpoint}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value) })
  assert.equal((await post('import-preview', { result }, { Origin: 'https://unrelated.example' })).status, 403)
  assert.equal((await post('import-preview', { result }, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post('import-preview', '{not JSON')).status, 400)
  assert.equal((await post('import-preview', { result, allowReplace: null })).status, 400)
  const preview = await post('import-preview', { result, allowReplace: false })
  assert.equal(preview.status, 200)
  assert.equal((await preview.json()).counts.add, 1)
  const applied = await post('import', { result, allowReplace: false })
  assert.equal(applied.status, 200)
  assert.equal((await applied.json()).imported, 1)
  const stale = await post('import', { result, allowReplace: true })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).counts.conflict, 1)
  assert.equal((await post('reconcile', { result, allowReplace: true })).status, 400)
  assert.equal((await post('reconcile', { result }, { Origin: 'https://unrelated.example' })).status, 403)
  const reconciled = await post('reconcile', { result })
  assert.equal(reconciled.status, 200)
  const refreshed = await reconciled.json()
  assert.equal(refreshed.rebound, 1)
  assert.deepEqual(refreshed.unresolved, [])
  const replacementPreview = await (await post('import-preview', { result: refreshed.result, allowReplace: true })).json()
  assert.equal(replacementPreview.entries[0].existingDescription, result.albums[0].description)
  assert.deepEqual(replacementPreview.entries[0].existingSources, result.albums[0].sources)
  const tooLarge = await post('import-preview', { result, extra: 'a'.repeat(INTRODUCTION_EXCHANGE_LIMIT + 2048) })
  assert.equal(tooLarge.status, 413)
})

test('a result at the 4 MiB boundary fits its HTTP envelope without relaxing the result limit', async (t) => {
  const { store, temporary } = await fixture(t, 0)
  const { server } = await createMusicServer({ store, distDir: temporary, autoScan: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const endpoint = `http://127.0.0.1:${server.address().port}/api/library/introductions`
  const result = { format: 'rhine-album-introductions-result', version: 1,
    albums: Array.from({ length: 2500 }, (_, index) => ({
      id: `synthetic-${index}`, title: 'Synthetic album', artist: 'Synthetic artist', year: null,
      expectedRevision: '0'.repeat(64), status: 'not-found', notes: 'x',
    })) }
  let remaining = INTRODUCTION_EXCHANGE_LIMIT - Buffer.byteLength(JSON.stringify(result))
  for (const album of result.albums) {
    const added = Math.min(1999, remaining)
    album.notes += 'x'.repeat(added); remaining -= added
    if (!remaining) break
  }
  assert.equal(remaining, 0)
  assert.equal(Buffer.byteLength(JSON.stringify(result)), INTRODUCTION_EXCHANGE_LIMIT)
  assert.equal(validateIntroductionResult(result).length, 2500)
  const post = (suffix, value) => fetch(`${endpoint}/${suffix}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  })
  const preview = await post('import-preview', { result, allowReplace: false })
  assert.equal(preview.status, 200, 'A valid maximum-size result reaches preview through its JSON envelope')
  assert.equal((await preview.json()).counts.conflict, 2500, 'Synthetic unknown IDs still receive normal identity checks')
  const reconciled = await post('reconcile', { result })
  assert.equal(reconciled.status, 200, 'Reconciliation uses the same envelope allowance')
  assert.equal((await reconciled.json()).unresolved.length, 2500)
  const imported = await post('import', { result, allowReplace: false })
  assert.equal(imported.status, 409, 'Import reaches identity checks instead of rejecting the envelope size')
  assert.equal((await imported.json()).counts.conflict, 2500)

  result.albums.at(-1).notes += 'x'
  assert.equal(Buffer.byteLength(JSON.stringify(result)), INTRODUCTION_EXCHANGE_LIMIT + 1)
  for (const suffix of ['import-preview', 'reconcile', 'import']) {
    const oversized = await post(suffix, { result })
    assert.equal(oversized.status, 413, `${suffix}: the result itself cannot exceed 4 MiB`)
    assert.match((await oversized.json()).error, /结果超过 4 MiB/)
  }
  assert.deepEqual(store.index.albums, [], 'Boundary requests never write any library records')
})

test('reconcile uses a remembered export only for introduction changes and never writes', async (t) => {
  const { store, calls } = await fixture(t, 2)
  const result = resultFor(store.introductionTask())
  const sourceResult = structuredClone(result)
  store.index.albums[0].description = '现有介绍，不应被核对操作覆盖。'
  store.index.albums[0].descriptionSource = { name: '既有来源', url: 'https://example.com/existing', account: 'PRIVATE_ACCOUNT' }
  store.index.albums[0].introduction = { status: 'matched', checkedAt: '2026-10-10T10:00:00Z' }
  await store.saveIndex()
  const before = await fs.readFile(path.join(store.dataDir, 'library-index.json'), 'utf8')
  const files = await fs.readdir(store.dataDir)
  const memory = structuredClone(store.index)
  const reconciled = await store.reconcileIntroductions(result)
  assert.equal(reconciled.rebound, 1)
  assert.deepEqual(reconciled.unresolved, [])
  assert.notEqual(reconciled.result.albums[0].expectedRevision, sourceResult.albums[0].expectedRevision)
  assert.deepEqual(reconciled.result.albums[1], sourceResult.albums[1], 'fresh entry is byte-for-byte equivalent')
  assert.deepEqual(result, sourceResult, 'caller-owned result is not rewritten in memory')
  assert.deepEqual(store.index, memory)
  assert.equal(await fs.readFile(path.join(store.dataDir, 'library-index.json'), 'utf8'), before)
  assert.deepEqual(await fs.readdir(store.dataDir), files)
  const preview = store.previewIntroductions(reconciled.result, { allowReplace: true })
  assert.equal(preview.canApply, true)
  assert.equal(preview.entries[0].existingDescription, memory.albums[0].description)
  assert.deepEqual(preview.entries[0].existingSources, [{ name: '既有来源', url: 'https://example.com/existing' }])
  assert.equal(store.previewIntroductions(reconciled.result).entries[0].action, 'skip', 'reconciliation does not grant replacement permission')
  assert.equal(calls(), 0)
})

test('reconcile after restart can prove the initial task from an immutable pre-import backup', async (t) => {
  const { store, metadataParser } = await fixture(t, 1)
  const result = resultFor(store.introductionTask())
  const applied = await store.importIntroductions(result)
  result.albums[0].description = '更好的 Agent 整理的新摘要。'
  const restored = await new MusicLibraryStore({ dataDir: store.dataDir, metadataParser }).init()
  assert.equal(restored.introductionRevisionProofs.size, 0)
  const indexFile = path.join(store.dataDir, 'library-index.json')
  const backupFile = path.join(store.dataDir, applied.backup)
  const beforeIndex = await fs.readFile(indexFile, 'utf8')
  const beforeBackup = await fs.readFile(backupFile, 'utf8')
  const statBefore = await fs.stat(backupFile)
  const recovered = await restored.reconcileIntroductions(result)
  assert.equal(recovered.rebound, 1)
  assert.deepEqual(recovered.unresolved, [])
  assert.equal(await fs.readFile(indexFile, 'utf8'), beforeIndex)
  assert.equal(await fs.readFile(backupFile, 'utf8'), beforeBackup)
  assert.equal((await fs.stat(backupFile)).mtimeMs, statBefore.mtimeMs)
  assert.equal(restored.snapshot().albums[0].description, JSON.parse(beforeIndex).albums[0].description)
  const preview = restored.previewIntroductions(recovered.result, { allowReplace: true })
  assert.equal(preview.counts.replace, 1)
  assert.equal(preview.entries[0].description, '更好的 Agent 整理的新摘要。')
  restored.index.albums[0].description += '另一项已发生的修改。'
  await restored.saveIndex()
  await assert.rejects(restored.importIntroductions(recovered.result, { allowReplace: true }), { status: 409 })
  assert.equal(restored.previewIntroductions(recovered.result, { allowReplace: true }).counts.conflict, 1, 'another change after reconcile still needs a fresh review')
})

test('reconcile never bypasses unknown revisions, changed tracks or release identity', async (t) => {
  const { store } = await fixture(t, 1)
  const result = resultFor(store.introductionTask())
  const original = structuredClone(store.index.albums[0])
  for (const change of [
    (album) => { album.title += ' Deluxe' },
    (album) => { album.artist = 'Other artist' },
    (album) => { album.year = 2020 },
    (album) => { album.tracks[0].title += ' Remastered' },
    (album) => { album.tracks[0].duration += 1 },
    (album) => { album.tracks[0].trackNumber = 2 },
    (album) => { album.tracks[0].discNumber = 2 },
    (album) => { album.tracks.push({ ...album.tracks[0], title: 'Bonus track' }) },
  ]) {
    store.index.albums[0] = structuredClone(original)
    change(store.index.albums[0])
    const attempt = structuredClone(result)
    // Even changing result labels to the new edition cannot repurpose old proof.
    for (const key of ['title', 'artist', 'year']) attempt.albums[0][key] = store.index.albums[0][key]
    const checked = await store.reconcileIntroductions(attempt)
    assert.equal(checked.rebound, 0)
    assert.equal(checked.unresolved.length, 1)
    assert.deepEqual(checked.result, attempt)
    assert.equal(store.previewIntroductions(checked.result, { allowReplace: true }).canApply, false)
  }
  store.index.albums[0] = structuredClone(original)
  const unknown = structuredClone(result)
  unknown.albums[0].expectedRevision = 'f'.repeat(64)
  assert.match((await store.reconcileIntroductions(unknown)).unresolved[0].reason, /没有找到/)
  const removed = structuredClone(result)
  removed.albums[0].id = 'removed-album'
  assert.match((await store.reconcileIntroductions(removed)).unresolved[0].reason, /不在当前音乐库/)
})

test('fresh negative results stay unchanged; stale negatives and duplicates cannot acquire new revision authority', async (t) => {
  const { store } = await fixture(t, 1)
  const result = resultFor(store.introductionTask())
  result.albums[0].status = 'not-found'
  result.albums[0].notes = '本次没有找到可靠资料。'
  delete result.albums[0].description
  delete result.albums[0].sources
  const fresh = await store.reconcileIntroductions(result)
  assert.deepEqual(fresh, { result, rebound: 0, unresolved: [] })
  store.index.albums[0].introduction = { status: 'uncertain', checkedAt: '2026-10-10T10:00:00Z' }
  const old = await store.reconcileIntroductions(result)
  assert.deepEqual(old.result, result)
  assert.equal(old.rebound, 0)
  assert.equal(old.unresolved.length, 1)
  const duplicate = structuredClone(result)
  duplicate.albums.push(structuredClone(duplicate.albums[0]))
  await assert.rejects(store.reconcileIntroductions(duplicate), { status: 400 })
  await assert.rejects(store.reconcileIntroductions({ ...result, unexpected: true }), { status: 400 })
  assert.equal(store.introductionReconcileRunning, false)
})

test('backup proof is restricted to regular known files, bounded sizes/counts, and never follows symlinks', async (t) => {
  const { store, temporary } = await fixture(t, 1)
  const result = resultFor(store.introductionTask())
  const original = structuredClone(store.index)
  store.index.albums[0].description = 'New local description'
  await store.saveIndex()
  store.introductionRevisionProofs.clear()
  const filename = 'library-index.before-introductions-2026-10-11T00-00-00.000Z-11111111-1111-1111-1111-111111111111.json'
  const outside = path.join(temporary, 'outside-history.json')
  const candidate = path.join(store.dataDir, filename)
  await fs.writeFile(outside, JSON.stringify(original))
  await fs.symlink(outside, candidate)
  assert.equal((await store.reconcileIntroductions(result)).rebound, 0, 'a symlink cannot be used as evidence')
  await fs.unlink(candidate)
  await fs.copyFile(outside, path.join(store.dataDir, 'manual-backup.json'))
  assert.equal((await store.reconcileIntroductions(result)).rebound, 0, 'arbitrary files are not consulted')
  await fs.copyFile(outside, candidate)
  await fs.truncate(candidate, INTRODUCTION_HISTORY_LIMITS.fileBytes + 1)
  assert.equal((await store.reconcileIntroductions(result)).rebound, 0, 'oversized backup is not read')
  await fs.copyFile(outside, candidate)
  for (let i = 1; i <= INTRODUCTION_HISTORY_LIMITS.backups; i += 1) {
    const name = filename.replace('00-00-00.000', `00-00-${String(i).padStart(2, '0')}.000`)
    await fs.writeFile(path.join(store.dataDir, name), '{}')
  }
  assert.equal((await store.reconcileIntroductions(result)).rebound, 0, 'only the latest 32 candidate files are inspected')
  await fs.unlink(path.join(store.dataDir, filename.replace('00-00-00.000', '00-00-32.000')))
  assert.equal((await store.reconcileIntroductions(result)).rebound, 1, 'a bounded regular backup can now prove the task')
  assert.equal(await fs.readFile(outside, 'utf8'), JSON.stringify(original))
})

test('reconciliation excludes concurrent metadata changes in both directions and bounds export memory', async (t) => {
  const { store } = await fixture(t, 1)
  const result = resultFor(store.introductionTask())
  for (const key of ['scanPromise', 'enrichPromise', 'introductionsPromise', 'creditsPromise']) {
    store[key] = Promise.resolve()
    await assert.rejects(store.reconcileIntroductions(result), { status: 409 })
    store[key] = null
  }
  store.introductionImportRunning = true
  await assert.rejects(store.reconcileIntroductions(result), { status: 409 })
  store.introductionImportRunning = false
  let release
  store.saveChain = new Promise((resolve) => { release = resolve })
  const reconciling = store.reconcileIntroductions(result)
  for (const start of [() => store.scan(), () => store.enrich(), () => store.updateIntroductions(), () => store.updateCredits(), () => store.updateConfig({ roots: [] }), () => store.importIntroductions(result), () => store.reconcileIntroductions(result)]) await assert.rejects(start(), { status: 409 })
  release()
  assert.equal((await reconciling).rebound, 0)
  assert.equal(store.introductionReconcileRunning, false)
  for (let i = 0; i <= INTRODUCTION_HISTORY_LIMITS.revisions; i += 1) store.introductionRevisionProofs.set(`unused-${i}`, 'edition-hash')
  const task = store.introductionTask()
  assert.equal(store.introductionRevisionProofs.size, INTRODUCTION_HISTORY_LIMITS.revisions)
  assert.ok(store.introductionRevisionProofs.has(task.albums[0].expectedRevision))
  assert.match(store.introductionRevisionProofs.get(task.albums[0].expectedRevision), /^[a-f0-9]{64}$/)
})
