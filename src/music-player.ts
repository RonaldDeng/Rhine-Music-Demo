import type { MusicTrack } from "./music-types";

export interface MusicPlayerState {
  currentTrack: MusicTrack | null;
  queue: readonly MusicTrack[];
  currentIndex: number;
  playing: boolean;
  loading: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  bgmVolume: number;
  bgmEnabled: boolean;
  bgmPlaying: boolean;
  error: string | null;
  bgmError: string | null;
  /** This preview uses browser decoding; it does not imply a foobar2000 connection. */
  backend: "browser";
}

type Listener = (state: MusicPlayerState) => void;
type Transport = "idle" | "loading" | "playing" | "paused" | "error";
type Fade = { timer: ReturnType<typeof setTimeout>; finish: () => void };

const unit = (value: number) => Math.max(0, Math.min(1, value));
const seconds = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** Music transport is independent from TerminalAudio and the Three.js scene lifecycle. */
export class MusicPlayer {
  private value: MusicPlayerState;
  private listeners = new Set<Listener>();
  private song?: HTMLAudioElement;
  private readonly bgm: HTMLAudioElement;
  private transport: Transport = "idle";
  private operation = 0;
  private bgmOperation = 0;
  private bgmTarget = 0;
  private bgmTask: Promise<void> = Promise.resolve();
  private fade?: Fade;
  private gestureReceived = false;
  private disposed = false;
  private pendingSeek: number | null = null;

  constructor(
    options: { volume?: number; bgmVolume?: number; bgmEnabled?: boolean } = {},
  ) {
    this.value = {
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      playing: false,
      loading: false,
      duration: 0,
      currentTime: 0,
      volume: Number.isFinite(options.volume) ? unit(options.volume!) : 0.7,
      bgmVolume: Number.isFinite(options.bgmVolume)
        ? unit(options.bgmVolume!)
        : 0.18,
      bgmEnabled: options.bgmEnabled ?? true,
      bgmPlaying: false,
      error: null,
      bgmError: null,
      backend: "browser",
    };
    this.bgm = new Audio("/audio/atmosphere.ogg");
    this.bgm.loop = true;
    this.bgm.preload = "none";
    this.bgm.volume = 0;
    this.bgm.addEventListener("error", this.onBgmError);
    document.addEventListener("pointerdown", this.onGesture, { capture: true });
    document.addEventListener("keydown", this.onGesture, { capture: true });
    // Intentionally no visibilitychange handler: music must continue in the background.
  }

  get state(): MusicPlayerState {
    return { ...this.value, queue: [...this.value.queue] };
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setQueue(tracks: readonly MusicTrack[]): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    const queue = tracks.filter((track) => {
      if (seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });
    const id = this.value.currentTrack?.id;
    const index = queue.findIndex((track) => track.id === id);
    this.value.queue = queue;
    if (id && index === -1) {
      this.stop();
      this.value.currentTrack = null;
      this.value.duration = 0;
    } else if (index !== -1) {
      this.value.currentTrack = queue[index];
    }
    this.value.currentIndex = index;
    this.emit();
  }

  async play(id: string): Promise<void> {
    if (this.disposed) return;
    const index = this.value.queue.findIndex((track) => track.id === id);
    if (index === -1) {
      this.value.error = "这首歌曲已不在播放队列中，请重新选择。";
      this.emit();
      return;
    }
    const track = this.value.queue[index];
    const request = ++this.operation;
    const resume =
      this.value.currentTrack?.id === id && this.song && !this.song.ended;
    if (!resume) this.releaseSong();
    this.value.currentTrack = track;
    this.value.currentIndex = index;
    this.value.error = null;
    this.value.loading = true;
    this.transport = "loading";
    if (!resume) {
      this.value.playing = false;
      this.value.currentTime = 0;
      this.value.duration = seconds(track.duration);
    }
    const unsupported = this.unsupported(track);
    if (unsupported) {
      this.fail(unsupported);
      return;
    }
    const audio = this.song ?? this.createSong(track);
    this.emit();

    // A shared transition promise keeps rapid BGM toggles from bypassing this silence gate.
    await this.reconcileBgm();
    if (request !== this.operation || this.disposed || this.song !== audio)
      return;
    try {
      await audio.play();
      if (request !== this.operation || this.disposed || this.song !== audio) {
        if (this.song !== audio || !this.expectsSong()) audio.pause();
        return;
      }
      if (!audio.paused) {
        this.transport = "playing";
        this.value.playing = true;
        this.value.loading = false;
        this.emit();
      }
    } catch (error) {
      if (request !== this.operation || this.disposed || this.song !== audio)
        return;
      this.fail(this.playbackError(track, error));
    }
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.transport === "loading" || this.transport === "playing") {
      ++this.operation;
      this.transport = "paused";
      this.song?.pause();
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
      await this.reconcileBgm();
      return;
    }
    const track = this.value.currentTrack ?? this.value.queue[0];
    if (track) await this.play(track.id);
  }

  async next(): Promise<void> {
    if (this.disposed) return;
    const track = this.value.queue[this.value.currentIndex + 1];
    if (track) await this.play(track.id);
    else this.stop();
  }

  async previous(): Promise<void> {
    if (this.disposed) return;
    if (this.value.currentTime > 3 && this.song) {
      this.seek(0);
      return;
    }
    const track = this.value.queue[Math.max(0, this.value.currentIndex - 1)];
    if (track) {
      if (track.id === this.value.currentTrack?.id) this.seek(0);
      await this.play(track.id);
    }
  }

  seek(position: number): void {
    if (this.disposed || !this.song || !Number.isFinite(position)) return;
    const duration = seconds(this.song.duration) || this.value.duration;
    const target = Math.max(
      0,
      duration > 0 ? Math.min(duration, position) : position,
    );
    this.pendingSeek = target;
    if (this.song.readyState >= 1) this.applySeek(this.song);
    this.value.currentTime = target;
    this.emit();
  }

  stop(): void {
    if (this.disposed) return;
    ++this.operation;
    this.transport = "idle";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.currentTime = 0;
    this.value.error = null;
    this.emit();
    void this.reconcileBgm();
  }

  setVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.volume = unit(volume);
    if (this.song) this.song.volume = this.value.volume;
    this.emit();
  }

  setBgmVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.bgmVolume = unit(volume);
    this.emit();
    void this.reconcileBgm();
  }

  setBgmEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.value.bgmEnabled = enabled;
    this.value.bgmError = null;
    this.emit();
    void this.reconcileBgm();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.operation;
    ++this.bgmOperation;
    this.cancelFade();
    this.releaseSong();
    this.bgm.pause();
    this.bgm.removeEventListener("error", this.onBgmError);
    this.bgm.removeAttribute("src");
    this.bgm.load();
    document.removeEventListener("pointerdown", this.onGesture, {
      capture: true,
    });
    document.removeEventListener("keydown", this.onGesture, { capture: true });
    this.listeners.clear();
  }

  private createSong(track: MusicTrack): HTMLAudioElement {
    const audio = new Audio();
    this.song = audio;
    audio.preload = "metadata";
    audio.volume = this.value.volume;
    const active = () => !this.disposed && this.song === audio;
    audio.addEventListener("loadedmetadata", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.applySeek(audio);
      this.emit();
    });
    audio.addEventListener("durationchange", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.emit();
    });
    audio.addEventListener("timeupdate", () => {
      if (!active() || this.pendingSeek !== null) return;
      this.value.currentTime = seconds(audio.currentTime);
      this.emit();
    });
    audio.addEventListener("playing", () => {
      if (!active() || audio.paused) return;
      if (this.transport !== "loading" && this.transport !== "playing") {
        audio.pause();
        return;
      }
      this.transport = "playing";
      this.value.playing = true;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("waiting", () => {
      if (!active() || this.transport !== "playing") return;
      this.value.loading = true;
      this.emit();
    });
    audio.addEventListener("pause", () => {
      if (
        !active() ||
        this.transport !== "playing" ||
        audio.ended ||
        !audio.paused
      )
        return;
      this.transport = "paused";
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("ended", () => {
      if (!active() || this.transport !== "playing") return;
      this.value.playing = false;
      this.value.loading = false;
      this.value.currentTime = this.value.duration;
      const next = this.value.queue[this.value.currentIndex + 1];
      if (next) {
        // No idle intermediate state, so BGM never appears between songs.
        void this.play(next.id);
      } else {
        ++this.operation;
        this.transport = "idle";
        this.emit();
        void this.reconcileBgm();
      }
    });
    audio.addEventListener("error", () => {
      if (active()) this.fail(this.playbackError(track, audio.error));
    });
    audio.src = `/api/audio/${encodeURIComponent(track.id)}`;
    return audio;
  }

  private applySeek(audio: HTMLAudioElement): void {
    if (this.pendingSeek === null || audio.readyState < 1) return;
    const target = Math.max(
      0,
      seconds(audio.duration) > 0
        ? Math.min(audio.duration, this.pendingSeek)
        : this.pendingSeek,
    );
    try {
      audio.currentTime = target;
      this.pendingSeek = null;
      this.value.currentTime = target;
    } catch {
      // Metadata may still be arriving; retain the user's seek until it is available.
    }
  }

  private releaseSong(): void {
    const old = this.song;
    this.song = undefined;
    this.pendingSeek = null;
    if (!old) return;
    old.pause();
    old.removeAttribute("src");
    old.load();
  }

  private expectsSong(): boolean {
    return this.transport === "loading" || this.transport === "playing";
  }

  private unsupported(track: MusicTrack): string | null {
    if (
      /^(DSD|DSF|DFF)$/i.test(track.format) ||
      /\.(dsf|dff)$/i.test(track.relativePath)
    ) {
      return "DSD 曲目需要支持 DSD 的 foobar2000 及相应解码组件；当前浏览器预览未连接 foobar2000，无法播放此曲目。";
    }
    if (!track.browserPlayable)
      return `${track.format} 无法在当前浏览器预览中播放，请使用配置好解码组件的 foobar2000。`;
    return null;
  }

  private playbackError(track: MusicTrack, error: unknown): string {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError")
      return "浏览器暂未允许播放，请点击播放按钮重试。";
    const media = this.song?.error;
    if (media?.code === 2)
      return "音频读取失败：请检查本地服务和音乐文件是否仍然可用。";
    if (name === "AbortError") return "歌曲播放被中断，请点击播放按钮重试。";
    if (/M4A|ALAC/i.test(`${track.format} ${track.codec ?? ""}`)) {
      return "此 M4A / ALAC 文件未能由当前浏览器解码，或文件已不可用。请确认文件后尝试支持该编码的 foobar2000；本预览未连接 foobar2000。";
    }
    if (
      media?.code === 3 ||
      media?.code === 4 ||
      name === "NotSupportedError"
    ) {
      return `无法播放此 ${track.format} 文件：当前浏览器不支持它的编码，或文件已损坏、不可读取。`;
    }
    return `播放失败，请检查 ${track.format} 文件及本地音乐服务后重试。`;
  }

  private fail(message: string): void {
    ++this.operation;
    this.transport = "error";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.error = message;
    this.emit();
    void this.reconcileBgm();
  }

  private onGesture = (): void => {
    if (this.disposed) return;
    this.gestureReceived = true;
    void this.reconcileBgm();
  };

  private onBgmError = (): void => {
    if (this.disposed) return;
    ++this.bgmOperation;
    this.cancelFade();
    this.bgm.pause();
    this.bgm.volume = 0;
    this.bgmTarget = -1;
    this.value.bgmPlaying = false;
    this.value.bgmError = "氛围配乐无法加载，歌曲播放功能仍可使用。";
    this.emit();
  };

  private reconcileBgm(): Promise<void> {
    const idle = this.transport === "idle" || this.transport === "error";
    const target =
      !this.disposed && this.gestureReceived && this.value.bgmEnabled && idle
        ? this.value.bgmVolume
        : 0;
    if (target === this.bgmTarget) return this.bgmTask;
    this.bgmTarget = target;
    const request = ++this.bgmOperation;
    this.cancelFade();
    this.bgmTask = (async () => {
      if (target > 0) {
        try {
          await this.bgm.play();
          if (this.disposed || request !== this.bgmOperation) {
            if (this.disposed || this.bgmTarget <= 0) this.bgm.pause();
            return;
          }
          this.value.bgmError = null;
          this.value.bgmPlaying = true;
          this.emit();
        } catch {
          if (!this.disposed && request === this.bgmOperation) {
            this.bgmTarget = -1;
            this.value.bgmPlaying = false;
            this.value.bgmError =
              "氛围配乐暂未获准播放或无法读取，请再次点击界面重试。";
            this.emit();
          }
          return;
        }
      }
      if (this.disposed || request !== this.bgmOperation) return;
      await this.fadeBgm(target, target > 0 ? 650 : 220);
      if (this.disposed || request !== this.bgmOperation) return;
      if (target === 0) this.bgm.pause();
      this.value.bgmPlaying = target > 0 && !this.bgm.paused;
      this.emit();
    })();
    return this.bgmTask;
  }

  private fadeBgm(target: number, duration: number): Promise<void> {
    this.cancelFade();
    const start = this.bgm.volume;
    if (this.bgm.paused || Math.abs(start - target) < 0.001) {
      this.bgm.volume = target;
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.fade !== fade) return;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / duration,
        );
        this.bgm.volume = unit(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 24);
        else {
          this.fade = undefined;
          resolve();
        }
      };
      this.fade = fade;
      step();
    });
  }

  private cancelFade(): void {
    if (!this.fade) return;
    const fade = this.fade;
    this.fade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("MusicPlayer state listener failed", error);
      }
    }
  }
}
