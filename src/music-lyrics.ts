import type { MusicAlbum, MusicTrack } from "./music-types";
import type { MusicPlayerState } from "./music-player";
import type { MusicLyricLine, MusicLyricsResult } from "./music-lyrics-types";
import { createRollingText } from "@kitlangton/rolling-number";
import { getMusicMotionSpeed, musicMotionDuration, onMusicMotionSpeedChange } from "./music-motion-settings";
import { followRollingMotionSpeed } from "./music-motion-ui";
import { ContentTransition } from "./ui-transitions";
import { lyricsFontFamily, subscribeLyricsPreferences, type LyricsPreferences } from "./music-lyrics-preferences";
import { lyricGroupAt } from "./music-lyrics-timeline";
import "./music-lyrics.css";
import "./music-lyrics-immersive.css";

export function lyricLineAt(lines: readonly MusicLyricLine[], seconds: number): number {
  return lyricGroupAt(lines, seconds)?.end ?? -1;
}

type Options = {
  album: MusicAlbum;
  state: () => MusicPlayerState;
  reduced: () => boolean;
  play: (trackId: string) => void;
  toggle?: () => void;
  seek: (seconds: number) => void;
};

/** Reuse the archive's 460ms direct reels, retaining complete wrapped titles. */
function createLyricsHeadingMotion(element: HTMLElement, canAnimate: () => boolean) {
  const reel = document.createElement("span"), plain = document.createElement("span"), measure = document.createElement("span");
  reel.className = "lyrics-heading-reel music-rolling-text";
  plain.className = "lyrics-heading-plain";
  measure.className = "lyrics-heading-measure";
  for (const child of [reel, plain, measure]) child.setAttribute("aria-hidden", "true");
  element.replaceChildren(reel, plain, measure);
  const controller = createRollingText(reel, {
    text: "", duration: musicMotionDuration(460), animated: false,
    motionBlur: false, pauseOffscreen: false, transition: "direct", stagger: "none", direction: "up",
  });
  const fade = new ContentTransition(460);
  const unsubscribeSpeed = followRollingMotionSpeed([reel], () => controller.update({ duration: musicMotionDuration(460) }));
  let value = "", displayed = "", font = "", usingReel = false, measured = false, disposed = false, scheduled = 0, enabled = false;
  const setEnabled = (next: boolean) => {
    if (enabled === next) return;
    enabled = next;
    // Enabling the unchanged value rebuilds the library's glyph columns after
    // finish(), so the next track can roll from the current heading immediately.
    controller.update({ animated: next });
  };
  const reconcile = (animate = false) => {
    if (disposed) return;
    const style = getComputedStyle(element);
    const available = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const fits = available > 0 && measure.scrollWidth <= available;
    const nextFont = [style.font, style.letterSpacing, style.lineHeight].join(";");
    const changed = value !== displayed, fontChanged = nextFont !== font;
    const mayRoll = fits && canAnimate();
    if (measured && !changed && !fontChanged && fits === usingReel) {
      setEnabled(mayRoll);
      return;
    }
    const wasReel = usingReel;
    const animated = animate && canAnimate();
    usingReel = fits; measured = true; font = nextFont; displayed = value;
    reel.style.display = fits ? "inline-block" : "none";
    plain.style.display = fits ? "none" : "inline";
    const rollChange = animated && fits && wasReel && !fontChanged;
    setEnabled(rollChange);
    controller.update({ text: value });
    if (fontChanged) controller.refresh();
    // Non-animated layout work still prepares this value as the next reel's
    // starting point. Keep it enabled while visible instead of leaving plain text.
    setEnabled(mayRoll);
    if (changed && animated && !rollChange) fade.reveal(fits ? reel : plain, false);
    else fade.cancel();
  };
  const schedule = () => {
    if (!disposed && !scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; reconcile(); });
  };
  const fontsChanged = () => { font = ""; schedule(); };
  const resize = new ResizeObserver(schedule); resize.observe(element);
  document.fonts.addEventListener("loadingdone", fontsChanged);
  void document.fonts.ready.then(fontsChanged);
  return {
    update(next: string, animate: boolean) {
      if (next !== value) {
        value = next; plain.textContent = next; measure.textContent = next;
        element.title = next; element.setAttribute("aria-label", next);
      }
      reconcile(animate);
    },
    refresh: schedule,
    finish() { setEnabled(false); controller.finish(); fade.cancel(); schedule(); },
    destroy() {
      disposed = true; cancelAnimationFrame(scheduled); resize.disconnect(); unsubscribeSpeed();
      document.fonts.removeEventListener("loadingdone", fontsChanged); fade.cancel(); controller.destroy();
      element.textContent = value;
    },
  };
}

/** One reading surface synchronized to the real playback clock. */
export class MusicLyricsPane {
  private selected?: MusicTrack;
  private lastPlaybackTrackId?: string;
  private result?: MusicLyricsResult;
  private visible = false;
  private disposed = false;
  private operation = 0;
  private request?: AbortController;
  private activeLine = -2;
  private autoFollow = true;
  private followTimer = 0;
  private scrollFrame = 0;
  private scrollUnsubscribe?: () => void;
  private layoutFrame = 0;
  private fontRevision = 0;
  private highlightAnchor: LyricsPreferences["highlightAnchor"] = "center";
  private reducedMedia = matchMedia("(prefers-reduced-motion: reduce)");
  private action?: () => void;
  private cleanups: Array<() => void> = [];
  private lines: HTMLButtonElement[] = [];
  private surface: HTMLElement;
  private viewport: HTMLElement;
  private flow: HTMLElement;
  private title: HTMLElement;
  private performer: HTMLElement;
  private message: HTMLElement;
  private messageText: HTMLElement;
  private messageAction: HTMLButtonElement;
  private recover: HTMLButtonElement;
  private headingMotion: ReturnType<typeof createLyricsHeadingMotion>[];

  constructor(private root: HTMLElement, private options: Options) {
    const playing = options.state().currentTrack;
    this.lastPlaybackTrackId = playing?.id;
    this.selected = options.album.tracks.find(track => track.id === playing?.id) ?? options.album.tracks[0];
    root.innerHTML = `<div class="lyrics-immersive">
      <header class="lyrics-song-heading"><h2 class="lyrics-song"></h2><p class="lyrics-performer"></p></header>
      <div class="lyrics-viewport" tabindex="0" role="region" aria-label="同步歌词，可滚动阅读；空格播放或暂停">
        <div class="lyrics-flow"></div>
      </div>
      <div class="lyrics-message" role="status" hidden><p></p><button type="button" hidden></button></div>
      <button type="button" class="lyrics-recover" hidden>回到当前歌词</button>
    </div>`;
    this.surface = root.querySelector(".lyrics-immersive")!;
    this.viewport = root.querySelector(".lyrics-viewport")!;
    this.flow = root.querySelector(".lyrics-flow")!;
    this.title = root.querySelector(".lyrics-song")!;
    this.performer = root.querySelector(".lyrics-performer")!;
    this.message = root.querySelector(".lyrics-message")!;
    this.messageText = this.message.querySelector("p")!;
    this.messageAction = this.message.querySelector("button")!;
    this.recover = root.querySelector(".lyrics-recover")!;
    const canAnimate = () => this.visible && !this.options.reduced() && !this.reducedMedia.matches && !document.hidden;
    this.headingMotion = [this.title, this.performer].map(element => createLyricsHeadingMotion(element, canAnimate));
    this.updateHeading();
    this.listen(this.messageAction, "click", () => this.action?.());
    this.listen(this.recover, "click", () => this.restoreFollow());
    this.listen(this.viewport, "wheel", () => this.manualScroll(), { passive: true });
    this.listen(this.viewport, "touchstart", () => this.manualScroll(), { passive: true });
    this.listen(this.viewport, "pointerdown", event => {
      if (!(event.target as Element).closest(".lyrics-verse")) this.manualScroll();
    });
    this.listen(this.viewport, "keydown", event => {
      const key = (event as KeyboardEvent).key;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(key)) this.manualScroll();
    });
    this.listen(this.flow, "click", event => {
      const line = (event.target as Element).closest<HTMLElement>("[data-lyric-line]");
      const time = line && this.result?.lines[Number(line.dataset.lyricLine)]?.time;
      if (typeof time !== "number") return;
      this.autoFollow = true; this.recover.hidden = true; clearTimeout(this.followTimer);
      if (options.state().currentTrack?.id === this.selected?.id) options.seek(time);
      this.syncLine(true, false);
    });
    const resize = new ResizeObserver(() => this.scheduleLayout());
    resize.observe(this.viewport);
    resize.observe(this.flow);
    this.cleanups.push(() => resize.disconnect());
    this.cleanups.push(subscribeLyricsPreferences(preferences => this.applyPreferences(preferences)));
    this.listen(document.fonts, "loadingdone", () => this.scheduleLayout());
    this.listen(this.reducedMedia, "change", () => {
      if (this.reducedMedia.matches) this.finishMotion();
      else if (this.visible) this.headingMotion.forEach(motion => motion.refresh());
    });
    this.listen(document, "visibilitychange", () => {
      if (document.hidden) this.suspend();
      else if (this.visible) {
        this.headingMotion.forEach(motion => motion.refresh());
        this.syncLine(true);
      }
    });
    this.listen(window, "pagehide", () => this.suspend());
    this.listen(window, "pageshow", () => {
      if (this.visible && !document.hidden) {
        this.headingMotion.forEach(motion => motion.refresh());
        this.syncLine(true);
      }
    });

  }

  setVisible(visible: boolean) {
    if (this.disposed) return;
    this.visible = visible;
    if (!visible) {
      this.suspend();
      // Stop this view's lookup immediately; reopening can start a fresh request.
      if (this.request) {
        this.operation++; this.request.abort(); this.request = undefined;
        this.root.removeAttribute("aria-busy");
      }
      return;
    }
    this.autoFollow = true; this.recover.hidden = true;
    this.headingMotion.forEach(motion => motion.refresh());
    this.scheduleLayout();
    if (!this.result && !this.request) void this.load(false);
    else { this.syncLine(true); }
  }

  updatePlayback(state: MusicPlayerState) {
    if (this.disposed) return;
    // Continuous listening follows the playing track across album boundaries.
    // A different album opened for browsing keeps its own reading surface.
    const followingPlayback = this.visible && !!this.selected && this.selected.id === this.lastPlaybackTrackId;
    const track = state.currentTrack && (this.options.album.tracks.find(item => item.id === state.currentTrack?.id)
      ?? (followingPlayback ? state.currentTrack : undefined));
    this.lastPlaybackTrackId = state.currentTrack?.id;
    if (track && track.id !== this.selected?.id) {
      this.cancelScroll(); this.operation++; this.request?.abort(); this.request = undefined;
      this.selected = track; this.result = undefined; this.updateHeading(this.visible);
      if (this.visible) void this.load(false);
    }
    if (this.visible) this.syncLine();
  }

  togglePlayback() {
    if (this.options.state().currentTrack?.id === this.selected?.id) this.options.toggle?.();
    else if (this.selected) this.options.play(this.selected.id);
  }

  finishMotion() { this.headingMotion.forEach(motion => motion.finish()); this.cancelScroll(); this.syncLine(true); }
  dispose() {
    this.disposed = true; this.operation++; this.request?.abort();
    this.suspend();
    this.headingMotion.forEach(motion => motion.destroy());
    this.cleanups.forEach(cleanup => cleanup()); this.cleanups = [];
  }

  private listen(target: EventTarget, name: string, fn: (event: Event) => void, options?: AddEventListenerOptions) {
    target.addEventListener(name, fn, options);
    this.cleanups.push(() => target.removeEventListener(name, fn, options));
  }
  private updateHeading(animate = false) {
    this.headingMotion[0].update(this.selected?.title || this.options.album.title, animate);
    this.headingMotion[1].update(this.selected?.artist || this.options.album.artist, animate);
  }
  private applyPreferences(preferences: LyricsPreferences) {
    this.highlightAnchor = preferences.highlightAnchor;
    this.surface.dataset.highlightAnchor = preferences.highlightAnchor;
    const family = lyricsFontFamily(preferences);
    // Verse typography stays independent of album titles and metadata.
    this.surface.style.setProperty("--lyrics-font-family", family);
    this.surface.style.setProperty("--lyrics-font-size", `${preferences.fontSize}px`);
    this.scheduleLayout();
    const revision = ++this.fontRevision;
    void document.fonts.load(`500 ${preferences.fontSize}px ${family}`, "歌词 Music").then(() => {
      if (!this.disposed && revision === this.fontRevision) this.scheduleLayout();
    }).catch(() => {});
  }
  private scheduleLayout() {
    if (this.disposed || this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      if (!this.visible || !this.viewport.clientHeight) return;
      this.surface.style.setProperty("--lyrics-viewport-height", `${this.viewport.clientHeight}px`);
      // A manual reading hold stays a hold after settings, font loading or
      // resize. syncLine only moves the viewport while autoFollow is enabled.
      this.cancelScroll(); this.syncLine(true);
    });
  }
  private showMessage(text = "", label = "", action?: () => void) {
    this.message.hidden = !text && !label; this.messageText.textContent = text;
    this.messageAction.hidden = !label; this.messageAction.textContent = label; this.action = action;
  }
  private suspend() {
    this.cancelScroll(); clearTimeout(this.followTimer);
    cancelAnimationFrame(this.layoutFrame); this.layoutFrame = 0;
    this.headingMotion.forEach(motion => motion.finish());
  }
  private manualScroll() {
    if (this.result?.status !== "synced") return;
    this.autoFollow = false; this.cancelScroll(); this.recover.hidden = false;
    clearTimeout(this.followTimer);
    // Reading hold is real time, independent of visual animation speed.
    this.followTimer = window.setTimeout(() => this.restoreFollow(), 4200);
  }
  private restoreFollow() {
    clearTimeout(this.followTimer); this.autoFollow = true; this.recover.hidden = true;
    this.syncLine(true, false);
  }

  private async load(refresh: boolean) {
    if (this.disposed) return;
    if (!this.selected) { this.showMessage("这张专辑还没有曲目"); return; }
    this.cancelScroll(); clearTimeout(this.followTimer); this.autoFollow = true; this.recover.hidden = true;
    const operation = ++this.operation, trackId = this.selected.id;
    this.request?.abort(); this.request = new AbortController();
    const controller = this.request, timeout = setTimeout(() => controller.abort(), 30000);
    this.root.setAttribute("aria-busy", "true");
    this.showMessage("正在查找歌词…");
    this.result = undefined; this.activeLine = -2; this.lines = []; this.flow.replaceChildren();
    try {
      const response = await fetch(`/api/lyrics/${encodeURIComponent(trackId)}`, {
        method: refresh ? "POST" : "GET", signal: controller.signal,
        ...(refresh ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ online: true }) } : {}),
      });
      const result: MusicLyricsResult = await response.json();
      if (!response.ok) throw new Error("暂时无法读取歌词");
      if (operation !== this.operation || this.disposed || trackId !== this.selected?.id) return;
      if (!Array.isArray(result.lines) || result.trackId !== trackId) throw new Error("歌词响应与当前曲目不符");
      this.result = result; this.render();
    } catch {
      if (operation !== this.operation || this.disposed) return;
      this.showMessage("暂时无法读取歌词", "重试", () => void this.load(true));
    } finally {
      clearTimeout(timeout);
      if (operation === this.operation && !this.disposed) { this.request = undefined; this.root.removeAttribute("aria-busy"); }
    }
  }

  private render() {
    const result = this.result!;
    this.flow.replaceChildren(); this.lines = []; this.viewport.scrollTop = 0;
    result.lines.forEach((line, index) => {
      const button = document.createElement("button"); button.type = "button";
      button.className = "lyrics-verse"; button.dataset.lyricLine = String(index);
      button.textContent = line.text || "\u00a0"; button.setAttribute("aria-current", "false");
      this.flow.append(button); this.lines.push(button);
    });
    this.viewport.hidden = !result.lines.length;
    this.surface.dataset.lyricsStatus = result.status;
    this.surface.dataset.timed = String(result.status === "synced");
    if (result.status === "not-found") this.showMessage(result.message || "暂未找到匹配的歌词", "重新查找", () => void this.load(true));
    else if (result.status === "error") this.showMessage(result.message || "暂时无法读取歌词", "重试", () => void this.load(true));
    else if (result.status === "instrumental") this.showMessage("纯音乐");
    else this.showMessage();
    this.activeLine = -2; this.syncLine(true);
  }

  private syncLine(force = false, immediate = force) {
    if (!this.visible || !this.result || !this.selected || document.hidden) return;
    const state = this.options.state(), same = state.currentTrack?.id === this.selected.id;
    const seconds = same ? state.currentTime : -1;
    this.surface.dataset.currentTime = String(seconds);
    this.lines.forEach((line, i) => { line.disabled = this.result!.lines[i].time === null || !same; });
    if (this.result.lines.length) {
      // A genuine playback action only appears until this song is selected.
      if (!same) this.showMessage("", "播放此曲", () => this.options.play(this.selected!.id));
      else this.showMessage();
    }
    const group = lyricGroupAt(this.result.lines, seconds);
    const active = group?.start ?? -1;
    if (active !== this.activeLine || force) {
      this.activeLine = active;
      this.lines.forEach((line, index) => {
        const current = !!group && index >= group.start && index <= group.end;
        line.classList.toggle("is-current", current); line.setAttribute("aria-current", String(current));
        const distance = group ? index < group.start ? group.start - index : index > group.end ? index - group.end : 0 : 1;
        line.dataset.distance = String(Math.min(3, distance));
      });
      if (group && this.autoFollow) this.center(this.lines[group.start], this.lines[group.end], immediate);
      else this.cancelScroll();
    }
  }

  private cancelScroll() {
    cancelAnimationFrame(this.scrollFrame); this.scrollFrame = 0;
    this.scrollUnsubscribe?.(); this.scrollUnsubscribe = undefined;
  }
  private center(first: HTMLElement, last: HTMLElement, immediate: boolean) {
    this.cancelScroll();
    // Use rectangles to account for flow padding and ancestor scaling.
    const bounds = this.viewport.getBoundingClientRect();
    const scale = bounds.height / this.viewport.offsetHeight || 1;
    const start = this.viewport.scrollTop;
    const firstTop = first.getBoundingClientRect().top;
    const groupCenter = (firstTop + last.getBoundingClientRect().bottom) / 2;
    const anchor = this.highlightAnchor === "top" ? 0 : this.viewport.clientHeight * .43;
    const groupPosition = this.highlightAnchor === "top" ? firstTop : groupCenter;
    const target = Math.max(0, Math.min(this.viewport.scrollHeight - this.viewport.clientHeight,
      start + (groupPosition - bounds.top) / scale - anchor));
    if (immediate || this.options.reduced() || this.reducedMedia.matches) { this.viewport.scrollTop = target; return; }
    let elapsed = 0, previous = performance.now(), speed = getMusicMotionSpeed();
    const advance = (now: number) => { elapsed += Math.max(0, now - previous) * speed; previous = Math.max(previous, now); };
    this.scrollUnsubscribe = onMusicMotionSpeedChange(next => { advance(performance.now()); speed = next; });
    const frame = (now: number) => {
      if (this.disposed || !this.visible || !this.autoFollow || document.hidden) { this.cancelScroll(); return; }
      advance(now);
      const p = this.options.reduced() || this.reducedMedia.matches ? 1 : Math.min(1, elapsed / 600);
      const ease = p ** 3 * (10 - 15 * p + 6 * p ** 2);
      this.viewport.scrollTop = start + (target - start) * ease;
      if (p < 1) this.scrollFrame = requestAnimationFrame(frame); else this.cancelScroll();
    };
    this.scrollFrame = requestAnimationFrame(frame);
  }
}
