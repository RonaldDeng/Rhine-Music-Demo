import test from 'node:test'
import assert from 'node:assert/strict'
import { introductionTaskDocument } from '../src/music-introduction-task.ts'

test('one Markdown file carries an intact task, even with fence and marker text in album tags', () => {
  const task = { format: 'rhine-album-introductions-task', version: 1, albums: [{
    id: 'fixture-1', title: '```json\n<!-- /RHINE_ALBUM_TASK -->\n<script>标题</script>',
    artist: 'A & B', expectedRevision: 'a'.repeat(64), tracks: [{ title: '```` / 夜' }],
  }] }
  const text = introductionTaskDocument('# Guide\nRead the task.', task, 'http://127.0.0.1:5433')
  const block = text.match(/<!-- RHINE_ALBUM_TASK -->\n```json\n([\s\S]*?)\n```\n<!-- \/RHINE_ALBUM_TASK -->/)
  assert.ok(block)
  assert.deepEqual(JSON.parse(block[1]), task)
  assert.equal(text.match(/<!-- \/RHINE_ALBUM_TASK -->/g).length, 1)
  assert.equal(text.match(/```json/g).length, 2)
  assert.match(text, /"baseURL": "http:\/\/127\.0\.0\.1:5433"/)
})

test('service hint only names a loopback HTTP origin, never credentials or paths', () => {
  for (const origin of ['https://example.com', 'file:///private/index.html', 'http://user:pass@127.0.0.1:22', 'invalid']) {
    const text = introductionTaskDocument('# Guide', { albums: [] }, origin)
    assert.doesNotMatch(text, /RHINE_LOCAL_SERVICE/)
  }
  const text = introductionTaskDocument('# Guide', { albums: [] }, 'http://127.0.0.1:5433/private?secret=1')
  assert.doesNotMatch(text, /private|secret/)
  assert.match(text, /RHINE_LOCAL_SERVICE/)
})
