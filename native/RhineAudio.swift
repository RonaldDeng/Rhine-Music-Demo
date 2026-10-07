// Rhine Music · macOS shared-mode output. JSON-lines bridge over private stdin/stdout.
import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

func audioDevices() -> [[String: Any]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var bytes: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &bytes) == noErr, bytes > 0 else { return nil }
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        var prop = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        _ = AudioObjectGetPropertyData(id, &prop, 0, nil, &nameSize, &name)
        return ["id": String(id), "name": name?.takeRetainedValue() as String? ?? "Audio output"]
    }
}

func defaultOutputDevice() throws -> AudioDeviceID {
    var device: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr, device != 0 else { throw BridgeError(message: "系统默认输出设备不可用") }
    return device
}
struct BridgeError: Error { let message: String }
enum SongTransitionMode: String {
    case fadeOut = "fade-out"
    case fadeInOut = "fade-in-out"
    case gapless = "gapless"
}
final class Output {
    let engine = AVAudioEngine()
    // Two file-streaming nodes share one engine clock. The spare can be cancelled
    // without clearing the current node's schedule or restarting its transport.
    let players = [AVAudioPlayerNode(), AVAudioPlayerNode()]
    var activeSlot = 0
    var player: AVAudioPlayerNode { players[activeSlot] }
    var nodeTokens = [0, 0]
    struct PreparedNext {
        let file: AVAudioFile
        let trackId: String
        let slot: Int
    }
    var next: PreparedNext?
    var boundarySerial = 0
    var segmentOutputFrames: AVAudioFramePosition = 0
    var file: AVAudioFile?
    var trackId = ""
    var deviceId = "default"
    var boundDevice: AudioDeviceID = 0
    var base: Double = 0
    var generation = 0
    var endedSerial = 0
    var playing = false
    var desiredVolume: Float = 0.7
    var fadeGeneration = 0
    var transitionMode = SongTransitionMode.fadeInOut
    var fadingIn = false
    var lastError: String?
    init() { for node in players { engine.attach(node) } }
    func connectPlayers(for file: AVAudioFile) {
        // Reserve stereo even when the first file is mono, so an ordinary album
        // can change between mono/stereo without dropping the right channel.
        let format = AVAudioFormat(standardFormatWithSampleRate: file.processingFormat.sampleRate, channels: max(2, file.processingFormat.channelCount))!
        for node in players {
            engine.disconnectNodeOutput(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
        }
    }
    var duration: Double { guard let file else { return 0 }; return Double(file.length) / file.processingFormat.sampleRate }
    var position: Double {
        guard playing, let time = player.lastRenderTime, let sample = player.playerTime(forNodeTime: time) else { return base }
        return min(duration, max(0, base + max(0, Double(sample.sampleTime)) / sample.sampleRate))
    }
    func state() -> [String: Any] {
        advanceQueueIfNeeded()
        var value: [String: Any] = ["trackId": trackId, "playing": playing, "currentTime": position, "duration": duration, "volume": desiredVolume, "deviceId": deviceId, "endedSerial": endedSerial, "transitionMode": transitionMode.rawValue, "nextTrackId": next?.trackId ?? "", "boundarySerial": boundarySerial, "outputSampleRate": player.outputFormat(forBus: 0).sampleRate]
        if let lastError { value["error"] = lastError }
        return value
    }
    func setDevice(_ id: String) throws {
        advanceQueueIfNeeded(); cancelNext()
        let offset = position, resume = playing
        generation += 1; player.stop(); engine.stop(); playing = false; base = offset
        var device: AudioDeviceID
        if id == "default" {
            device = try defaultOutputDevice()
        } else {
            guard let parsed = UInt32(id), audioDevices().contains(where: { $0["id"] as? String == id }) else { throw BridgeError(message: "所选输出设备已断开，请重新选择") }
            device = parsed
        }
        guard let unit = engine.outputNode.audioUnit else { throw BridgeError(message: "CoreAudio 输出单元不可用") }
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard status == noErr else { throw BridgeError(message: "无法选择输出设备（CoreAudio \(status)）") }
        deviceId = id; boundDevice = device
        if file != nil { try schedule(at: offset, play: resume) }
    }
    func schedule(at offset: Double, play: Bool) throws {
        advanceQueueIfNeeded(); cancelNext()
        guard let file else { return }
        generation += 1
        cancelFade()
        player.stop(); playing = false
        base = min(duration, max(0, offset))
        let start = AVAudioFramePosition(base * file.processingFormat.sampleRate)
        let frames = file.length - start
        guard frames > 0 else { if play { endedSerial += 1 }; return }
        guard frames <= AVAudioFramePosition(UInt32.max) else { throw BridgeError(message: "音频长度超过原生引擎当前限制") }
        segmentOutputFrames = outputFrames(file, frames: frames)
        enqueue(file, start: start, frames: frames, slot: activeSlot)
        if play {
            if !engine.isRunning { try engine.start() }
            player.volume = transitionMode == .fadeInOut ? 0 : desiredVolume
            player.play(); playing = true
            if transitionMode == .fadeInOut { fade(to: desiredVolume) }
        }
    }
    func outputFrames(_ file: AVAudioFile, frames: AVAudioFramePosition? = nil) -> AVAudioFramePosition {
        // Prepared files share this rate, so the boundary is an exact WAV frame.
        frames ?? file.length
    }
    func enqueue(_ file: AVAudioFile, start: AVAudioFramePosition, frames: AVAudioFramePosition, slot: Int) {
        nodeTokens[slot] += 1
        let token = nodeTokens[slot], serial = generation
        players[slot].scheduleSegment(file, startingFrame: start, frameCount: AVAudioFrameCount(frames), at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.generation == serial, self.nodeTokens[slot] == token, self.playing else { return }
                self.advanceQueueIfNeeded()
                // Rendering has already crossed the shared clock boundary; this
                // callback only updates metadata, never starts the next source.
                if self.activeSlot == slot {
                    if self.next != nil { self.promoteNext() }
                    else { self.base = self.duration; self.playing = false; self.endedSerial += 1 }
                }
            }
        }
    }
    func advanceQueueIfNeeded() {
        guard playing, next != nil, let time = player.lastRenderTime,
              let elapsed = player.playerTime(forNodeTime: time), elapsed.isSampleTimeValid else { return }
        if Double(elapsed.sampleTime) / elapsed.sampleRate >= Double(segmentOutputFrames) / player.outputFormat(forBus: 0).sampleRate {
            promoteNext()
        }
    }
    func promoteNext() {
        guard let prepared = next else { return }
        next = nil
        activeSlot = prepared.slot; file = prepared.file; trackId = prepared.trackId; base = 0
        segmentOutputFrames = outputFrames(prepared.file)
        boundarySerial += 1
    }
    func cancelNext() {
        advanceQueueIfNeeded()
        guard let prepared = next else { return }
        next = nil; nodeTokens[prepared.slot] += 1; players[prepared.slot].stop()
    }
    func prepareNext(path: String, trackId id: String, afterTrackId: String?) throws {
        advanceQueueIfNeeded()
        guard transitionMode == .gapless, playing, file != nil else { throw BridgeError(message: "当前未在无缝模式播放，无法预备下一首") }
        guard afterTrackId == nil || afterTrackId == trackId else { throw BridgeError(message: "当前歌曲已改变，已取消过期预备") }
        if next?.trackId == id { return }
        cancelNext()
        let prepared = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        guard prepared.length > 0, prepared.length <= AVAudioFramePosition(UInt32.max) else { throw BridgeError(message: "下一首音频长度超出原生引擎限制") }
        guard prepared.processingFormat.channelCount <= player.outputFormat(forBus: 0).channelCount else { throw BridgeError(message: "下一首声道数增加，需要重新配置输出；本次无法无缝接续") }
        let rate = player.outputFormat(forBus: 0).sampleRate
        guard prepared.processingFormat.sampleRate == rate else { throw BridgeError(message: "下一首尚未转换到当前输出采样率，无法准确无缝接续") }
        guard let boundary = player.nodeTime(forPlayerTime: AVAudioTime(sampleTime: segmentOutputFrames, atRate: rate)), boundary.isSampleTimeValid else { throw BridgeError(message: "音频时钟尚未就绪，请重试预备") }
        let slot = 1 - activeSlot, standby = players[slot]
        standby.stop()
        enqueue(prepared, start: 0, frames: prepared.length, slot: slot)
        standby.prepare(withFrameCount: 4096)
        guard let now = player.lastRenderTime, now.isSampleTimeValid,
              Double(boundary.sampleTime) / boundary.sampleRate - Double(now.sampleTime) / now.sampleRate > 0.02 else {
            nodeTokens[slot] += 1; standby.stop()
            throw BridgeError(message: "下一首未能在当前歌曲结束前准备完成")
        }
        standby.volume = desiredVolume
        next = PreparedNext(file: prepared, trackId: id, slot: slot)
        // Apple player-node times are relative to each start; nodeTime converts
        // the exact outgoing end to their common engine clock (also offline).
        standby.play(at: boundary)
    }
    func fade(to target: Float) {
        cancelFade()
        let token = fadeGeneration, start = player.volume
        fadingIn = target > start
        for step in 1...28 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(step) * 0.016) { [weak self] in
                guard let self, self.fadeGeneration == token else { return }
                let p = Float(step) / 28
                self.player.volume = start + (target - start) * (p * p * (3 - 2 * p))
                if step == 28 { self.fadingIn = false }
            }
        }
    }
    func cancelFade() { fadeGeneration += 1; fadingIn = false }
    func setTransition(_ mode: SongTransitionMode) {
        if mode != transitionMode { cancelNext() }
        transitionMode = mode
        if mode != .fadeInOut && fadingIn {
            cancelFade()
            player.volume = desiredVolume
        }
    }
    func command(_ value: [String: Any]) throws -> [String: Any] {
        lastError = nil
        advanceQueueIfNeeded()
        let action = value["action"] as? String ?? "state"
        if let requested = value["transitionMode"] {
            guard let text = requested as? String, let mode = SongTransitionMode(rawValue: text) else { throw BridgeError(message: "无效歌曲衔接方式") }
            setTransition(mode)
        } else if let requested = value["fadeEnabled"] {
            guard let fade = requested as? Bool else { throw BridgeError(message: "无效淡入淡出设置") }
            setTransition(fade ? .fadeInOut : .gapless)
        }
        switch action {
        case "devices": return ["devices": audioDevices()]
        case "state":
            if deviceId == "default", boundDevice != 0, try defaultOutputDevice() != boundDevice {
                try setDevice("default")
            }
            if deviceId != "default", !audioDevices().contains(where: { $0["id"] as? String == deviceId }) {
                cancelNext(); let offset = position; generation += 1; player.stop(); playing = false; base = offset
                lastError = "所选输出设备已断开，请重新选择"
            }
            if playing && !engine.isRunning {
                cancelNext(); let offset = position; generation += 1; player.stop(); playing = false; base = offset
                lastError = "CoreAudio 输出已停止，设备配置可能已改变，请重新播放"
            }
        case "device": try setDevice(value["deviceId"] as? String ?? "default")
        case "prepareNext":
            guard let path = value["path"] as? String, let id = value["trackId"] as? String else { throw BridgeError(message: "缺少下一首音频") }
            if let serial = value["afterBoundarySerial"] as? Int, serial != boundarySerial { throw BridgeError(message: "当前歌曲已接续，已取消过期预备") }
            try prepareNext(path: path, trackId: id, afterTrackId: value["afterTrackId"] as? String)
        case "cancelNext": cancelNext()
        case "transition":
            guard value["transitionMode"] != nil || value["fadeEnabled"] != nil else { throw BridgeError(message: "缺少歌曲衔接方式") }
        case "play":
            if let requestedVolume = value["volume"] as? Double { desiredVolume = Float(max(0, min(1, requestedVolume))) }
            if let location = value["path"] as? String {
                cancelNext(); generation += 1; cancelFade(); for node in players { node.stop() }; engine.stop(); playing = false
                file = try AVAudioFile(forReading: URL(fileURLWithPath: location))
                trackId = value["trackId"] as? String ?? ""
                connectPlayers(for: file!)
                try setDevice(value["deviceId"] as? String ?? deviceId)
                try schedule(at: value["position"] as? Double ?? 0, play: true)
            } else { try schedule(at: base >= duration ? 0 : base, play: true) }
        case "pause":
            cancelNext(); let offset = position; generation += 1; cancelFade(); player.stop(); playing = false; base = offset
        case "seek": try schedule(at: value["position"] as? Double ?? 0, play: playing)
        case "stop":
            cancelNext(); generation += 1; cancelFade(); for node in players { node.stop() }; playing = false; base = 0; trackId = ""; file = nil; engine.stop()
        case "volume":
            desiredVolume = Float(max(0, min(1, value["volume"] as? Double ?? 0.7)))
            cancelFade(); for node in players { node.volume = desiredVolume }
        case "fadeOut": fade(to: 0)
        default: throw BridgeError(message: "未知音频指令")
        }
        return state()
    }
}
let output = Output()
func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            let id = value["id"] ?? 0
            do { reply(["id": id, "result": try output.command(value)]) }
            catch { reply(["id": id, "error": (error as? BridgeError)?.message ?? error.localizedDescription]) }
        }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
