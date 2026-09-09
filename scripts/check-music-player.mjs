import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicPlayer } from '../src/music-player.ts'

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** No browser, network, real timers, or actual sound is used by these tests. */
function environment(t) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now')

  class ControlledAudio extends EventTarget {
    constructor(src = '') {
      super()
      this.src = src
      this.volume = 1
      this.paused = true
      this.ended = false
      this.duration = 120
      this.currentTime = 0
      this.readyState = 1
      this.playCalls = 0
      this.deferred = []
      this.holdPlay = false
      instances.push(this)
    }

    play() {
      this.playCalls += 1
      if (this.holdPlay) {
        this.holdPlay = false
        return new Promise((resolve) => this.deferred.push(() => { this.begin(); resolve() }))
      }
      this.begin()
      return Promise.resolve()
    }

    begin() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
    }

    resolvePlay() {
      assert.ok(this.deferred.length, 'there must be a held audio play request')
      this.deferred.shift()()
    }

    pause() {
      if (this.paused) return
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }

    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimer++
    timers.set(id, { callback, at: now + Number(delay) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  t.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousNow) Object.defineProperty(performance, 'now', previousNow)
    else delete performance.now
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
  })

  return {
    instances,
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
    pendingTimers: () => timers.size,
    async advance(milliseconds) {
      await settle()
      const end = now + milliseconds
      let next
      while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const track = (id) => ({ id, albumId: 'album-test', title: id, artist: 'Test artist', duration: 120, format: 'WAV', browserPlayable: true, relativePath: `${id}.wav`, audioUrl: `/api/audio/${id}` })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `expected ${actual} ≈ ${expected}`)

test('BGM has an independent default, live volume, zero-volume gate, and clamped settings', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0 })
  const bgm = env.instances[0]
  assert.equal(player.state.bgmVolume, 0.18)
  assert.equal(bgm.playCalls, 0, 'no autoplay before a gesture')
  env.gesture()
  await env.advance(700)
  near(bgm.volume, 0.18)
  assert.equal(player.state.bgmPlaying, true, 'muted songs do not mute the BGM')
  player.setVolume(1)
  await env.advance(700)
  near(bgm.volume, 0.18)
  player.setBgmVolume(0.42)
  await env.advance(700)
  near(bgm.volume, 0.42)
  assert.equal(player.state.volume, 1)
  player.setBgmVolume(NaN)
  assert.equal(player.state.bgmVolume, 0.42)
  player.setBgmVolume(-1)
  await env.advance(250)
  assert.equal(player.state.bgmVolume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.bgmEnabled, true, 'zero volume preserves the independent enabled preference')
  player.setBgmVolume(9)
  await env.advance(700)
  assert.equal(player.state.bgmVolume, 1)
  near(bgm.volume, 1)
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('song playback waits for BGM silence despite rapid BGM volume and toggle changes', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.65, bgmVolume: 0.3 })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const playing = player.play('first')
  const song = env.instances[1]
  await env.advance(96)
  assert.equal(song.playCalls, 0)
  assert.ok(bgm.volume > 0 && bgm.volume < 0.3)
  player.setBgmVolume(0.8)
  player.setBgmEnabled(false)
  player.setBgmEnabled(true)
  player.setVolume(0.25)
  await env.advance(100)
  assert.equal(song.playCalls, 0, 'controls must not bypass the shared fade-out promise')
  await env.advance(60)
  await playing
  assert.equal(song.playCalls, 1)
  assert.equal(song.volume, 0.25)
  assert.equal(bgm.volume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.playing, true)
  assert.equal(player.state.bgmVolume, 0.8)
  player.setBgmVolume(0.4)
  await env.advance(700)
  assert.equal(song.volume, 0.25, 'BGM volume cannot alter song output')
  assert.equal(bgm.paused, true, 'BGM stays silent while a song plays')
  player.stop()
  await env.advance(700)
  near(bgm.volume, 0.4)
  assert.equal(player.state.bgmPlaying, true)
  player.dispose()
})

test('rapidly cancelling a pending song restores only the latest BGM volume', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.5 })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const pending = player.play('first')
  const song = env.instances[1]
  await env.advance(72)
  player.stop()
  player.setBgmVolume(0.2)
  player.setBgmEnabled(false)
  await env.advance(24)
  player.setBgmEnabled(true)
  player.setBgmVolume(0.33)
  await env.advance(700)
  await pending
  assert.equal(song.playCalls, 0, 'cancelled song never starts after the old fade finishes')
  assert.equal(song.paused, true)
  near(bgm.volume, 0.33)
  assert.equal(player.state.bgmPlaying, true)
  assert.equal(player.state.playing, false)
  player.dispose()
  await env.advance(1000)
  assert.equal(bgm.paused, true)
  assert.equal(env.pendingTimers(), 0)
})

test('a late BGM play resolution stays silent when a song has taken over', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.4 })
  const bgm = env.instances[0]
  bgm.holdPlay = true
  player.setQueue([track('first')])
  env.gesture()
  await settle()
  assert.equal(bgm.playCalls, 1)
  const playing = player.play('first')
  await env.advance(250)
  await playing
  const song = env.instances[1]
  assert.equal(song.paused, false)
  bgm.resolvePlay()
  await settle()
  assert.equal(bgm.paused, true)
  assert.equal(bgm.volume, 0)
  assert.equal(player.state.bgmPlaying, false)
  assert.equal(player.state.playing, true)
  player.dispose()
})
