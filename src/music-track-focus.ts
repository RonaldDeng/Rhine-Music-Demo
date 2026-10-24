import { getMusicMotionSpeed, onMusicMotionSpeedChange } from "./music-motion-settings";
import { followMusicMotionSpeed } from "./music-motion-ui";

/** One cancellable track reveal, scoped to the detail pane rather than the page. */
export class MusicTrackFocus {
  private cleanup?: () => void;

  cancel() {
    this.cleanup?.();
  }

  reveal(container: HTMLElement, row: HTMLButtonElement, reduced: boolean) {
    this.cancel();
    let frame = 0;
    let pulse: Animation | undefined;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let elapsed = 0;
    let lastTime = performance.now();
    let speed = getMusicMotionSpeed();
    const advance = (now: number) => {
      elapsed += Math.max(0, now - lastTime) * speed;
      lastTime = Math.max(lastTime, now);
      return elapsed;
    };
    const unsubscribeSpeed = onMusicMotionSpeedChange((next) => {
      // Integrate at the old speed up to the change, retaining current progress.
      advance(performance.now());
      speed = next;
    });
    const cancel = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      pulse?.cancel();
      clearTimeout(hold);
      unsubscribeSpeed();
      row.classList.remove("search-track-highlight");
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("pointerdown", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("keydown", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("resize", cancel);
      this.cleanup = undefined;
    };
    const onVisibility = () => { if (document.hidden) cancel(); };
    this.cleanup = cancel;
    // A user's own scroll or click always takes precedence over reveal motion.
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("keydown", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", cancel);

    const tabsHeight = container.querySelector<HTMLElement>(".music-tabs")?.offsetHeight ?? 0;
    const start = container.scrollTop;
    const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + start;
    const centerOffset = tabsHeight + Math.max(0, (container.clientHeight - tabsHeight - row.offsetHeight) / 2);
    const target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, rowTop - centerOffset));
    const highlight = () => {
      if (!active || !row.isConnected) { cancel(); return; }
      row.focus({ preventScroll: true });
      if (reduced) {
        row.classList.add("search-track-highlight");
        hold = setTimeout(cancel, 1100);
      } else {
        pulse = followMusicMotionSpeed(row.animate([
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { backgroundColor: "var(--search-track-tint)", boxShadow: "inset 3px 0 var(--accent)", offset: 0.32 },
          { backgroundColor: "var(--search-track-tint)", boxShadow: "inset 3px 0 var(--accent)", offset: 0.48, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 0.88 },
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 1 },
        ], { duration: 1000, iterations: 2 }));
        pulse.onfinish = cancel;
      }
    };
    if (reduced || Math.abs(target - start) < 1) {
      container.scrollTop = target;
      highlight();
      return;
    }
    // Small moves share the 460 ms text rhythm; long reveals breathe up to the
    // 720 ms browse entrance. The archive's quintic starts and ends at rest,
    // with zero acceleration at both endpoints and no snap in either direction.
    const duration = Math.min(720, 460 + Math.abs(target - start) * 0.12);
    const scroll = (now: number) => {
      if (!active || !row.isConnected) { cancel(); return; }
      const progress = Math.min(1, advance(now) / duration);
      const eased = progress ** 3 * (10 - 15 * progress + 6 * progress ** 2);
      container.scrollTop = start + (target - start) * eased;
      if (progress < 1) frame = requestAnimationFrame(scroll);
      else highlight();
    };
    frame = requestAnimationFrame(scroll);
  }
}
