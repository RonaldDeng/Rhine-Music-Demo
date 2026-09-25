import "./music-boot.css";

// Begin at the first live 3D frame; keep the authored camera/wave timebase.
const START_TIME = 21.92;
// End in the preview hold, before the reference begins its second extraction.
const END_TIME = 27.12;
const REVEAL_DURATION = 720;
const REVEAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export interface MusicBootFrame {
  cinema: { reveal: number; lift: number; zoom: number; time: number; musicIntro: true };
  renderScene: boolean;
  phase: "array" | "select";
  appTime: number;
}
export interface MusicBootOptions {
  onStart?: () => void;
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

/** The opening is the live scene; this transparent layer only owns skip/focus. */
export class MusicBoot {
  readonly root: HTMLElement;
  private readonly skipButton: HTMLButtonElement;
  private startedAt = 0;
  private running = false;
  private revealing = false;
  private revealRevision = 0;
  private revealAnimations: Animation[] = [];
  private revealFocus: HTMLElement | null = null;
  private endpointRendered = false;
  private disposed = false;
  private siblings: SavedSibling[] = [];
  private opener: HTMLElement | null = null;

  constructor(private parent: HTMLElement, private options: MusicBootOptions = {}) {
    this.root = document.createElement("section");
    this.root.className = "music-boot-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "专辑阵列进场");
    this.root.tabIndex = -1;
    this.skipButton = document.createElement("button");
    this.skipButton.type = "button";
    this.skipButton.className = "music-boot-skip";
    this.skipButton.textContent = "跳过进场 ↗";
    this.root.appendChild(this.skipButton);
    this.parent.appendChild(this.root);
    this.skipButton.addEventListener("click", () => this.skip());
    this.root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (this.revealing) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        this.skip();
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.skipButton.focus({ preventScroll: true });
      }
    });
  }
  get active() { return this.running || this.revealing; }

  start(nowSeconds = performance.now() / 1000, forceMotion = false) {
    if (this.disposed) return;
    if (!Number.isFinite(nowSeconds)) nowSeconds = performance.now() / 1000;
    if (this.revealing) this.completeReveal(false);
    if (!this.running) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.siblings = [...this.parent.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.root)
        .map((node) => ({ node, inert: node.inert,
          visibility: node.style.getPropertyValue("visibility"),
          priority: node.style.getPropertyPriority("visibility") }));
      for (const { node } of this.siblings) {
        node.inert = true;
        if (!node.classList.contains("three-scene")) node.style.setProperty("visibility", "hidden");
      }
    }
    this.running = true;
    this.endpointRendered = false;
    this.parent.dataset.musicBoot = "running";
    this.startedAt = nowSeconds - START_TIME;
    this.root.hidden = false;
    this.root.setAttribute("aria-label", "专辑阵列进场");
    this.skipButton.hidden = false;
    this.options.onStart?.();
    const reduced = typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
    if (reduced && !forceMotion) { this.skip(); return; }
    this.skipButton.focus({ preventScroll: true });
  }
  replay(nowSeconds = performance.now() / 1000) { this.start(nowSeconds, true); }
  skip() { if (this.running && !this.disposed) this.finish("skip"); }

  update(nowSeconds: number): MusicBootFrame | undefined {
    if (this.revealing && this.isReduced()) this.completeReveal();
    if (!this.running || this.disposed || !Number.isFinite(nowSeconds)) return;
    if (this.endpointRendered) { this.finish("complete"); return; }
    const appTime = Math.min(END_TIME, Math.max(START_TIME, nowSeconds - this.startedAt));
    this.endpointRendered = appTime === END_TIME;
    const phase = appTime >= 25.68 ? "select" : "array";
    this.root.dataset.phase = phase;
    this.root.dataset.appTime = String(appTime);
    return {
      appTime, phase, renderScene: true,
      cinema: {
        reveal: ease((appTime - 21.9) / 0.13),
        lift: 0,
        zoom: 0,
        time: appTime,
        musicIntro: true,
      },
    };
  }
  private finish(reason: "complete" | "skip", notify = true) {
    this.running = false;
    this.root.hidden = true;
    for (const { node, inert, visibility, priority } of this.siblings) {
      node.inert = inert;
      if (visibility) node.style.setProperty("visibility", visibility, priority);
      else node.style.removeProperty("visibility");
    }
    // The completion hook owns the camera endpoint and browse surface fade. It
    // must run while active is false so showBrowseSurface can start normally.
    if (notify) this.options.onComplete?.(reason);
    this.revealFocus = document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body && !this.root.contains(document.activeElement)
      ? document.activeElement : this.opener;
    if (!notify || this.isReduced()) {
      this.siblings = [];
      this.parent.dataset.musicBoot = "done";
      if (notify) this.restoreFocus();
      return;
    }

    // Snapshot the hook's final interaction state, then keep the whole stage
    // locked until the controls are visible. All of this happens before paint.
    for (const sibling of this.siblings) {
      sibling.inert = sibling.node.inert;
      sibling.node.inert = true;
    }
    this.revealing = true;
    this.parent.dataset.musicBoot = "revealing";
    this.root.hidden = false;
    this.skipButton.hidden = true;
    this.root.setAttribute("aria-label", "正在显示音乐库");
    this.root.focus({ preventScroll: true });
    const revision = ++this.revealRevision;
    const fade = (selector: string, delay = 0) => {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node || node.hidden) return;
      this.revealAnimations.push(node.animate(
        [{ opacity: 0 }, { opacity: getComputedStyle(node).opacity }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    };
    fade(".music-vignette");
    fade(".music-header");
    fade(".library-status", 45);
    fade(".music-bottomline", 90);
    fade(".music-empty", 60);
    // Keep navigation geometry stable for the title layout's bottom clearance.
    fade(".music-navigation", 110);
    // Browse opacity belongs exclusively to SurfaceTransition. Move only its
    // children, using the independent translate property to preserve transforms.
    for (const [selector, delay] of [
      [".album-callout", 60], [".music-keyhint", 140],
    ] as const) {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node) continue;
      this.revealAnimations.push(node.animate(
        [{ translate: "0 8px" }, { translate: getComputedStyle(node).translate }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    }
    void Promise.all(this.revealAnimations.map((animation) => animation.finished))
      .then(() => {
        if (revision === this.revealRevision && !this.disposed) this.completeReveal();
      }).catch(() => {});
  }
  private isReduced() {
    return typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
  }
  private restoreFocus() {
    if (this.revealFocus?.isConnected && !this.revealFocus.closest("[inert], [hidden]"))
      this.revealFocus.focus({ preventScroll: true });
    this.revealFocus = null;
  }
  private completeReveal(restoreFocus = true) {
    this.revealRevision++;
    this.revealAnimations.forEach((animation) => animation.cancel());
    this.revealAnimations = [];
    this.revealing = false;
    this.root.hidden = true;
    this.parent.dataset.musicBoot = "done";
    for (const { node, inert } of this.siblings) node.inert = inert;
    this.siblings = [];
    if (restoreFocus) this.restoreFocus();
    else this.revealFocus = null;
  }
  dispose() {
    if (this.disposed) return;
    if (this.running) this.finish("skip", false);
    if (this.revealing) this.completeReveal(false);
    this.disposed = true;
    this.root.remove();
  }
}
