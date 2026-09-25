import {
  createRollingNumber,
  createRollingText,
} from "@kitlangton/rolling-number";
import type { ArchiveNavigation } from "./archive-loop";

type SelectionText = {
  number: number;
  total: number;
  code: number;
  genreIndex: number;
  genresTotal: number;
  genre: string;
  genreName: string;
  format: string;
  artist: string;
  meta: string;
};

/** Keep the original archive's per-glyph reels alive across selection changes. */
export function setupMusicTextMotion(root: HTMLElement) {
  const host = (id: string, kind: "text" | "number") => {
    const element = root.querySelector<HTMLElement>(`#${id}`)!;
    element.classList.add(`music-rolling-${kind}`);
    return element;
  };
  const motion = { duration: 460, motionBlur: false, animated: false };
  const number = (id: string, digits = 2) =>
    createRollingNumber(host(id, "number"), {
      ...motion,
      value: 1,
      locales: "en-US",
      format: { minimumIntegerDigits: digits, useGrouping: false },
    });
  const text = (id: string) =>
    createRollingText(host(id, "text"), {
      ...motion,
      text: "",
      transition: "direct",
      stagger: "none",
      direction: "up",
    });
  const wrappingText = (id: string) => {
    // Auxiliary metadata keeps its native block width. Reels only own the
    // inner single-line span; longer artist lists retain ordinary line wraps.
    const element = root.querySelector<HTMLElement>(`#${id}`)!;
    const reel = document.createElement("span");
    const plain = document.createElement("span");
    const measure = document.createElement("span");
    reel.className = "music-rolling-text music-inline-reel";
    plain.className = "music-inline-plain";
    plain.style.whiteSpace = "normal";
    plain.style.overflowWrap = "anywhere";
    measure.setAttribute("aria-hidden", "true");
    measure.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;white-space:pre;width:max-content;max-width:none;";
    element.replaceChildren(reel, plain, measure);
    const controller = createRollingText(reel, {
      ...motion,
      text: "",
      transition: "direct",
      stagger: "none",
      direction: "up",
    });
    let value = "",
      animated = false,
      usingReel = true,
      scheduled = 0,
      disposed = false;
    const reconcile = () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      scheduled = 0;
      if (disposed) return;
      const style = getComputedStyle(element);
      const available =
        element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const fits = available > 0 && measure.scrollWidth <= available;
      const previouslyUsingReel = usingReel;
      usingReel = fits;
      // Inline display overrides the library's .rn-root rule while hidden.
      reel.style.display = fits ? "inline-block" : "none";
      plain.style.display = fits ? "none" : "inline";
      controller.update({
        text: value,
        animated: animated && fits && previouslyUsingReel,
      });
      if (fits && !previouslyUsingReel) controller.update({ animated });
    };
    const schedule = () => {
      if (!disposed && !scheduled) scheduled = requestAnimationFrame(reconcile);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    void document.fonts.ready.then(schedule);
    return {
      update(options: { text?: string; animated?: boolean }) {
        if (options.text !== undefined && options.text !== value) {
          value = options.text;
          element.title = value;
          plain.textContent = value;
          measure.textContent = value;
        }
        if (options.animated !== undefined) animated = options.animated;
        reconcile();
      },
      finish() {
        animated = false;
        controller.update({ animated: false });
        controller.finish();
      },
      destroy() {
        disposed = true;
        resize.disconnect();
        cancelAnimationFrame(scheduled);
        controller.destroy();
        element.textContent = value;
      },
    };
  };
  const numbers = {
    number: number("selection-number"),
    total: number("selection-total"),
    code: number("selection-code-number", 3),
    genreIndex: number("genre-index"),
    genresTotal: number("genre-total"),
  };
  const texts = {
    genre: text("selection-genre"),
    genreName: text("genre-name"),
    format: text("selection-format"),
    artist: wrappingText("selection-artist"),
    meta: wrappingText("selection-meta"),
  };
  const controllers = [...Object.values(numbers), ...Object.values(texts)];
  let enabled = false;
  const setEnabled = (next: boolean) => {
    if (enabled === next) return;
    enabled = next;
    // Prepare the current glyphs before the next input, so the first selection
    // after entering the archive animates just like subsequent selections.
    controllers.forEach((controller) => controller.update({ animated: next }));
    if (!next) controllers.forEach((controller) => controller.finish());
  };
  return {
    setEnabled,
    update(
      value: SelectionText,
      animated: boolean,
      navigation?: ArchiveNavigation,
    ) {
      setEnabled(animated);
      const axis =
        navigation && "axis" in navigation ? navigation.axis : undefined;
      const direction =
        navigation && "axis" in navigation
          ? navigation.direction > 0
            ? "up"
            : "down"
          : "auto";
      numbers.number.update({
        value: value.number,
        direction: axis === "row" ? direction : "auto",
      });
      numbers.total.update({
        value: value.total,
        direction: axis === "lane" ? direction : "auto",
      });
      numbers.code.update({ value: value.code, direction });
      numbers.genreIndex.update({
        value: value.genreIndex,
        direction: axis === "lane" ? direction : "auto",
      });
      numbers.genresTotal.update({ value: value.genresTotal, direction: "auto" });
      for (const key of Object.keys(texts) as (keyof typeof texts)[])
        texts[key].update({ text: value[key] });
    },
    finish() {
      setEnabled(false);
      controllers.forEach((controller) => controller.finish());
    },
    destroy() {
      controllers.forEach((controller) => controller.destroy());
    },
  };
}
