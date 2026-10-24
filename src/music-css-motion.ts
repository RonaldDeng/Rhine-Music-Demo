import { getMusicMotionSpeed, onMusicMotionSpeedChange } from "./music-motion-settings";

/** Future CSS effects use scaled durations. Running transitions retain their
 * original duration, so retime them explicitly; CSS keyframes instead need
 * their local time remapped when CSS changes the iteration duration. */
export function setupMusicCssMotion(root: HTMLElement) {
  let previousSpeed = getMusicMotionSpeed();
  const requestedRates = new WeakMap<Animation, number>();
  const writeScale = () => root.style.setProperty("--music-motion-scale", String(1 / getMusicMotionSpeed()));
  writeScale();
  return onMusicMotionSpeedChange((speed) => {
    const running = root.getAnimations({ subtree: true }).filter((animation) =>
      animation.playState === "running" || animation.pending,
    );
    const keyframes = running.filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
      .filter((animation) => animation.currentTime !== null)
      .map((animation) => ({ animation, time: Number(animation.currentTime), timing: animation.effect?.getTiming() }));
    for (const animation of running) {
      if (!(animation instanceof CSSTransition)) continue;
      const rate = (requestedRates.get(animation) ?? animation.playbackRate) * speed / previousSpeed;
      requestedRates.set(animation, rate);
      animation.updatePlaybackRate(rate);
    }
    writeScale();
    // getAnimations flushes the new custom property and its dependent timings.
    root.getAnimations({ subtree: true });
    for (const { animation, time, timing } of keyframes) {
      const next = animation.effect?.getTiming();
      if (typeof timing?.duration !== "number" || !(timing.duration > 0) ||
        typeof next?.duration !== "number" || !Number.isFinite(time)) continue;
      const iterations = (time - (timing.delay ?? 0)) / timing.duration;
      animation.currentTime = (next.delay ?? 0) + iterations * next.duration;
    }
    previousSpeed = speed;
  });
}
