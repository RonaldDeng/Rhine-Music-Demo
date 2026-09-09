import { BootSequence } from "./boot";
import { bootMotion } from "./boot-motion";
import { logo } from "./brand";
import "./music-boot.css";

const START_TIME = 1.76; // Original footage 6.76 s; bootMotion adds its 5 s offset.
const END_TIME = 35; // Original footage 40 s, including the 3D album extraction.
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const typed = (text: string, frame: number, start: number, end: number) =>
  text.slice(
    0,
    frame < start
      ? 0
      : Math.min(
          text.length,
          1 + Math.floor(((frame - start) * (text.length - 1)) / (end - start)),
        ),
  );

/** Text-only adaptation; geometry and animation values remain in the original bootMotion. */
export function musicBootText(appTime: number) {
  const motion = bootMotion(appTime);
  const frame = motion.f;
  let status = "";
  if (frame < 363) {
    status = typed("LIBRARY READY", frame, 282, 295);
    if (frame >= 320) status += " : " + typed("LOCAL MUSIC", frame, 321, 339);
  } else if (frame < 421) {
    status = typed("OPENING LIBRARY", frame, 367, 389);
  } else {
    status = typed("PREPARING AUDIO", frame, 423, 440);
    if (frame >= 449)
      status += ".".repeat(Math.min(3, 1 + Math.floor((frame - 449) / 4)));
    if ([479, 485, 486].includes(frame)) status = "             AUDIO...";
  }
  return {
    access: "OPENING YOUR MUSIC LIBRARY".slice(0, motion.access.length),
    status,
    scan: "MUSIC LIBRARY READY",
    welcome: "WELCOME TO",
    company: "RHINE MUSIC",
    database: "YOUR MUSIC LIBRARY",
  };
}

export interface MusicBootFrame {
  /** Pass to scene.update(nowSeconds, frame.cinema), using the original cinema API. */
  cinema: { reveal: number; lift: number; zoom: number; time: number };
  renderScene: boolean;
  phase:
    | "access"
    | "logo"
    | "auth"
    | "scan"
    | "welcome"
    | "array"
    | "select"
    | "inspect";
  appTime: number;
}

export interface MusicBootOptions {
  /** Called after the overlay captures the underlying UI. Set scene.setMode("hidden") here. */
  onStart?: () => void;
  /** Natural completion can enter album detail; a skip normally enters the album array. */
  onComplete?: (reason: "complete" | "skip") => void;
  reduced?: boolean | (() => boolean);
  album?: () => { title: string; artist?: string } | null | undefined;
}

type SavedSibling = {
  node: HTMLElement;
  inert: boolean;
  visibility: string;
  priority: string;
};

/**
 * Music-only host for BootSequence; the legacy boot markup and output are untouched.
 *
 * const boot = new MusicBoot(stage, {
 *   onStart: () => scene.setMode("hidden"),
 *   onComplete: reason => setMode(reason === "complete" && albums.length ? "detail" : "archive"),
 *   reduced: () => preferences.reduced,
 *   album: () => currentAlbum(),
 * });
 * // Once music metadata, fonts and the GLB are ready:
 * boot.start();
 * // Inside the existing animation frame, with seconds (not milliseconds):
 * const opening = boot.update(time);
 * if (!opening || opening.renderScene) scene.update(time, opening?.cinema);
 * // Existing music transport remains untouched during start, skip and replay.
 */
export class MusicBoot {
  readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly sequence: BootSequence;
  private readonly skipButton: HTMLButtonElement;
  private readonly caption: HTMLElement;
  private readonly status: HTMLElement;
  private readonly access: HTMLElement;
  private startedAt = 0;
  private running = false;
  private disposed = false;
  private siblings: SavedSibling[] = [];
  private opener: HTMLElement | null = null;

  constructor(
    private parent: HTMLElement,
    private options: MusicBootOptions = {},
  ) {
    this.root = document.createElement("section");
    this.root.className = "music-boot-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "音乐库启动动画");
    this.root.style.cssText =
      "position:absolute;inset:0;z-index:900;overflow:hidden;background:#fff;color:#080a08;";
    this.stage = document.createElement("div");
    this.stage.className = "music-boot-stage";
    this.stage.dataset.mode = "boot";
    this.stage.style.cssText =
      "position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center;";
    this.stage.innerHTML = `
      <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg><div class="boot-white"></div></div>
      <header class="brand"><h1>RHINE LAB</h1><div>PRIVATE MUSIC LIBRARY</div><p><span>MUSIC</span><b>OS</b></p></header>
      <section class="boot" style="visibility:visible" aria-label="正在打开音乐库">
        <div class="access-text"></div>
        <div class="boot-logo">${logo}</div>
        <div class="auth-status"><span>▪</span><span id="auth-message"></span><i></i></div>
        <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>MUSIC LIBRARY READY</span></div>
        <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE MUSIC</strong><strong class="welcome-highlight" aria-hidden="true">RHINE MUSIC</strong></div><div class="welcome-database">YOUR MUSIC LIBRARY</div><div class="welcome-logo">${logo}</div></div>
      </section>
      <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
      <div data-music-boot-caption style="position:absolute;bottom:160px;left:0;width:100%;text-align:center;font-size:18px;letter-spacing:1px;z-index:8;pointer-events:none;"></div>
      <button type="button" data-music-boot-skip style="position:absolute;right:60px;top:55px;z-index:10;padding:14px 20px;border:1px solid currentColor;background:rgba(255,255,255,.78);color:#333;font:500 18px MiSans,sans-serif;cursor:pointer;">跳过启动，进入音乐库 <span aria-hidden="true">↗</span></button>`;
    this.root.appendChild(this.stage);
    this.parent.appendChild(this.root);
    this.sequence = new BootSequence(this.stage);
    this.skipButton = this.stage.querySelector("[data-music-boot-skip]")!;
    this.caption = this.stage.querySelector("[data-music-boot-caption]")!;
    this.status = this.stage.querySelector("#auth-message")!;
    this.access = this.stage.querySelector(".access-text")!;
    this.skipButton.addEventListener("click", () => this.skip());
    this.root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        this.skip();
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.skipButton.focus({ preventScroll: true });
      }
    });
    window.addEventListener("resize", this.resize);
    this.resize();
  }

  get active() {
    return this.running;
  }

  start(nowSeconds = performance.now() / 1000, forceMotion = false) {
    if (this.disposed) return;
    if (!Number.isFinite(nowSeconds)) nowSeconds = performance.now() / 1000;
    if (!this.running) {
      this.opener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      this.siblings = [...this.parent.children]
        .filter(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node !== this.root,
        )
        .map((node) => ({
          node,
          inert: node.inert,
          visibility: node.style.getPropertyValue("visibility"),
          priority: node.style.getPropertyPriority("visibility"),
        }));
      for (const { node } of this.siblings) {
        node.inert = true;
        // Keep the real 3D canvas available for the original array/extraction segment.
        if (!node.classList.contains("three-scene"))
          node.style.setProperty("visibility", "hidden");
      }
    }
    this.running = true;
    this.parent.dataset.musicBoot = "running";
    this.startedAt = nowSeconds - START_TIME;
    this.root.hidden = false;
    this.root.style.background = "#fff";
    this.stage.dataset.boot = "access";
    this.sequence.reset();
    this.resize();
    this.options.onStart?.();
    const reduced =
      typeof this.options.reduced === "function"
        ? this.options.reduced()
        : this.options.reduced;
    if (reduced && !forceMotion) {
      this.skip();
      return;
    }
    this.skipButton.focus({ preventScroll: true });
    this.update(nowSeconds);
  }

  /** Explicit replay shows the animation even if automatic startup uses reduced motion. */
  replay(nowSeconds = performance.now() / 1000) {
    this.start(nowSeconds, true);
  }

  skip() {
    if (this.running && !this.disposed) this.finish("skip");
  }

  update(nowSeconds: number): MusicBootFrame | undefined {
    if (!this.running || this.disposed || !Number.isFinite(nowSeconds)) return;
    const appTime = Math.max(START_TIME, nowSeconds - this.startedAt);
    if (appTime >= END_TIME) {
      this.finish("complete");
      return;
    }
    const motion = this.sequence.update(appTime);
    const text = musicBootText(appTime);
    // The synchronous replacements happen before painting; the shared legacy
    // renderer retains its exact transforms, opacity, ring and logo timelines.
    this.access.textContent = text.access;
    this.status.textContent = text.status;
    let phase = motion.step as MusicBootFrame["phase"];
    if (appTime >= 28.3) phase = "inspect";
    else if (appTime >= 25.68) phase = "select";
    else if (appTime >= 22) phase = "array";
    this.stage.dataset.boot = phase;
    this.root.dataset.phase = phase;
    this.root.dataset.appTime = String(appTime);
    this.root.style.background = appTime < 21.92 ? "#fff" : "transparent";
    const album = this.options.album?.();
    this.caption.textContent =
      phase === "inspect"
        ? "展开封面，准备查看曲目与专辑资料"
        : phase === "select"
          ? album?.title
            ? `选择专辑 · ${album.title}`
            : "准备浏览你的专辑"
          : phase === "array"
            ? "打开本地音乐库"
            : phase === "scan"
              ? "音乐库已就绪"
              : phase === "welcome"
                ? "欢迎进入你的音乐收藏"
                : phase === "auth"
                  ? "准备音乐库界面"
                  : "";
    return {
      appTime,
      phase,
      renderScene: appTime >= 21.9,
      cinema: {
        reveal: ease((appTime - 21.9) / 0.13),
        lift: ease((appTime - 26) / 1.8),
        zoom:
          0.55 * ease((appTime - 27.3) / 1.65) +
          0.45 * ease((appTime - 29) / 5),
        time: appTime,
      },
    };
  }

  private resize = () => {
    const bounds = this.parent.getBoundingClientRect();
    const scale = Math.max(
      0.01,
      Math.min(bounds.width / 1920, bounds.height / 1080),
    );
    this.stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  };

  private finish(reason: "complete" | "skip", notify = true) {
    this.running = false;
    this.root.hidden = true;
    this.parent.dataset.musicBoot = "done";
    this.sequence.reset();
    for (const { node, inert, visibility, priority } of this.siblings) {
      node.inert = inert;
      if (visibility)
        node.style.setProperty("visibility", visibility, priority);
      else node.style.removeProperty("visibility");
    }
    this.siblings = [];
    if (notify) this.options.onComplete?.(reason);
    if (this.opener?.isConnected && !this.opener.inert)
      this.opener.focus({ preventScroll: true });
  }

  dispose() {
    if (this.disposed) return;
    if (this.running) this.finish("skip", false);
    this.disposed = true;
    window.removeEventListener("resize", this.resize);
    this.root.remove();
  }
}
