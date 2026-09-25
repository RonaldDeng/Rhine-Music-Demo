import { createRollingText } from "@kitlangton/rolling-number";

/** Keep one interruptible archive-style reel while the outer playback slot grows. */
export function setupTransportTitle(slot: HTMLElement, label: HTMLElement) {
  const measure = document.createElement("span");
  measure.className = "transport-title-measure";
  const reel = document.createElement("span");
  reel.className = "transport-title-reel";
  reel.setAttribute("aria-hidden", "true");
  label.replaceChildren(measure, reel);
  const controller = createRollingText(reel, {
    text: "",
    duration: 460,
    motionBlur: true,
    transition: "direct",
    stagger: "none",
    direction: "up",
    animated: false,
  });
  const canvas = document.createElement("canvas").getContext("2d")!;
  let title = "", displayed = "", font = "";
  let visible = false, reduced = false, disposed = false, scheduled = 0;

  const reconcile = (animate = false) => {
    if (disposed) return;
    const naturalWidth = measure.getBoundingClientRect().width;
    slot.style.setProperty("--song-width", `${Math.ceil(naturalWidth) + 14}px`);
    const style = getComputedStyle(label);
    const nextFont = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    canvas.font = nextFont;
    const spacing = Number.parseFloat(style.letterSpacing) || 0;
    const available = label.getBoundingClientRect().width;
    let fitted = title;
    if (naturalWidth > available + 0.5) {
      const glyphs = [...title];
      const width = (text: string) =>
        canvas.measureText(text).width + spacing * [...text].length;
      let low = 0, high = glyphs.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (width(`${glyphs.slice(0, middle).join("")}…`) <= available) low = middle;
        else high = middle - 1;
      }
      fitted = width("…") <= available ? `${glyphs.slice(0, low).join("")}…` : "";
    }
    // ResizeObserver also fires after a title change; don't restart that roll.
    if (fitted === displayed && nextFont === font) return;
    const fontChanged = font !== nextFont;
    displayed = fitted;
    font = nextFont;
    controller.update({ animated: animate && visible && !reduced });
    controller.update({ text: fitted });
    if (fontChanged) controller.refresh();
    controller.update({ animated: visible && !reduced });
  };
  const schedule = () => {
    if (!scheduled && !disposed) scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      reconcile();
    });
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(label);
  void document.fonts.ready.then(schedule);

  return {
    setReduced(next: boolean) {
      reduced = next;
      controller.update({ animated: visible && !reduced });
      if (reduced) controller.finish();
    },
    update(next: string, shown: boolean) {
      const wasVisible = visible;
      const changed = shown && next !== title;
      visible = shown;
      slot.classList.toggle("visible", shown);
      slot.setAttribute("aria-hidden", String(!shown));
      if (changed) {
        title = next;
        // Native text measures the full name and supplies the accessible label.
        measure.textContent = title;
        slot.title = title;
        reconcile(wasVisible);
      }
      if (shown !== wasVisible) controller.update({ animated: shown && !reduced });
    },
    destroy() {
      disposed = true;
      resize.disconnect();
      cancelAnimationFrame(scheduled);
      controller.destroy();
      label.textContent = title;
    },
  };
}
