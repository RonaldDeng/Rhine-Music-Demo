import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./music-overview.css";
import { version as appVersion } from "../package.json";
import { MusicOverviewUI } from "./music-overview-ui";
import { normalizeMusicArrayMode, type MusicArrayMode } from "./music-array-layout";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { ArchiveScene } from "./scene";
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  orderMusicAlbums,
  type MusicSortMode,
} from "./data";
import { fileAtCell, nearestOccurrence, wrap, type ArchiveNavigation } from "./archive-loop";
import {
  normalizeQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { MusicPlayer, type MusicPlayerState } from "./music-player";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { MusicFrameTiming } from "./music-frame-timing";
import { searchMusicLibrary } from "./music-search";
import { viewportLayout } from "./viewport-layout";
import { setupLightingLab } from "./music-lighting-lab";
import type { LightingLabController, LightingLabSettings } from "./music-lighting-lab";
import { setupMotionLab } from "./music-motion-lab";
import { getMusicMotionSpeed, normalizeMusicMotionSpeed, onMusicMotionSpeedChange, setMusicMotionSpeed } from "./music-motion-settings";
import { mountMusicWheelNavigation } from "./music-wheel-navigation";

// A repeatable visual study that uses only the three bundled sample covers.
const lightingDemo = new URLSearchParams(location.search).get("demo") === "1";
const lightingLab = new URLSearchParams(location.search).get("lab") !== "0";
let lightingControls: LightingLabController | undefined;
let motionControls: ReturnType<typeof setupMotionLab> | undefined;

type Theme = "day" | "night";
type Panel = "library" | "search" | "settings" | null;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
  settings: svg(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
  ),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
};
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    arrayMode: "filled" as MusicArrayMode,
    rememberColumnPosition: true,
    audioBackend: "browser" as "browser" | "coreaudio",
    outputDeviceId: "default",
    quality: "original" as QualityPreset,
    reduced: false,
    volume: 0.65,
    // Leave unset until legacy preferences have been read; a default here
    // would otherwise take precedence over the user's old fade-off choice.
    songTransition: undefined as SongTransitionMode | undefined,
    bgm: true,
    bgmVolume: 0.18,
    sound: true,
    soundVolume: 0.22,
    renderQuality: undefined as RenderQuality | undefined,
    developerMode: false,
    motionDebug: false,
    motionSpeed: 1,
    lighting: undefined as Partial<LightingLabSettings> | undefined,
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      arrayMode: MusicArrayMode;
      rememberColumnPosition: boolean;
      audioBackend: "browser" | "coreaudio";
      outputDeviceId: string;
      quality: QualityPreset;
      reduced: boolean;
      volume: number;
      songTransition: SongTransitionMode;
      songFade: boolean;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      renderQuality: RenderQuality;
      developerMode: boolean;
      motionDebug: boolean;
      motionSpeed: number;
      lighting: Partial<LightingLabSettings>;
    }>
  >("rhine-music-preferences", {}),
};
preferences.songTransition = normalizeSongTransition(preferences.songTransition, preferences.songFade);
delete preferences.songFade;
let renderQuality = normalizeQuality(
  preferences.renderQuality || qualityPresets[preferences.quality],
);
if (!["day", "night"].includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhine-music-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
preferences.developerMode = preferences.developerMode === true;
preferences.motionDebug = preferences.motionDebug === true;
preferences.arrayMode = normalizeMusicArrayMode(preferences.arrayMode);
preferences.rememberColumnPosition = preferences.rememberColumnPosition !== false;
preferences.audioBackend = preferences.audioBackend === "coreaudio" ? "coreaudio" : "browser";
if (typeof preferences.outputDeviceId !== "string") preferences.outputDeviceId = "default";
preferences.motionSpeed = normalizeMusicMotionSpeed(preferences.motionSpeed);
setMusicMotionSpeed(preferences.motionSpeed);
const syncMotionScale = () => document.documentElement.style.setProperty("--music-motion-scale", String(1 / getMusicMotionSpeed()));
syncMotionScale();
onMusicMotionSpeedChange(syncMotionScale);
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
const sortLabel = sortLabels[preferences.sortMode];
let libraryReceived = false,
  scanSubmitting = false;

let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: false,
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
let scene: ArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";
let creditsStarting = false,
  creditsRequestError = "",
  creditsRequestAlbumId: string | undefined;
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
let overview = false;
let overviewRevealPending = false;
const effects = new TerminalAudio();
effects.configure({
  sound: preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let columnMemory = new Map<string, string>();
let playerState: MusicPlayerState;
let outputBusy = false;
let audioOutputsChecked = false;
let outputStatus = "正在检查本机音频输出…";
const player = new MusicPlayer({
  volume: preferences.volume,
  songTransitionMode: preferences.songTransition,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
});
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  night: "深夜",
};
const stage = $("#stage");
stage.className = "music-app";
stage.dataset.mode = "archive";
stage.dataset.theme = preferences.theme;
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><a class="music-brand" href="/" aria-label="Rhine Music 音乐库"><strong>RHINE LAB</strong><span>MUSIC ARCHIVE <i>／</i> 私人音乐终端</span></a></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <button data-action="library" aria-label="音乐库">${icons.folder}<span>音乐库</span></button>
      <button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>
      <div class="theme-switch" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}"><i class="theme-dot ${t}"></i><span>${themeNames[t]}</span></button>`).join("")}</div>
      <button data-action="settings" class="icon-button" aria-label="播放与画质设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><button type="button" data-action="locate-playing" id="transport-track" class="transport-track" aria-label="定位当前歌曲" aria-hidden="true" disabled><span id="transport-track-label"></span></button><button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button><button data-action="stop" id="stop-playback" aria-label="停止">${icons.stop}</button></div>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>正在读取本地音乐索引</span></div>
  <button type="button" class="music-view-toggle" disabled data-action="overview" aria-pressed="false" aria-label="切换缩略图模式">${svg('<rect x="3" y="3" width="6" height="7"/><rect x="15" y="3" width="6" height="7"/><rect x="3" y="14" width="6" height="7"/><rect x="15" y="14" width="6" height="7"/>')}<span>缩略图模式</span><kbd>V</kbd></button>
  <section class="music-overview" id="music-overview" aria-label="音乐库缩略图总览" hidden>
    <div class="overview-heading"><small>COLLECTION / OVERVIEW</small><h2>${sortLabel.name}浏览收藏</h2><p>点击列名展开入口 · 点击进入回到标准视图</p></div>
    <div class="overview-columns" id="overview-columns"></div>
    <button type="button" class="overview-return" data-action="overview-return" aria-label="返回标准视图">${svg('<path d="M15 5l-7 7 7 7"/>')}<span>返回近景</span><kbd>V</kbd></button>
    <nav class="overview-controls" aria-label="总览列导航"><button data-action="genre-prev" aria-label="总览上一列">←</button><span>← → 切换${sortLabel.column}</span><button data-action="genre-next" aria-label="总览下一列">→</button></nav>
  </section>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code">ALBUM <span id="selection-code-number">001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open">打开专辑 <span>↗</span></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${sortLabel.column}">←</button><div><small id="genre-position">${sortLabel.code} <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${sortLabel.column}">→</button></div>
    </div>
    <div class="music-keyhint">← → ${sortLabel.column} <span>／</span> ↑ ↓ 或滚轮切专辑 <span>／</span> ENTER 打开专辑</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC</kbd></button>
    <div class="card-caption"><span id="detail-card-id"></span><small>拖动卡片，查看完整封面</small></div>
    <article id="album-detail-content" tabindex="-1"></article>
  </section>
  <div id="music-empty" class="music-empty" hidden><small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>选择本地音乐文件夹，专辑封面会出现在每一张卡片上。</p><button data-action="library">设置音乐文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示封面</button></div>
  <div class="music-bottomline"><span>LOCAL COLLECTION <i>·</i> <span id="library-count">0 ALBUMS</span></span><span id="runtime-info">THREE.JS / LOCAL / V${appVersion}</span></div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading"><span class="loading-orbit"></span><strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small></div>
`;
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
  // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  return albums.find((a) => a.id === records[selected]?.id);
}
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-artist, .album-facts span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
);
const overviewUI = new MusicOverviewUI($("#music-overview"), $("#overview-columns"), () => {
  const target = overview ? $(".overview-return") : $('[data-action="overview"]');
  target.focus({ preventScroll: true });
});
let detailIdentity = "",
  pendingDetailFocus = false;
const trackFocus = new MusicTrackFocus();
let pendingTrackReveal: { albumId: string; trackId: string } | undefined;
function cancelTrackReveal() {
  pendingTrackReveal = undefined;
  trackFocus.cancel();
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingTrackReveal) cancelTrackReveal();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => !!scene?.musicArchiveReady && scene.musicOverviewProgress < .02,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation }) => commitSelection(index, navigation),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    if (next === "detail" && overview) setOverview(false, false);
    mode = next;
    stage.dataset.mode = next;
    syncSelectionMotion();
  },
  prepareMenu: () => {
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    const detail = $("#music-detail"), content = $("#album-detail-content");
    detailTransition.show(preferences.reduced);
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  onStart: () => {
    setOverview(false, false);
    cancelTrackReveal();
    presentation.reset();
    syncAlbumNavigation();
    detailTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
  },
});
function showBrowseSurface() {
  syncAlbumNavigation();
  if (!albums.length || boot?.active) return;
  if (overview) { $("#music-browse").inert = true; return; }
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  if (!panel) $("[data-action=open]").focus({ preventScroll: true });
}
function setOverview(active: boolean, reveal = true) {
  if (active && (!ready || !albums.length || boot?.active || panel || mode !== "archive")) return;
  overview = active;
  overviewRevealPending = !active && reveal;
  scene?.setMusicOverview(active);
  stage.dataset.overview = String(active);
  const toggle = $<HTMLButtonElement>('[data-action="overview"]');
  toggle.setAttribute("aria-pressed", String(active));
  for (const item of stage.querySelectorAll<HTMLElement>(".music-topnav > :not(.minimal-transport)")) item.inert = active;
  toggle.inert = active || !!panel;
  overviewUI.setActive(active, preferences.reduced);
  $("#music-overview").inert = !active || !!panel;
  $("#music-browse").inert = active || !!panel;
  $("#music-browse").setAttribute("aria-hidden", String(active));
  if (active) {
    browseTransition.hide(preferences.reduced);
    // Focus the return control after its visible entrance, never a hidden toggle.
  }
}
function updateOverview() {
  if (!scene || (!overview && $("#music-overview").hidden)) return;
  overviewUI.update(scene.getOverviewColumns(), stage.clientWidth, stage.clientHeight,
    scene.musicOverviewProgress, preferences.reduced, sortLabel.column);
}
function savePrefs() {
  save("rhine-music-preferences", preferences);
}
async function copyPerformanceReport() {
  const host = $("#three-scene");
  const report = {
    version: `${appVersion}-startup`, browser: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    hidden: document.hidden, phase: stage.dataset.musicBoot,
    quality: JSON.parse(host.dataset.renderQuality || "null"),
    preparation: JSON.parse(host.dataset.startupPreparation || "null"),
    frame: frameTiming.snapshot(),
    render: JSON.parse(host.dataset.renderStats || "null"),
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    notify("性能诊断已复制，不包含音乐文件路径、曲名或封面。");
  } catch { notify("浏览器未允许复制，请检查剪贴板权限后重试。"); }
}
function setTheme(theme: Theme) {
  if (theme !== "day" && theme !== "night") theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#0a1220" : "#e8e5e1");
  savePrefs();
}
function fit() {
  // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  scene?.resize();
  viewer?.resize();
  if (mode === "detail") {
    syncTabIndicator(false);
    documentDecryption.refresh();
  }
}
window.addEventListener("resize", fit);

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}
async function loadLibrary(force = false) {
  // The forced first snapshot establishes the music model before scene.load().
  // Hold ordinary polling until preparation finishes so data and 3D columns
  // cannot diverge while applyLibrary() intentionally skips an unready scene.
  if (frameDisposed || ((!ready || document.hidden) && !force)) return;
  if (lightingDemo) {
    if (!libraryReceived || force) {
      demo = true;
      apiAvailable = true;
      await receiveLibrary({ version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false }, true);
    }
    return;
  }
  // Keep the selected cards and cover atlas stable for the opening shot.
  if (boot?.active) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(force), 1000);
    return;
  }
  if (refreshing) return;
  refreshing = true;
  const stateVersion = libraryStateVersion;
  try {
    const next = await request<MusicLibrary>("/api/library");
    if (frameDisposed || ((!ready || document.hidden) && !force)) return;
    apiAvailable = true;
    if (stateVersion === libraryStateVersion && !boot?.active) await receiveLibrary(next, force);
  } catch (error) {
    if (frameDisposed || ((!ready || document.hidden) && !force)) return;
    apiAvailable = false;
    updateStatus();
    updateIntroductionStatus();
    updateCreditsStatus();
    if (force)
      notify(
        `${(error as Error).message}。请使用 npm run music 启动本地音乐服务。`,
      );
  } finally {
    refreshing = false;
  }
  clearTimeout(pollTimer);
  if (frameDisposed || !ready || document.hidden) return;
  pollTimer = setTimeout(
    () => void loadLibrary(),
    library.scan.running ||
      library.enrich?.running ||
      library.introductions?.running ||
      library.credits?.running
      ? 1400
      : 12000,
  );
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanCompleted = libraryReceived && !next.scan.running && !next.scan.error &&
    !!next.scan.finishedAt && next.scan.finishedAt !== previousScan.finishedAt;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const previousCreditsRun = library.credits;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
  const creditsOnly = changed && !force && !demo &&
    JSON.stringify(next.genres) === JSON.stringify(library.genres) &&
    JSON.stringify(next.albums.map(albumWithoutCredits)) === JSON.stringify(library.albums.map(albumWithoutCredits));
  const previousCurrentCredits = JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (library.credits?.running) creditsRequestError = "";
  if (creditsOnly) {
    // Updating credits must not reset the selected column, scene, tracks or scroll.
    const byId = new Map(next.albums.map((album) => [album.id, album]));
    albums = albums.map((album) => byId.get(album.id) || album);
    for (const record of records) {
      const album = byId.get(record.id);
      if (album) record.album = album;
    }
    if (mode === "detail" && previousCurrentCredits !== JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]))
      renderCurrentCredits();
  } else if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  updateCreditsStatus();
  if (previousCreditsRun?.running && library.credits && !library.credits.running)
    notify(creditsRunSummary(library.credits));
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
  if (scanCompleted) notify("音乐库扫描完成，专辑架已更新。");
}
function albumWithoutCredits(album: MusicAlbum) {
  const { producers: _producers, creditsLookup: _lookup, ...detail } = album;
  return detail;
}
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.id;
  const previousAlbum = currentAlbum();
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  albums = orderMusicAlbums(demo ? demoAlbums : library.albums, preferences.sortMode);
  if (!albums.length && overview) setOverview(false, false);
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, preferences.sortMode);
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  columnMemory = new Map(
    archiveColumns.map((name, lane) => [
      name,
      records[columnFiles(lane)[0]]?.id,
    ]),
  );
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    cancelTrackReveal();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    if (intent && "index" in intent)
      select(intent.index, intent.navigation, intent.openAfter, intent.route);
    else if ((intent ? intent.mode === "detail" : reopen) && albums.length)
      presentation.open();
    else showBrowseSurface();
  }
  if (!albums.length) {
    cancelTrackReveal();
    presentation.reset();
  }
  stage.dataset.mode = mode;
  $("#music-empty").hidden = albums.length > 0;
  // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
    // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") detailTransition.hide(true);
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || !!panel;
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail"),
    );
  }
  updateSelection();
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum())) {
    const album = currentAlbum();
    if (previousAlbum && album && previousAlbum.id === album.id &&
        JSON.stringify(albumWithoutCredits(previousAlbum)) === JSON.stringify(albumWithoutCredits(album)))
      renderCurrentCredits();
    else renderDetail();
  }
  updateStatus();
}
function updateStatus() {
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
  $<HTMLButtonElement>('[data-action="overview"]').hidden = !albums.length;
  const label = lightingDemo ? "V0.4.1 · 内置演示封面" : !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : library.credits?.running
            ? `查询制作信息 ${library.credits.completed}/${library.credits.total}`
            : demo
            ? "演示专辑 · 加入音乐后显示真实封面"
            : "";
  $("#library-status span").textContent = label;
  $("#library-status").hidden = !label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running ||
      !!library.credits?.running,
  );
  $("#library-count").textContent = demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
}
function updateSelection(navigation?: ArchiveNavigation) {
  syncAlbumNavigation();
  const a = currentAlbum();
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = columnFiles(location.lane),
    idx = files.indexOf(selected);
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      code: selected + 1,
      genreIndex: location.lane + 1,
      genre: archiveColumns[location.lane],
      genreName: archiveColumns[location.lane],
      format: demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: [
        a.year ? String(a.year) : "年份未提供",
        demo ? "演示封面" : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
    preferences.arrayMode === "filled",
  );
  $("#detail-card-id").textContent =
    `ALBUM / ${String(selected + 1).padStart(3, "0")}`;
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  if (preferences.rememberColumnPosition) columnMemory.set(
    archiveColumns[fileLocation(selected).lane],
    records[selected].id,
  );
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelTrackReveal();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending && navigation && !("cell" in navigation)) {
    // Coalesced key presses still reach the matching physical loop cell.
    if (previous && "axis" in previous && previous.axis === navigation.axis) {
      navigation = { ...navigation, direction: previous.direction + navigation.direction };
    } else if (navigation.axis === "lane" && navigation.row !== undefined) {
      if (previous && "cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane + navigation.direction, row: navigation.row,
        } };
      } else {
        // A pending search or row change may target a different logical column.
        // Compute its relative occurrence before adding the new arrow direction;
        // this offset is invariant across physical loop periods.
        const committedLane = fileLocation(selected).lane;
        const pendingLane = nearestOccurrence(fileLocation(pending.index).lane,
          committedLane, archiveColumns.length);
        navigation = { ...navigation, direction: pendingLane - committedLane + navigation.direction };
      }
    } else if (!preferences.rememberColumnPosition && navigation.axis === "row" && previous) {
      if ("cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane, row: previous.cell.row + navigation.direction,
        } };
      } else if (previous.axis === "lane" && previous.row !== undefined) {
        // A vertical key inside a queued column change must keep that column's
        // accumulated displacement as well as the requested neighboring album.
        navigation = { ...previous, row: previous.row + navigation.direction };
      } else navigation = undefined;
    } else navigation = undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    syncAlbumNavigation();
    return;
  }
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
  syncAlbumNavigation();
}
/** Playback can reuse its open album; other targets take the archive route. */
function revealAlbum(albumId: string, trackId?: string, options: { reuseOpenAlbum?: boolean } = {}) {
  closePanel(() => {
    cancelTrackReveal();
    if (!ready || boot?.active) return;
    const index = records.findIndex((record) => record.id === albumId);
    const album = albums.find((item) => item.id === albumId);
    if (index < 0 || !album || (trackId && !album.tracks.some((track) => track.id === trackId))) {
      notify("这张专辑或歌曲已不在当前音乐库中，请刷新音乐库后重试。");
      return;
    }
    if (options.reuseOpenAlbum && trackId && !libraryRebuilding &&
      currentAlbum()?.id === albumId && presentation.openingOrDetail &&
      !presentation.pendingSelection &&
      ["detail", "opening", "switching"].includes(presentation.phase)) {
      // Preserve the camera and current scroll position. If the album is still
      // entering, the usual detail gate below will wait before revealing it.
      setTab("tracks");
      pendingTrackReveal = { albumId, trackId };
      return;
    }
    if (trackId) pendingTrackReveal = { albumId, trackId };
    if (overview) setOverview(false, false);
    select(index, undefined, true, "archive");
  });
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
/** Pending detail/return requests already define the next input boundary. */
function syncAlbumNavigation() {
  const cursor = navigationSelection();
  const files = records.length ? columnFiles(fileLocation(cursor).lane) : [];
  const ordinal = files.indexOf(cursor);
  const bounded = preferences.arrayMode === "realistic";
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
    button.disabled = !files.length || (bounded && (button.dataset.action === "prev"
      ? ordinal <= 0 : ordinal >= files.length - 1));
  }
}
function stepAlbum(direction: number) {
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length < 2) return;
  const ordinal = files.indexOf(cursor);
  const target = preferences.arrayMode === "realistic"
    ? Math.max(0, Math.min(files.length - 1, ordinal + direction))
    : wrap(ordinal + direction, files.length);
  const delta = preferences.arrayMode === "realistic" ? target - ordinal : direction;
  // A boundary input must not restart a detail handoff or cancel track focus.
  if (!delta) return;
  select(files[target], { axis: "row", direction: delta });
}
/** Column arrows and overview entry obey one browsing-position preference. */
function resolveColumnSelection(lane: number): { index: number; row?: number } {
  const files = columnFiles(lane);
  if (!files.length) return { index: -1 };
  if (preferences.rememberColumnPosition) {
    const remembered = columnMemory.get(archiveColumns[lane]);
    const index = files.find((index) => records[index]?.id === remembered);
    return { index: index ?? files[0] };
  }
  // The rendered rail can still be between targets after rapid input. Sample
  // its actual depth, then preserve that physical occurrence in filled arrays.
  const depth = Math.round(scene?.musicBrowseRowForColumn(lane) ??
    scene?.musicBrowseRow ?? fileLocation(navigationSelection()).row);
  const row = preferences.arrayMode === "realistic"
    ? Math.max(12, Math.min(11 + files.length, depth)) : depth;
  return { index: fileAtCell({ lane, row }), row };
}
function stepGenre(direction: number) {
  overviewUI.collapse();
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  const target = resolveColumnSelection(lane);
  select(target.index, {
    axis: "lane",
    direction,
    row: target.row,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") cancelTrackReveal();
  if (libraryRebuilding) { libraryIntent = { mode: next }; syncAlbumNavigation(); return; }
  if (next === "detail") {
    if (overview) setOverview(false, false);
    if (currentAlbum()) presentation.open();
  } else presentation.back();
  syncAlbumNavigation();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelTrackReveal();
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator();
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  article.innerHTML = `<div class="detail-overline"><span>ALBUM ${String(selected + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div>
    <h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}</p>
    <div class="album-facts">${fields.map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`).join("")}</div>
    <div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" tabindex="${activeTab === "tracks" ? 0 : -1}" aria-selected="${activeTab === "tracks"}" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" tabindex="${activeTab === "about" ? 0 : -1}" aria-selected="${activeTab === "about"}" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div>
    <div id="album-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}">${activeTab === "tracks" ? trackList(a, discs) : albumAbout(a)}</div>`;
  article.scrollTop = scroll;
  syncAlbumNavigation();
  syncTabIndicator(false);
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  updatePlayingRows();
}
function trackList(a: MusicAlbum, discs: number) {
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><p>${demo ? "用于检查封面原始比例与卡片材质。扫描本地音乐库后，这里会显示真实曲目。" : "请检查音乐文件是否完整，并重新扫描音乐库。"}</p><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i title="需要兼容的播放内核"> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>`;
}
function albumAbout(a: MusicAlbum) {
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${!demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>本地目录</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div></section>${producerBlock(a)}`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    const album = albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接，连接后可查询介绍。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "扫描本地音乐文件夹后，即可查询专辑介绍。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "查询会核对专辑、歌手与年份；无法确认的结果不会覆盖已有介绍。";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
function producerBlock(a: MusicAlbum) {
  const retry = a.creditsLookup && a.creditsLookup.status !== "unqueried";
  const disabled = creditsStarting || library.credits?.running || !apiAvailable || creditsCoolingDown(a);
  const groups = groupProducers(a);
  const people = new Set(groups.map((group) => group.person.name.normalize("NFKC").toLocaleLowerCase())).size;
  const tracks = new Set(groups.flatMap((group) => [...group.tracks.keys()])).size;
  return `<section class="producer-section" data-credits-album="${esc(a.id)}"><div class="producer-heading"><div><small>ALBUM CREDITS</small><h3>制作人员</h3></div>${!demo ? `<button data-action="${retry ? "credits-retry" : "credits-album"}" ${disabled ? "disabled" : ""}>${retry ? "重新查询 ↻" : "查询制作信息 ↗"}</button>` : ""}</div>${groups.length ? `<p class="producer-overview">${people} 位参与人员${tracks ? ` · 涉及 ${tracks} 首曲目` : ""}<span>职责按下方曲目记录</span></p><ul class="producer-list">${groups.map((group) => {
    const entries = [...group.tracks.values()];
    const urls = [...new Set(group.entries.map((entry) => entry.url).filter(Boolean))];
    const source = producerSource({ ...group.person, url: urls.length === 1 ? urls[0] : undefined }, a);
    const trackMarkup = entries.length > 1
      ? `<details class="producer-tracks" data-credit-group="${esc(group.key)}"><summary>参与 ${entries.length} 首曲目<span aria-hidden="true">＋</span></summary><ul>${entries.map((track) => `<li><strong>${esc(track.title)}</strong><span>${[...track.roles].map(esc).join(" · ")}</span><small class="producer-source">来源：${[...new Map(track.entries.map((entry) => [entry.url || entry.source, entry])).values()].map((entry) => producerSource(entry, a)).join(" · ")}</small></li>`).join("")}</ul></details>`
      : entries.length === 1 ? `<p class="producer-track-note">参与曲目 · ${esc(entries[0].title)}${group.unscoped.size ? `<span>${[...entries[0].roles].map(esc).join(" · ")}</span>` : ""}</p>` : "";
    return `<li class="producer-person"><strong class="producer-name">${esc(group.person.name)}</strong><div class="producer-roles">${[...group.roles].map(esc).join(" · ")}</div><small class="producer-source">来源：${source}</small>${trackMarkup}${group.unscoped.size ? `<p class="producer-track-note">未细分曲目的署名 · ${[...group.unscoped].map(esc).join(" · ")}</p>` : ""}</li>`;
  }).join("")}</ul>` : "<p>暂无制作资料。可查询 QQ 音乐的曲目参与人员，并保存在本机。</p>"}${!demo ? `<p class="credits-feedback" data-credits-feedback="${esc(a.id)}" role="status" aria-live="polite">${esc(creditsAlbumStatus(a))}</p>` : ""}</section>`;
}
function groupProducers(album: MusicAlbum) {
  type Person = MusicAlbum["producers"][number];
  const groups = new Map<string, {
    key: string;
    person: Person;
    entries: Person[];
    roles: Set<string>;
    unscoped: Set<string>;
    tracks: Map<string, { title: string; roles: Set<string>; entries: Person[] }>;
  }>();
  for (const person of album.producers) {
    const key = JSON.stringify([person.name.trim().normalize("NFKC").toLocaleLowerCase(), person.source]);
    let group = groups.get(key);
    if (!group) {
      group = { key, person, entries: [], roles: new Set(), unscoped: new Set(), tracks: new Map() };
      groups.set(key, group);
    }
    group.entries.push(person);
    group.roles.add(person.role);
    const exactTrack = person.trackId ? album.tracks.find((track) => track.id === person.trackId) : undefined;
    const titleMatches = !exactTrack && person.trackTitle ? album.tracks.filter((track) => track.title === person.trackTitle) : [];
    const trackId = exactTrack?.id || (titleMatches.length === 1 ? titleMatches[0].id : undefined);
    const title = exactTrack?.title || person.trackTitle;
    if (title) {
      const trackKey = trackId || `title:${title}`;
      let track = group.tracks.get(trackKey);
      if (!track) {
        track = { title, roles: new Set(), entries: [] };
        group.tracks.set(trackKey, track);
      }
      track.roles.add(person.role);
      track.entries.push(person);
    } else group.unscoped.add(person.role);
  }
  return [...groups.values()];
}
function producerSource(producer: MusicAlbum["producers"][number], album: MusicAlbum) {
  const name = producer.source === "QQ Music" ? "QQ 音乐"
    : producer.source === "local" ? "本地标签"
    : producer.source === "manual" ? "手动补充" : producer.source;
  const candidate = producer.url || (producer.source === "MusicBrainz" ? album.online?.sourceUrl : undefined);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:")
        return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>`;
    } catch { /* A missing or malformed source URL still keeps its source label. */ }
  }
  return esc(name);
}
function creditsCoolingDown(album: MusicAlbum) {
  return !!album.creditsLookup?.retryAt && Date.parse(album.creditsLookup.retryAt) > Date.now();
}
function creditsAlbumStatus(album: MusicAlbum) {
  if (!apiAvailable) return "本地音乐服务尚未连接，已有制作信息仍可阅读。";
  if (creditsRequestError && creditsRequestAlbumId === album.id)
    return `无法开始查询：${creditsRequestError}。已有制作信息仍然保留。`;
  if (creditsStarting || library.credits?.running)
    return "正在查询制作信息，已有资料仍可阅读，完成后自动更新。";
  const lookup = album.creditsLookup;
  const kept = album.producers.length ? " 已有制作信息仍然保留。" : "";
  const cooldown = creditsCoolingDown(album)
    ? ` 可在 ${new Date(lookup!.retryAt!).toLocaleString("zh-CN")} 后重新查询。` : "";
  if (lookup?.status === "partial")
    return `已取得 ${lookup.matchedTracks || 0} / ${lookup.totalTracks || album.tracks.length} 首曲目的参与人员，尚未覆盖整张专辑。${lookup.error ? ` ${lookup.error}` : ""}${cooldown}`;
  if (lookup?.status === "matched")
    return `制作信息已保存在本机，可离线阅读。${lookup.totalTracks ? ` 已核对 ${lookup.matchedTracks || 0} / ${lookup.totalTracks} 首曲目。` : ""}${cooldown}`;
  if (lookup?.status === "uncertain")
    return `尚无法可靠确认对应曲目，未采用存疑的参与人员。${kept}${cooldown}`;
  if (lookup?.status === "not-found")
    return `本次未找到可核实的制作信息。${kept}${cooldown}`;
  if (lookup?.status === "error")
    return `制作信息查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${kept}${cooldown}`;
  return "在线制作信息尚未查询。按曲目核对参与人员，本地标签和已有资料会保留。";
}
function creditsRunSummary(job: NonNullable<MusicLibrary["credits"]>) {
  return job.error ? `制作信息查询未完成：${job.error}`
    : job.total > 0
      ? `制作信息查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张；曲目覆盖情况见各专辑。`
      : "当前没有需要查询的制作信息，已有缓存和查询冷却期会保留。";
}
function renderCurrentCredits() {
  const album = currentAlbum();
  const section = document.querySelector<HTMLElement>("#album-tab-content .producer-section");
  if (!album || !section || section.dataset.creditsAlbum !== album.id) return;
  const article = $("#album-detail-content");
  const scroll = article.scrollTop;
  const hadFocus = section.contains(document.activeElement);
  const openGroups = new Set([...section.querySelectorAll<HTMLDetailsElement>("details[open]")].map((details) => details.dataset.creditGroup));
  const focusedGroup = (document.activeElement as HTMLElement | null)?.closest<HTMLDetailsElement>("details[data-credit-group]")?.dataset.creditGroup;
  section.outerHTML = producerBlock(album);
  for (const details of document.querySelectorAll<HTMLDetailsElement>("#album-tab-content .producer-tracks")) {
    details.open = openGroups.has(details.dataset.creditGroup);
    if (hadFocus && focusedGroup === details.dataset.creditGroup)
      details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  }
  article.scrollTop = scroll;
  if (hadFocus && !focusedGroup)
    document.querySelector<HTMLButtonElement>("#album-tab-content .producer-section button")?.focus({ preventScroll: true });
}
function updateCreditsStatus() {
  const job = library.credits;
  const running = creditsStarting || !!job?.running;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="credits-album"], [data-action="credits-retry"]',
  )) {
    const album = currentAlbum();
    control.disabled = running || !apiAvailable || !album || creditsCoolingDown(album);
  }
  for (const feedback of document.querySelectorAll<HTMLElement>("[data-credits-feedback]")) {
    const album = albums.find((a) => a.id === feedback.dataset.creditsFeedback);
    if (album) feedback.textContent = creditsAlbumStatus(album);
  }
  const button = document.querySelector<HTMLButtonElement>("#credits-refresh");
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length || demo;
    button.textContent = running ? "正在查询制作信息…" : "查询缺失的制作信息 ↗";
  }
  const progress = document.querySelector<HTMLProgressElement>("#credits-progress");
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (creditsStarting && !job?.running) progress.removeAttribute("value");
  }
  const coverage = document.querySelector<HTMLElement>("#credits-coverage");
  if (coverage) {
    const withCredits = library.albums.filter((album) => album.producers.length > 0).length;
    const partial = library.albums.filter((album) => album.creditsLookup?.status === "partial").length;
    coverage.textContent = `已有制作信息 ${withCredits} / ${library.albums.length} 张${partial ? ` · 其中 ${partial} 张在线资料仅覆盖部分曲目` : ""}`;
  }
  const status = document.querySelector<HTMLElement>("#credits-status");
  if (status)
    status.textContent = !apiAvailable ? "本地音乐服务尚未连接，连接后可查询制作信息。"
      : creditsRequestError ? `无法开始查询：${creditsRequestError}`
      : !library.albums.length ? "扫描本地音乐文件夹后，即可查询制作信息。"
      : creditsStarting ? "正在提交制作信息查询…"
      : job?.running
        ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}${job.trackTotal ? ` · 曲目 ${job.trackCompleted || 0} / ${job.trackTotal}` : ""}`
        : job ? creditsRunSummary(job)
          : "按需补充并缓存在本机；已有缓存不重复查询。重新核对单张专辑时，请使用详情中的重新查询。";
}
function updatePlayingRows() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
}
let lastPlayerError = "";
let lastTransitionWarning = "";
const transportTitleMotion = setupTransportTitle(
  $<HTMLButtonElement>("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
player.subscribe((state) => {
  playerState = state;
  const transport = $(".minimal-transport");
  transport.dataset.backend = state.backend;
  transport.dataset.transport = state.transport;
  transport.dataset.position = String(state.currentTime);
  transport.dataset.duration = String(state.duration);
  const titleVisible = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
  $("#play-pause").title = state.currentTrack
    ? `${state.playing ? "暂停" : "播放"}：${state.currentTrack.title}`
    : "播放当前专辑";
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  if (state.transitionWarning && state.transitionWarning !== lastTransitionWarning && !state.error)
    notify(state.transitionWarning);
  lastTransitionWarning = state.transitionWarning || "";
  updatePlayingRows();
  syncAudioOutputUI();
});

function audioOutputMarkup() {
  return `<section class="panel-section"><h3>音频输出</h3><label class="settings-row"><span>输出方式<small>歌曲播放使用的音频内核</small></span><select id="audio-backend" aria-label="音频输出方式"><option value="browser">浏览器输出</option><option value="coreaudio">Mac 原生 CoreAudio</option></select></label><label class="settings-row" id="audio-device-row"><span>输出设备<small>仅改变本播放器的歌曲输出</small></span><select id="audio-device" aria-label="音频输出设备"></select></label><p id="audio-output-status" role="status"></p><button class="text-button" data-action="refresh-output">刷新输出设备 ↻</button><p>APE、FLAC、WAV 等格式在本机解码；DSF / DFF 在本机转为 PCM 播放，源文件保持不变。原生输出直接连接所选设备；浏览器输出沿用浏览器的声音设备。</p></section>`;
}
function syncAudioOutputUI() {
  const backend = document.querySelector<HTMLSelectElement>("#audio-backend");
  if (!backend || !playerState) return;
  backend.value = playerState.backend;
  backend.disabled = outputBusy || !apiAvailable || lightingDemo;
  backend.options[1].disabled = !playerState.nativeAvailable;
  const device = $<HTMLSelectElement>("#audio-device");
  const items = playerState.outputDevices;
  const key = JSON.stringify(items);
  if (device.dataset.devices !== key) {
    device.innerHTML = items.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    device.dataset.devices = key;
  }
  device.value = playerState.outputDeviceId;
  device.disabled = outputBusy || playerState.backend !== "coreaudio";
  $("#audio-device-row").hidden = playerState.backend !== "coreaudio";
  $("#audio-output-status").textContent = lightingDemo ? "演示模式只展示封面；请通过音乐播放器启动器使用音频输出。" :
    !apiAvailable ? "请通过音乐播放器启动器连接本机音频服务。" : outputBusy ? "正在连接音频输出…" :
    playerState.outputError || playerState.transitionWarning || outputStatus;
  $<HTMLButtonElement>('[data-action="refresh-output"]').disabled = outputBusy || !apiAvailable || lightingDemo;
}
async function refreshAudioOutputs(restore = false) {
  if (lightingDemo || !apiAvailable) { syncAudioOutputUI(); return; }
  outputBusy = true; syncAudioOutputUI();
  try {
    const capabilities = await player.refreshOutputs();
    audioOutputsChecked = true;
    outputStatus = capabilities.decoderAvailable ? capabilities.nativeAvailable ?
      "本机解码与 CoreAudio 已就绪。" : "本机解码已就绪；原生输出暂不可用。" :
      "未检测到 FFmpeg，当前仅可播放浏览器支持的格式。";
    if (restore && preferences.audioBackend === "coreaudio")
      await player.setBackend("coreaudio", preferences.outputDeviceId);
  } catch (error) { outputStatus = (error as Error).message; }
  finally { outputBusy = false; syncAudioOutputUI(); }
}
async function changeAudioOutput(backend: "browser" | "coreaudio", deviceId: string) {
  if (outputBusy) return;
  outputBusy = true; syncAudioOutputUI();
  try {
    if (backend !== playerState.backend) await player.setBackend(backend, deviceId);
    else await player.setOutputDevice(deviceId);
    preferences.audioBackend = player.state.backend;
    preferences.outputDeviceId = player.state.outputDeviceId;
    savePrefs();
    outputStatus = backend === "coreaudio" ? "歌曲通过 Mac 原生设备输出。" : "歌曲通过浏览器输出。";
  } catch (error) { outputStatus = (error as Error).message; notify(outputStatus); }
  finally { outputBusy = false; syncAudioOutputUI(); }
}

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  if (!panel) {
    after?.();
    return;
  }
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  panelTransition?.hide(preferences.reduced, () => {
    panel = null;
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    if (overview) $("#music-browse").inert = true;
    $("#music-overview").inert = !overview;
    $<HTMLButtonElement>('[data-action="overview"]').inert = overview;
    $("#music-detail").inert = presentation.phase !== "detail";
    stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = false; });
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
function openPanel(next: Panel) {
  if (!next) return closePanel();
  cancelTrackReveal();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  $("#music-overview").inert = true;
  $<HTMLButtonElement>('[data-action="overview"]').inert = true;
  stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = true; });
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
    settings: ["SYSTEM SETTINGS", "播放与画质"],
  };
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim" data-action="dismiss-panel"><section class="music-panel" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${titles[next][1]}</h2></div><button data-action="close-panel" aria-label="关闭">×</button></div><div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, $(".music-panel"));
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
function renderLibraryPanel() {
  $("#panel-body").innerHTML =
    `<p class="panel-intro">根目录中的每首单曲各是一张卡片，优先使用自身内嵌封面。子文件夹按专辑展示，优先使用文件夹封面。</p><label class="field-label" for="music-roots">音乐文件夹<span>多个目录各占一行</span></label><textarea id="music-roots" rows="3" placeholder="/Users/你的用户名/Music">${esc(library.roots.map((r) => r.path).join("\n"))}</textarea><div class="panel-actions"><button class="primary-button" data-action="scan">保存目录并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n, a) => n + a.tracks.length, 0)}</b><span>曲目</span></div><div><b>${library.genres.filter((g) => library.albums.some((a) => a.genreId === g.id)).length}</b><span>流派</span></div></div><section class="panel-section"><h3>本地分类</h3><p>编辑展示流派、别名与专辑人工分类；不修改音乐文件的标签。</p><button data-action="edit-genres" class="text-button">编辑流派归并规则 ↗</button></section><section class="panel-section"><h3>封面显示</h3><p>方形、竖版、横版封面均保持原始比例，完整放入卡片正面。没有封面时显示专辑名称占位，不使用其他专辑的图片。</p>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示封面 ↗</button>' : ""}</section>`;
  updateScanStatus();
}
function renderMusicBrainzSettings() {
  const configSection = document.querySelector<HTMLElement>("#online-config");
  if (!configSection) return;
  void (async () => {
    try {
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
      }>("/api/config");
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">MusicBrainz 联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><p>按 MusicBrainz 要求用于标识本应用的资料请求，不用于注册或订阅。</p><label class="settings-row"><span>扫描后自动补充新专辑资料<small>已有缓存不重复查询；断网仍可浏览与播放</small></span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置。" : "尚未配置；本地曲库和播放已可使用。"}</p>`;
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`;
  renderSearchResults();
}
let searchGenre = "";
function renderSearchResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const result of searchMusicLibrary(albums, genres, query, searchGenre)) {
    const a = result.album;
    if (result.kind === 'album') {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    } else {
      const track = result.track!;
      // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式<small>切换后自动刷新页面</small></span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label><p>按歌手时，同一歌手的专辑放在同一列；按专辑名时，按拼音或字母顺序排列，每 12 张一列。</p></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    <section class="panel-section" id="credits-settings"><h3>制作信息</h3><p>从 QQ 音乐核对曲目的参与人员，在姓名下方注明来源。保留本地标签与已有资料，查询结果保存在本机。</p><p id="credits-coverage"></p><button class="primary-button" id="credits-refresh" data-action="credits-library">查询缺失的制作信息 ↗</button><progress id="credits-progress" aria-label="制作信息查询进度" max="1" value="0" hidden></progress><p id="credits-status" class="scan-status" role="status" aria-live="polite"></p></section>
    <section class="panel-section"><h3>高级设置 · 专辑阵列</h3><label class="settings-row"><span>专辑列显示<small>改变阵列数量，保留当前选择和播放</small></span><select id="music-array-mode" aria-label="专辑列显示方式"><option value="filled" ${preferences.arrayMode === "filled" ? "selected" : ""}>填充画面</option><option value="realistic" ${preferences.arrayMode === "realistic" ? "selected" : ""}>真实专辑列</option></select></label><p>填充画面：循环摆放封面，铺满视野。真实专辑列：每张专辑只摆放一次，各列独立居中；上下浏览到本列首尾时停止。</p><label class="settings-row"><span>保留每列浏览位置<small>开启后记住每列上次的位置；关闭后保持画面深度，选中邻近专辑</small></span><input type="checkbox" id="remember-column-position" ${preferences.rememberColumnPosition ? "checked" : ""}></label></section>
    ${audioOutputMarkup()}
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><button class="text-button" data-action="fullscreen">切换全屏 ↗</button><button class="text-button" data-action="replay-boot">重播开场 ↗</button><button class="text-button" data-action="reload-interface">重新载入界面 ↻</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>歌曲衔接<small>选择切换歌曲时的音量过渡</small></span><select id="song-fade-setting" aria-label="歌曲衔接方式"><option value="fade-out" ${preferences.songTransition === "fade-out" ? "selected" : ""}>淡出但不淡入</option><option value="fade-in-out" ${preferences.songTransition === "fade-in-out" ? "selected" : ""}>淡出淡入</option><option value="gapless" ${preferences.songTransition === "gapless" ? "selected" : ""}>无缝播放</option></select></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，停止后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>歌曲输出方式可在上方选择。界面音效和氛围音乐仍由浏览器播放，音量分别控制。</p></section>
    <details class="panel-section" id="musicbrainz-settings"><summary>高级设置 · MusicBrainz</summary><p>向 MusicBrainz 查询专辑名称与艺术家，补充流派和制作人员；音乐文件留在本机。已有资料使用缓存，人工分类优先保留。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button><div id="online-config"><p>正在读取资料库设置…</p></div></details>
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  if (lightingLab) $("#panel-body").insertAdjacentHTML("beforeend", `
    <section class="panel-section" id="developer-settings">
      <h3>开发者调试模式</h3>
      <label class="settings-row"><span>光效调试面板<small>调节光带节奏、亮度和范围</small></span><input type="checkbox" id="developer-mode" aria-label="光效调试面板" ${preferences.developerMode ? "checked" : ""}></label>
      <label class="settings-row"><span>动画速度调试面板<small>统一调节专辑、镜头、文字与光带速度</small></span><input type="checkbox" id="developer-motion" aria-label="动画速度调试面板" ${preferences.motionDebug ? "checked" : ""}></label>
      <p>两个面板可以同时打开。调节即时生效、自动保存在本机，无需刷新；收起或关闭面板仍保留效果。</p>
      <button class="text-button" data-action="lighting-debug" ${preferences.developerMode ? "" : "hidden"}>打开光效调试面板 ↗</button>
      <button class="text-button" data-action="motion-debug" ${preferences.motionDebug ? "" : "hidden"}>打开动画速度调试面板 ↗</button>
      <button class="text-button" data-action="copy-performance">复制性能诊断 ↗</button>
    </section>`);
  renderMusicBrainzSettings();
  updateQuality();
  updateIntroductionStatus();
  updateCreditsStatus();
  syncAudioOutputUI();
  if (!audioOutputsChecked && !outputBusy) void refreshAudioOutputs(true);
}
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `渲染 ${renderQuality.scale}% · 像素上限 ${renderQuality.pixelRatio}× · ${renderQuality.antialias === "off" ? "原始抗锯齿" : "SMAA"}`;
  savePrefs();
}
async function editGenres() {
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<p class="panel-intro">这里编辑展示流派、别名和专辑人工分类。保存后重新归并本地索引，不修改音频标签。</p><label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(saveRoots = false) {
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  ++libraryStateVersion;
  try {
    const roots = saveRoots
      ? $<HTMLTextAreaElement>("#music-roots")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const next = await request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
    ++libraryStateVersion; // Discard polls started before this accepted scan.
    notify("开始扫描音乐库，已有专辑可以继续浏览。");
    await receiveLibrary(next);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 600);
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich(one = false) {
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: true,
    });
    // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始，可在设置中查看进度。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}
async function queryCredits(one = false, force = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (creditsStarting || library.credits?.running) return;
  if (one && creditsCoolingDown(album!)) {
    notify(creditsAlbumStatus(album!));
    return;
  }
  creditsStarting = true;
  creditsRequestError = "";
  creditsRequestAlbumId = one ? album!.id : undefined;
  updateCreditsStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/credits", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force,
    });
    ++libraryStateVersion;
    apiAvailable = true;
    const previousRunning = library.credits?.running;
    await receiveLibrary(next);
    if (next.credits?.running)
      notify(`${one ? "这张专辑" : "音乐库"}的制作信息查询已开始，完成后自动显示；已有资料仍可阅读。`);
    else if (!previousRunning && next.credits)
      notify(creditsRunSummary(next.credits));
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    creditsRequestError = (error as Error).message;
    notify(`无法开始制作信息查询：${creditsRequestError}`);
  } finally {
    creditsStarting = false;
    updateCreditsStatus();
  }
}
function playAlbum(id?: string) {
  const a = currentAlbum();
  if (!a?.tracks.length || a.offline) return;
  void player.play(id || a.tracks[0].id, a.tracks);
}

document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  if (target.dataset.overviewLane !== undefined) {
    overviewUI.expand(Number(target.dataset.overviewLane));
    return;
  }
  if (target.dataset.overviewEnterLane !== undefined) {
    const lane = Number(target.dataset.overviewEnterLane);
    if (!overviewUI.canEnter(lane)) return;
    const targetColumn = resolveColumnSelection(lane);
    const navigation = targetColumn.row === undefined ? undefined : {
      cell: scene?.musicColumnCell(lane, targetColumn.row) ?? { lane, row: targetColumn.row },
      guided: true,
    };
    // The shared preference chooses an album; reveal browse text only after the
    // rail and near camera settle. Entry never opens album details.
    select(targetColumn.index, navigation, false);
    setOverview(false);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (target.dataset.track) {
    playAlbum(target.dataset.track);
    return;
  }
  if (target.dataset.select) {
    const rulerStep = Number(target.dataset.rulerStep);
    select(Number(target.dataset.select),
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (target.dataset.album) {
    revealAlbum(target.dataset.album, target.dataset.searchTrack);
    return;
  }
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  const action = target.dataset.action;
  if (["library", "search", "settings"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  switch (action) {
    case "copy-performance":
      void copyPerformanceReport();
      break;
    case "reload-interface":
      disposePage();
      location.reload();
      break;
    case "refresh-output":
      void refreshAudioOutputs();
      break;
    case "overview-return":
      setOverview(false);
      break;
    case "overview":
      setOverview(!overview);
      break;
    case "replay-boot":
      closePanel(() => { setOverview(false, false); boot?.replay(); });
      break;
    case "lighting-debug":
      closePanel(() => {
        setMode("archive");
        lightingControls?.focus();
      });
      break;
    case "motion-debug":
      closePanel(() => {
        setMode("archive");
        motionControls?.focus();
      });
      break;
    case "locate-playing": {
      const track = playerState.currentTrack;
      if (track) revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true });
      break;
    }
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    case "open":
      setMode("detail");
      break;
    case "back":
      setMode("archive");
      break;
    case "model-viewer":
      // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "fullscreen":
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    case "genres":
      openPanel("search");
      break;
    case "play-pause":
      playerState.currentTrack ? void player.toggle() : playAlbum();
      break;
    case "stop":
      player.stop();
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "credits-album":
      void queryCredits(true);
      break;
    case "credits-retry":
      void queryCredits(true, true);
      break;
    case "credits-library":
      void queryCredits();
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "edit-genres":
      void editGenres();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });
          notify("资料库设置已保存。可以开始补充专辑资料。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);
          notify("分类规则已保存并应用。");
          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.quality && el.type === "range") {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "bgm-volume") {
    preferences.bgmVolume = Number(el.value) / 100;
    player.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "album-search") renderSearchResults();
  if (el.id === "volume") {
    preferences.volume = Number(el.value) / 100;
    player.setVolume(preferences.volume);
    savePrefs();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "audio-backend") {
    void changeAudioOutput(el.value === "coreaudio" ? "coreaudio" : "browser", playerState.outputDeviceId);
  }
  if (el.id === "audio-device") void changeAudioOutput(playerState.backend, el.value);
  if (el.id === "developer-mode") {
    preferences.developerMode = el.checked;
    lightingControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="lighting-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "developer-motion") {
    preferences.motionDebug = el.checked;
    motionControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="motion-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    location.reload();
    return;
  }
  if (el.id === "music-array-mode") {
    preferences.arrayMode = normalizeMusicArrayMode(el.value);
    scene?.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    updateSelection();
    savePrefs();
  }
  if (el.id === "remember-column-position") {
    preferences.rememberColumnPosition = el.checked;
    // Changing this preference never navigates or changes playback. Re-enabling
    // starts with the current album while other columns retain their session memory.
    if (el.checked && records[selected]) columnMemory.set(
      archiveColumns[fileLocation(selected).lane], records[selected].id,
    );
    savePrefs();
  }
  if (el.id === "quality-preset") {
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    const mode = normalizeSongTransition(el.value);
    preferences.songTransition = mode;
    el.value = mode;
    player.setSongTransitionMode(mode);
    savePrefs();
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
      overviewUI.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
  }
  if (el.id === "bgm-setting") {
    preferences.bgm = el.checked;
    player.setBgmEnabled(el.checked);
    savePrefs();
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
  if (e.key === "Escape") {
    panel ? closePanel() : overview ? setOverview(false) : setMode("archive");
    return;
  }
  if (panel) {
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ].filter((node) => !node.matches(":disabled") && node.tabIndex >= 0 &&
        !node.closest("[hidden], [inert]") && node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== "hidden");
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
    return;
  }
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setOverview(!overview);
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    setMode("detail");
  }
  if (e.code === "Space" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    playerState.currentTrack ? void player.toggle() : playAlbum();
  }
});

let lastFrame: number | undefined;
let frameCount = 0, frameHandle = 0;
let frameDisposed = false, frameSuspended = false;
const frameTiming = new MusicFrameTiming();
let textMotionTime = 0, textMotionLastFrame: number | undefined;
function frame(ms: number) {
  frameHandle = 0;
  if (frameDisposed || frameSuspended) return;
  const workStart = performance.now();
  const textDt = textMotionLastFrame === undefined ? 0 : Math.min(.05, Math.max(0, ms - textMotionLastFrame) / 1000);
  textMotionLastFrame = ms;
  if (!document.hidden && scene) {
    frameTiming.begin(ms);
    if (lastFrame === undefined) lastFrame = ms;
    textMotionTime += textDt * (preferences.reduced ? 1 : getMusicMotionSpeed());
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen && opening?.renderScene !== false) scene.update(ms / 1000, opening?.cinema);
    updateOverview();
    if (overviewRevealPending && !overview && !boot?.active &&
      scene.musicOverviewProgress < .02 && scene.musicArchiveReady) {
      overviewRevealPending = false;
      showBrowseSurface();
    }
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    if (presentation.phase === "detail") {
      documentDecryption.update(
        textMotionTime,
        scene.decryptionFrame,
        preferences.reduced,
        !viewer?.isOpen,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      if (pendingTrackReveal && !panel && !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingTrackReveal.albumId) {
        const content = $("#album-detail-content");
        const trackId = pendingTrackReveal.trackId;
        pendingTrackReveal = undefined;
        const row = Array.from(content.querySelectorAll<HTMLButtonElement>(".track-row"))
          .find((item) => item.dataset.track === trackId);
        if (row) trackFocus.reveal(content, row, preferences.reduced);
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      $("#runtime-info").textContent =
        `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS / ${themeNames[preferences.theme]} / V${appVersion}`;
      // Keep read-only render diagnostics alongside the existing resolution
      // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight, arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
          arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      $("#three-scene").dataset.frameTiming = JSON.stringify(frameTiming.snapshot());
      frameCount = 0;
      lastFrame = ms;
    }
    frameTiming.end(performance.now() - workStart);
  } else {
    resetFrameTiming();
  }
  frameHandle = requestAnimationFrame(frame);
}
function resetFrameTiming() {
  frameCount = 0;
  lastFrame = undefined;
  textMotionLastFrame = undefined;
  frameTiming.reset();
}
function suspendPage() {
  frameSuspended = true;
  cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  clearTimeout(pollTimer);
  resetFrameTiming();
}
function resumePage() {
  if (frameDisposed || document.hidden) return;
  frameSuspended = false;
  resetFrameTiming();
  if (ready && !frameHandle) frameHandle = requestAnimationFrame(frame);
  if (ready) void loadLibrary();
}
function disposePage() {
  if (frameDisposed) return;
  frameDisposed = true;
  suspendPage();
  clearTimeout(toastTimer);
  boot?.dispose();
  overviewUI.dispose();
  player.dispose();
  effects.dispose();
  trackFocus.cancel();
  scene?.dispose();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) suspendPage(); else resumePage();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) suspendPage(); else disposePage();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) resumePage(); });

async function start() {
  // This local application owns its live index. An old archive PWA must not serve stale UI.
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  await loadLibrary(true);
  if (frameDisposed) return;
  try {
    fit();
    scene = new ArchiveScene($("#three-scene"));
    scene.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    // Keep a direct visual comparison URL without adding another user setting.
    if (lightingLab || new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    if (lightingLab) {
      const devPanels = document.createElement("div");
      devPanels.className = "music-dev-panels";
      stage.append(devPanels);
      const closeDebugPanel = (key: "developerMode" | "motionDebug") => {
        preferences[key] = false;
        savePrefs();
        if (panel === "settings") renderSettingsPanel();
        else document.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus({ preventScroll: true });
      };
      motionControls = setupMotionLab(devPanels, {
        enabled: preferences.motionDebug,
        onChange: (speed) => { preferences.motionSpeed = speed; savePrefs(); },
        onClose: () => closeDebugPanel("motionDebug"),
      });
      lightingControls = setupLightingLab(devPanels, {
        setExperiment: (settings) => scene?.setLightingExperiment(settings),
        enabled: preferences.developerMode,
        initial: preferences.lighting,
        onChange: (settings) => {
          preferences.lighting = settings;
          savePrefs();
        },
        onClose: () => closeDebugPanel("developerMode"),
      });
    }
    await Promise.all([
      scene.load(undefined, selected),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("600 20px MiSans"),
    ]);
    if (frameDisposed) return;
    $("#music-loading small").textContent = "正在准备玻璃材质与专辑封面…";
    $("#three-scene canvas").setAttribute(
      "aria-label",
      `三维专辑阵列，左右切${sortLabel.column}，上下切专辑`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    scene.setTheme(preferences.theme);
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    await scene.prepareMusicRenderer();
    if (frameDisposed) return;
    // Browser playback does not need a Swift compiler at startup. A saved
    // native output is restored after graphics preparation; otherwise discover
    // native devices only when the user opens the output settings.
    if (preferences.audioBackend === "coreaudio") {
      $("#music-loading small").textContent = "正在连接已选择的音频设备…";
      await refreshAudioOutputs(true);
    }
    if (frameDisposed) return;
    ready = true;
    $<HTMLButtonElement>('[data-action="overview"]').disabled = false;
    scene.onSelect = (index, cell) => {
      if (!boot?.active && presentation.phase === "archive" && !panel) {
        select(index, cell ? { cell } : undefined);
        if (overview) setOverview(false);
      }
    };
    scene.onNavigate = (axis, direction) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    mountMusicWheelNavigation(stage, {
      enabled: () => ready && !boot?.active && presentation.phase === "archive" && !panel &&
        columnFiles(fileLocation(navigationSelection()).lane).length > 1,
      navigate: stepAlbum,
      context: () => fileLocation(navigationSelection()).lane,
    });
    $("#music-loading").remove();
    updateSelection();
    if (albums.length && new URLSearchParams(location.search).get("scene") !== "archive") {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
    }
    syncSelectionMotion();
    stage.classList.add("theme-motion-ready");
    if (!document.hidden && !frameDisposed) {
      frameSuspended = false;
      resetFrameTiming();
      frameHandle = requestAnimationFrame(frame);
      // Poll only after data, geometry and renderer preparation agree. During
      // the opening loadLibrary() defers updates until its handoff completes.
      void loadLibrary();
    }
  } catch (error) {
    console.error(error);
    if (frameDisposed) return;
    $("#music-loading").innerHTML =
      `<strong>三维资源未能加载</strong><small>${esc((error as Error).message)}</small><button data-action="library">检查音乐库</button>`;
  }
}
void start();
Object.assign(window, {
  rhineMusic: {
    get library() {
      return library;
    },
    get selectedAlbum() {
      return currentAlbum();
    },
    get player() {
      return player.state;
    },
    stats: () => scene?.getStats(),
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});
