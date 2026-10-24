import { followMusicMotionSpeed } from "./music-motion-ui";

export type MusicDetailView = "info" | "lyrics";

/** Switch geometry only while its reading surface is transparent. */
export class MusicDetailViewTransition {
  private animations: Animation[] = [];
  private revision = 0;
  private pending?: MusicDetailView;
  private inert = new Map<HTMLElement, boolean>();

  constructor(private options: {
    current: () => MusicDetailView;
    targets: () => HTMLElement[];
    commit: (view: MusicDetailView) => void;
    state: (phase: "closing" | "opening" | "idle") => void;
    settled: () => void;
  }) {}

  get target() { return this.pending ?? this.options.current(); }

  change(next: MusicDetailView, reduced: boolean) {
    if (next === this.target) {
      if (reduced && this.pending) this.finish();
      return;
    }
    const revision = ++this.revision;
    const wasRunning = this.animations.length > 0;
    const previous = this.capture();
    this.stopAnimations();
    this.pending = next;
    this.lock();
    if (reduced) { this.finish(); return; }
    if (next === this.options.current()) {
      this.enter(previous, revision, true);
      return;
    }
    this.options.state("closing");
    const distance = Math.max(0, ...previous.map(item => item.opacity));
    const duration = wasRunning ? Math.max(48, 240 * Math.sqrt(distance)) : 240;
    this.animate(previous.map(item => ({ ...item, to: 0 })), duration, "cubic-bezier(.4,0,1,1)", revision, () => {
      this.stopAnimations();
      this.options.commit(next);
      this.lock();
      this.enter(this.capture().map(item => ({ ...item, opacity: 0 })), revision, false);
    });
  }

  /** Immediate updates and reduced motion settle the requested view. */
  finish() {
    const next = this.pending;
    if (next === undefined) { this.cancel(); return; }
    this.revision++;
    this.stopAnimations();
    if (next !== undefined && next !== this.options.current()) this.options.commit(next);
    this.pending = undefined;
    this.unlock();
    this.options.state("idle");
    this.options.settled();
  }

  cancel() {
    this.revision++;
    this.stopAnimations();
    this.pending = undefined;
    this.unlock();
    this.options.state("idle");
  }

  private capture() {
    return this.options.targets().filter(element => element.isConnected && element.getClientRects().length > 0)
      .map(element => ({ element, opacity: Number(getComputedStyle(element).opacity) || 0 }));
  }

  private enter(from: Array<{ element: HTMLElement; opacity: number }>, revision: number, interrupted: boolean) {
    this.options.state("opening");
    const entries = from.map(item => ({ ...item, to: Number(getComputedStyle(item.element).opacity) || 0 }));
    const distance = Math.max(0, ...entries.map(item => Math.abs(item.to - item.opacity)));
    const duration = interrupted ? Math.max(48, 360 * Math.sqrt(distance)) : 360;
    this.animate(entries, duration, "cubic-bezier(.22,1,.36,1)", revision, () => {
      this.stopAnimations();
      this.pending = undefined;
      this.unlock();
      this.options.state("idle");
      this.options.settled();
    });
  }

  private animate(entries: Array<{ element: HTMLElement; opacity: number; to: number }>, duration: number, easing: string, revision: number, complete: () => void) {
    this.animations = entries.map(({ element, opacity, to }) => followMusicMotionSpeed(element.animate(
      [{ opacity }, { opacity: to }], { duration, easing, fill: "both" },
    )));
    void Promise.all(this.animations.map(animation => animation.finished)).then(() => {
      if (revision === this.revision) complete();
    }).catch(() => {});
  }

  private stopAnimations() {
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
  }

  private lock() {
    for (const element of this.options.targets()) {
      if (!this.inert.has(element)) this.inert.set(element, element.inert);
      element.inert = true;
    }
  }

  private unlock() {
    for (const [element, wasInert] of this.inert) element.inert = wasInert;
    this.inert.clear();
  }
}
