// Controlled Web Audio graph checks only: no browser, device, network or playback.
// Optional INTERFACE_AUDIO_BASELINE compares all non-key cues with an existing
// source file without copying that file or its assets into this version.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const source = await fs.readFile(new URL('../src/audio.ts', import.meta.url), 'utf8')
async function synthesis(text) {
  // Exercise the production function and helpers; TerminalAudio needs browser UI
  // lifecycle APIs and is outside this graph-level check.
  const standalone = text.slice(0, text.indexOf('export class TerminalAudio'))
    .replace(/^import .*;\r?\n/gm, '')
  const javascript = ts.transpileModule(standalone, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).synthesizeSound
}
const synthesizeSound = await synthesis(source)
const sounds = [...source.matchAll(/^  \| "([\w-]+)"/gm)].map((match) => match[1])

function graph({ forbidBuffers = false } = {}) {
  const events = [], nodes = [], sources = []
  const parameter = (label) => {
    let value = 0
    const record = (operation, ...args) => {
      assert.ok(args.every(Number.isFinite), `${label}: finite parameters`)
      events.push([label, operation, ...args])
    }
    return {
      get value() { return value },
      set value(next) { value = next; record('value', next) },
      setValueAtTime: (...args) => record('set', ...args),
      linearRampToValueAtTime: (...args) => record('linear', ...args),
      exponentialRampToValueAtTime: (...args) => { assert.ok(args[0] > 0); record('exponential', ...args) },
      cancelAndHoldAtTime: (...args) => record('hold', ...args),
    }
  }
  const node = (kind, scheduled = false) => {
    const id = `${kind}-${nodes.length}`, connections = new Set()
    const value = {
      id, kind, connections,
      connect(target) { connections.add(target); events.push([id, 'connect', target.id]) },
      disconnect() { connections.clear(); events.push([id, 'disconnect']) },
      gain: parameter(`${id}.gain`), pan: parameter(`${id}.pan`),
      frequency: parameter(`${id}.frequency`), Q: parameter(`${id}.Q`),
    }
    let buffer, type
    Object.defineProperties(value, {
      type: { get: () => type, set: (next) => { type = next; events.push([id, 'type', next]) } },
      buffer: { get: () => buffer, set: (next) => {
        buffer = next
        events.push([id, 'buffer', createHash('sha256').update(Buffer.from(next.data.buffer)).digest('hex')])
      } },
    })
    if (scheduled) {
      value.start = (time) => { assert.ok(Number.isFinite(time)); value.started = time; events.push([id, 'start', time]) }
      value.stop = (time) => { assert.ok(Number.isFinite(time)); value.stopped = time; events.push([id, 'stop', time]) }
      sources.push(value)
    }
    nodes.push(value)
    return value
  }
  const context = {
    sampleRate: 48000,
    createGain: () => node('gain'),
    createStereoPanner: () => node('panner'),
    createOscillator: () => node('oscillator', true),
    createBiquadFilter: () => node('filter'),
    createBufferSource: () => { assert.equal(forbidBuffers, false, 'key must not play recorded buffers'); return node('buffer', true) },
    createBuffer: (channels, length, sampleRate) => {
      assert.equal(forbidBuffers, false, 'key must not allocate or decode sample buffers')
      assert.equal(channels, 1)
      const data = new Float32Array(length)
      return { data, duration: length / sampleRate, getChannelData: () => data }
    },
    decodeAudioData: () => assert.fail('interface sound synthesis must not decode recordings'),
  }
  return { context, destination: { id: 'destination' }, events, nodes, sources }
}

test('runtime has no PV sample import, decoder or sample bank', () => {
  assert.doesNotMatch(source, /typing-samples|TYPING_PCM|TYPING_SAMPLE_RATE|typingSample|typingBuffers|atob\(/)
  assert.ok(sounds.includes('key') && sounds.includes('page-open'))
})

test('key schedules original oscillator envelopes without recorded buffers', () => {
  const g = graph({ forbidBuffers: true })
  const voice = synthesizeSound(g.context, g.destination, 'key', 1, 0.25)
  assert.equal(g.sources.length, 2)
  assert.ok(g.sources.every((item) => item.kind === 'oscillator' && item.started === 1 && item.stopped > 1))
  assert.ok(voice.end > 1.03 && voice.end < 1.08, 'input cue remains short')
  const envelopes = g.events.filter(([label, operation]) => label.endsWith('.gain') && operation === 'linear')
  assert.equal(envelopes.filter((event) => event[2] > 0 && event[2] <= 0.03).length, 2, 'both voices have restrained audible attack')
  assert.equal(envelopes.filter((event) => event[2] === 0).length, 2, 'both voices reach zero')
  g.sources[0].onended()
  assert.ok(g.nodes[0].connections.size > 0, 'shared output stays connected until final source ends')
  g.sources[1].onended()
  assert.ok(g.nodes.every((item) => item.connections.size === 0), 'finished group releases all graph connections')
})

test('every cue has finite scheduling, nonzero attack and cancellable cleanup', () => {
  for (const sound of sounds) {
    const g = graph()
    const voice = synthesizeSound(g.context, g.destination, sound, 2, -0.4)
    assert.ok(g.sources.length > 0, `${sound}: scheduled sound`)
    assert.ok(voice.end > 2 && voice.end < 8, `${sound}: bounded duration`)
    assert.ok(g.events.some(([label, operation, value]) => label.endsWith('.gain') && operation === 'linear' && value > 0), `${sound}: nonzero envelope`)
    voice.stop(2.01)
    assert.ok(g.sources.every((item) => Math.abs(item.stopped - 2.03) < 1e-9), `${sound}: cancellation stops all sources`)
    for (const item of g.sources) item.onended()
    assert.ok(g.nodes.every((item) => item.connections.size === 0), `${sound}: cleanup`)
  }
})

test('25 Hz repeated typing schedules independently and releases every voice', () => {
  const g = graph({ forbidBuffers: true })
  for (let index = 0; index < 50; index++) synthesizeSound(g.context, g.destination, 'key', index / 25)
  assert.equal(g.sources.length, 100)
  for (const item of g.sources) item.onended()
  assert.ok(g.nodes.every((item) => item.connections.size === 0))
})

test('non-key graph and envelopes match the previous version', { skip: !process.env.INTERFACE_AUDIO_BASELINE }, async () => {
  const previous = await synthesis(await fs.readFile(process.env.INTERFACE_AUDIO_BASELINE, 'utf8'))
  for (const sound of sounds.filter((item) => item !== 'key')) {
    const before = graph(), after = graph()
    const a = previous(before.context, before.destination, sound, 3, 0.4)
    const b = synthesizeSound(after.context, after.destination, sound, 3, 0.4)
    assert.equal(a.end, b.end, `${sound}: duration unchanged`)
    a.stop(3.02); b.stop(3.02)
    for (const item of before.sources) item.onended()
    for (const item of after.sources) item.onended()
    assert.deepEqual(after.events, before.events, `${sound}: sources, routing, seeded noise, envelopes and cancellation unchanged`)
  }
})
