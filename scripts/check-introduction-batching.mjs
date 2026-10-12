// Experimental task sizing keeps identity and content-use rules intact.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  introductionResearchProfiles,
  introductionResearchInstructions,
  partitionIntroductionTask,
} from '../src/music-introduction-batching.ts'

function taskWithAlbums(count) {
  return {
    format: 'rhine-album-introductions-task',
    version: 1,
    exportedAt: '2026-10-11T00:00:00.000Z',
    albums: Array.from({ length: count }, (_, index) => ({
      id: `synthetic-${index}`,
      title: `月光档案 ${index}`,
      artist: '测试歌手',
      year: 2020 + index % 5,
      expectedRevision: index.toString(16).padStart(64, '0'),
      tracks: [{ title: '合成样本', discNumber: 1, trackNumber: 1 }],
    })),
  }
}

test('each profile partitions the entire task once, retaining exact order and a partial final batch', () => {
  const task = taskWithAlbums(43)
  const before = structuredClone(task)
  for (const [profile, expectedSize, concurrent, sources, rounds] of [
    ['light', 5, 1, 3, 2], ['balanced', 10, 2, 4, 3], ['capable', 20, 4, 6, 4],
  ]) {
    const first = partitionIntroductionTask(task, profile)
    const batches = Array.from({ length: first.options.totalBatches }, (_, i) => partitionIntroductionTask(task, profile, i + 1))
    assert.equal(first.options.batchNumber, 1)
    assert.equal(first.options.totalBatches, Math.ceil(task.albums.length / expectedSize))
    assert.equal(first.options.albumsPerBatch, expectedSize)
    assert.equal(first.options.maxConcurrentAlbums, concurrent)
    assert.equal(first.options.maxSourcesPerAlbum, sources)
    assert.equal(first.options.maxQueryRounds, rounds)
    assert.equal(first.options.retryLimit, 1)
    assert.equal(first.options.mode, 'efficient')
    assert.equal(first.options.profile, profile)
    assert.match(introductionResearchProfiles[profile].label, new RegExp(`每批 ${expectedSize} 张`))
    assert.match(introductionResearchProfiles[profile].label, new RegExp(`并行 ${concurrent} 路`))
    assert.equal(batches.at(-1).task.albums.length, 43 % expectedSize)
    assert.equal(batches.at(-1).task.albums.at(-1).id, 'synthetic-42')
    const combined = batches.flatMap(batch => batch.task.albums)
    assert.deepEqual(combined, task.albums)
    assert.equal(new Set(combined.map(album => album.id)).size, 43)
    for (const [i, batch] of batches.entries()) {
      assert.equal(batch.options.batchNumber, i + 1)
      assert.equal(batch.task.format, task.format)
      assert.equal(batch.task.version, task.version)
      assert.equal(batch.task.exportedAt, task.exportedAt)
    }
  }
  assert.deepEqual(task, before)
})

test('batch selection works for one item and exact boundaries, without mutating input arrays', () => {
  const one = taskWithAlbums(1)
  assert.deepEqual(partitionIntroductionTask(one, 'capable').task.albums, one.albums)
  const task = taskWithAlbums(20)
  const first = partitionIntroductionTask(task, 'balanced', 1)
  const second = partitionIntroductionTask(task, 'balanced', 2)
  assert.equal(second.options.totalBatches, 2)
  assert.equal(second.task.albums.length, 10)
  assert.equal(first.task.albums[0].id, 'synthetic-0')
  assert.equal(first.task.albums.at(-1).id, 'synthetic-9')
  assert.equal(second.task.albums[0].id, 'synthetic-10')
  assert.equal(second.task.albums.at(-1).id, 'synthetic-19')
  first.task.albums.pop()
  assert.equal(task.albums.length, 20)
  assert.equal(second.task.albums.length, 10)
  assert.throws(() => partitionIntroductionTask(task, 'balanced', 3), /批次编号必须是 1 至 2 之间的整数/)
})

test('missing, inherited, and invalid profiles and malformed tasks fail clearly', () => {
  const task = taskWithAlbums(10)
  for (const profile of [undefined, null, '', 'fast', '__proto__', 'constructor', 'toString', 1]) {
    assert.throws(() => partitionIntroductionTask(task, profile), /请选择有效的 AI 批量档位/)
  }
  for (const invalidTask of [null, undefined, {}, { albums: null }, { albums: 'not an array' }]) {
    assert.throws(() => partitionIntroductionTask(invalidTask, 'light'), /专辑任务格式无效/)
  }
  assert.throws(() => partitionIntroductionTask(taskWithAlbums(0), 'light'), /没有待处理的专辑任务/)
})

test('batch numbers must be finite integers within the current task range', () => {
  const task = taskWithAlbums(11)
  for (const batchNumber of [0, -1, 1.5, NaN, Infinity, -Infinity, null, '1', 4]) {
    assert.throws(() => partitionIntroductionTask(task, 'light', batchNumber), /批次编号必须是 1 至 3 之间的整数/)
  }
})

test('research appendix conveys all options, bounded work, resumable delivery and unchanged copyright rules', () => {
  for (const profile of Object.keys(introductionResearchProfiles)) {
    const { options } = partitionIntroductionTask(taskWithAlbums(43), profile, 2)
    const text = introductionResearchInstructions(options)
    const block = text.match(/<!-- RHINE_RESEARCH_OPTIONS -->\n```json\n([\s\S]*?)\n```\n<!-- \/RHINE_RESEARCH_OPTIONS -->/)
    assert.ok(block)
    assert.deepEqual(JSON.parse(block[1]), options)
    assert.match(text, /只处理本文件的 RHINE_ALBUM_TASK 清单/)
    assert.match(text, /身份字段、排序与 expectedRevision 必须原样保留/)
    assert.match(text, /工具支持并行时才并行，不支持时按顺序串行/)
    assert.match(text, /同一专辑、同一版本共享本批已读资料及链接/)
    assert.match(text, /一篇优质导语／乐评就停止，不为凑来源数量继续搜索/)
    assert.match(text, /每完成一张，立即把该条结果保存/)
    assert.match(text, /完成后立即交付可导入的 introductions-result\.json/)
    assert.match(text, /不为了整个曲库等到最后/)
    assert.match(text, /标记为 uncertain，在 notes 说明/)
    assert.match(text, /不得把预算耗尽虚报为 not-found/)
    assert.match(text, /不改变主文档的版权与全文使用规则/)
    assert.match(text, /用户直接提供、具有明确允许全文转载的许可或属于公有领域/)
    assert.match(text, /公开可读取不等于允许全文转载/)
    assert.match(text, /短摘录、来源标注及署名边界/)
    assert.match(text, /不绕过付费墙/)
  }
})
