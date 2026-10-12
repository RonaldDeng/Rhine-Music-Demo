import { getMusicMotionSpeed } from "./music-motion-settings";
import { followMusicMotionSpeed } from "./music-motion-ui";

const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const exitEase = "cubic-bezier(0.4, 0, 1, 1)";

/** Owns the visible lifetime, including a close that interrupts an opening. */
export class SurfaceTransition {
  private animations: Animation[] = [];
  private revision = 0;
  private duration = 0;
  private exitRate = 1;
  private enterLead?: { animation: Animation; start: (reduced: boolean) => void };

  constructor(
    private root: HTMLElement,
    private panel?: HTMLElement,
    private enterDuration = 300,
    private exitDuration = 200,
    private direction: "up" | "right" = "up",
    private enterEasing = enterEase,
    // Separate overlays can fade together without changing their common
    // ancestor's stacking context or flattening them into a full-screen layer.
    private fadeTargets: readonly HTMLElement[] = [root],
  ) {}

  show(reduced: boolean, enterDelay = 0, onShow?: () => void) {
    this.cancelEnterLead();
    // A hidden surface can wait for its reading field without exposing text
    // or shortening the existing entrance. Visible reversals resume in place.
    if (!reduced && this.root.hidden && Number.isFinite(enterDelay) && enterDelay > 0) {
      const revision = ++this.revision;
      const animation = followMusicMotionSpeed(this.root.animate([], { duration: enterDelay }));
      const start = (finishImmediately: boolean) => {
        if (revision !== this.revision || this.enterLead?.animation !== animation) return;
        this.enterLead = undefined;
        animation.cancel();
        this.run(true, finishImmediately);
        onShow?.();
      };
      this.enterLead = { animation, start };
      void animation.finished.then(() => start(false)).catch(() => {});
      return;
    }
    this.run(true, reduced);
    onShow?.();
  }

  hide(reduced: boolean, finished: () => void = () => {}) {
    this.cancelEnterLead();
    this.run(false, reduced, finished);
  }

  /** Complete an already running exit before a moving obstacle arrives.
   * Preserve currentTime and opacity: only its remaining playback rate changes.
   * milliseconds uses the same unscaled clock as the configured duration. */
  finishWithin(milliseconds: number) {
    if (this.root.dataset.transition !== "closing" || !(milliseconds > 0)) return;
    const remaining = Math.max(0, ...this.animations.map(animation =>
      this.duration - Number(animation.currentTime ?? 0)));
    this.exitRate = Math.max(this.exitRate, remaining / milliseconds);
    this.animations.forEach(animation => animation.updatePlaybackRate(getMusicMotionSpeed() * this.exitRate));
  }

  finish() {
    if (this.enterLead) {
      this.enterLead.start(true);
      return;
    }
    this.animations.forEach((animation) => animation.finish());
  }

  dispose() {
    this.revision++;
    this.cancelEnterLead();
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
  }

  private cancelEnterLead() {
    this.enterLead?.animation.cancel();
    this.enterLead = undefined;
  }

  private run(show: boolean, reduced: boolean, finished?: () => void) {
    const revision = ++this.revision;
    this.exitRate = 1;
    const hidden = this.root.hidden;
    const interrupted = this.animations.length > 0;
    const opacities = this.fadeTargets.map((target) =>
      hidden ? "0" : getComputedStyle(target).opacity,
    );
    const transform = this.panel
      ? hidden
        ? this.direction === "right" ? "translateX(24px)" : "translateY(10px)"
        : getComputedStyle(this.panel).transform
      : undefined;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    this.root.hidden = false;
    this.root.dataset.transition = show ? "opening" : "closing";
    const complete = () => {
      if (revision !== this.revision) return;
      this.root.hidden = !show;
      this.root.dataset.transition = show ? "open" : "closed";
      this.animations.forEach((animation) => animation.cancel());
      this.animations = [];
      finished?.();
    };
    if (reduced || (!show && hidden)) {
      complete();
      return;
    }
    // A late reversal travels a short distance. Replaying a full entrance here
    // makes rapid open/back input feel sticky even when its first pixel matches.
    const distance = Math.max(...opacities.map((opacity) =>
      Math.abs((show ? 1 : 0) - Number(opacity))), 0);
    const baseDuration = show ? this.enterDuration : this.exitDuration;
    this.duration = interrupted ? Math.max(72, baseDuration * Math.sqrt(distance)) : baseDuration;
    const options: KeyframeAnimationOptions = {
      duration: this.duration,
      easing: show ? this.enterEasing : exitEase,
      fill: "both",
    };
    const fades = this.fadeTargets.map((target, index) => followMusicMotionSpeed(target.animate(
      [{ opacity: opacities[index] }, { opacity: show ? 1 : 0 }],
      options,
    ), () => this.exitRate));
    this.animations.push(...fades);
    if (this.panel) {
      this.animations.push(
        followMusicMotionSpeed(this.panel.animate(
          [
            { transform },
            { transform: this.direction === "right"
              ? show ? "translateX(0)" : "translateX(32px)"
              : show ? "translateY(0)" : "translateY(6px)" },
          ],
          options,
        ), () => this.exitRate),
      );
    }
    void Promise.all(fades.map((fade) => fade.finished)).then(complete).catch(() => {});
  }
}

export class ContentTransition {
  private animation?: Animation;

  constructor(private duration = 150, private easing = enterEase) {}

  reveal(element: HTMLElement, reduced: boolean) {
    const opacity =
      this.animation?.playState === "running"
        ? getComputedStyle(element).opacity
        : "0.35";
    this.cancel();
    if (!reduced)
      this.animation = followMusicMotionSpeed(element.animate([{ opacity }, { opacity: 1 }], {
        duration: this.duration,
        easing: this.easing,
      }));
  }

  cancel() {
    this.animation?.cancel();
    this.animation = undefined;
  }
}
