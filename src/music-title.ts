import { escapeHtml } from "./html";
import {
  createRollingText,
  type RollingTextController,
} from "@kitlangton/rolling-number";

/** Treat a trailing English translation as a subtitle, preserving the tagged title. */
export function albumTitleParts(title: string) {
  const match = title.trim().match(/^(.+?)[（(]([^（）()]+)[）)]\s*$/u);
  if (
    match &&
    /\p{Script=Han}/u.test(match[1]) &&
    /[a-z]/i.test(match[2]) &&
    !/\p{Script=Han}/u.test(match[2])
  ) {
    return { main: match[1].trim(), translation: match[2].trim() };
  }
  return { main: title, translation: "" };
}

export function albumTitleMarkup(title: string) {
  const { main, translation } = albumTitleParts(title);
  return `<span class="music-title-main">${escapeHtml(main)}</span>${translation ? `<span class="music-title-translation">${escapeHtml(translation)}</span>` : ""}`;
}

/** Read the browser's actual wrapping, including CJK and mixed-language tags. */
function measuredLines(element: HTMLElement) {
  const node = element.firstChild;
  if (!node?.textContent) return [];
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const range = document.createRange();
  const lines: string[] = [];
  let offset = 0;
  let firstTop: number | undefined;
  for (const character of node.textContent) {
    range.setStart(node, offset);
    offset += character.length;
    range.setEnd(node, offset);
    const rect = range.getBoundingClientRect();
    firstTop ??= rect.top;
    const index = Math.max(0, Math.round((rect.top - firstTop) / lineHeight));
    lines[index] = (lines[index] || "") + character;
  }
  return lines.map((line) => line.trim());
}

/** Keep native wrapping for measurement and a persistent rolling reel per line. */
export function setupMusicTitleLayout(root: HTMLElement) {
  const title = root.querySelector<HTMLElement>("#selection-title")!;
  const callout = root.querySelector<HTMLElement>(".album-callout")!;
  const navigation = root.querySelector<HTMLElement>(".music-navigation")!;
  const measurement = document.createElement("span");
  measurement.className = "music-title-layout";
  measurement.setAttribute("aria-hidden", "true");
  measurement.innerHTML =
    '<span class="music-title-main"></span><span class="music-title-translation" hidden></span>';
  const visual = document.createElement("span");
  visual.className = "music-title-rolling";
  visual.setAttribute("aria-hidden", "true");
  title.replaceChildren(measurement, visual);
  const main = measurement.querySelector<HTMLElement>(".music-title-main")!;
  const translation = measurement.querySelector<HTMLElement>(
    ".music-title-translation",
  )!;
  const reels = new Map<
    string,
    { host: HTMLElement; controller: RollingTextController; signature: string }
  >();
  let text = "";
  let animateNext = false;
  let enabled = false;
  let destroyed = false;
  let scheduled = 0;
  const measure = document.createElement("canvas").getContext("2d")!;

  const renderLines = () => {
    const titleRect = title.getBoundingClientRect();
    const active = new Set<string>();
    for (const [kind, element] of [
      ["main", main],
      ["translation", translation],
    ] as const) {
      if (element.hidden) continue;
      const lines = measuredLines(element);
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const top = element.getBoundingClientRect().top - titleRect.top;
      // The native layout already shrinks long names, then clamps extreme tags.
      const visible = title.hasAttribute("data-title-overflow")
        ? lines.slice(0, 2)
        : lines;
      visible.forEach((line, index) => {
        if (lines.length > visible.length && index === visible.length - 1) {
          measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const spacing = Number.parseFloat(style.letterSpacing) || 0;
          const glyphs = [...line];
          while (
            glyphs.length &&
            measure.measureText(`${glyphs.join("")}…`).width +
              spacing * glyphs.length >
              element.clientWidth
          )
            glyphs.pop();
          line = `${glyphs.join("").trimEnd()}…`;
        }
        const key = `${kind}-${index}`;
        active.add(key);
        let reel = reels.get(key);
        if (!reel) {
          const host = document.createElement("span");
          host.className = `music-title-reel music-rolling-text music-title-reel-${kind}`;
          visual.append(host);
          reel = {
            host,
            signature: "",
            controller: createRollingText(host, {
              text: "",
              duration: 460,
              motionBlur: false,
              animated: false,
              direction: "up",
              transition: "direct",
              stagger: "none",
            }),
          };
          reels.set(key, reel);
        }
        const signature = [
          line,
          style.fontSize,
          style.lineHeight,
          style.fontWeight,
          style.letterSpacing,
        ].join("\u0000");
        reel.host.style.top = `${top + index * lineHeight}px`;
        reel.host.style.fontSize = style.fontSize;
        reel.host.style.lineHeight = style.lineHeight;
        reel.host.style.fontWeight = style.fontWeight;
        reel.host.style.letterSpacing = style.letterSpacing;
        // An unrelated metadata resize must not interrupt an active title reel.
        if (reel.signature === signature) return;
        reel.signature = signature;
        // Enabling before supplying new text also restores the first switch
        // after a static library refresh, startup, or return from detail.
        reel.controller.update({ animated: animateNext });
        reel.controller.update({ text: line });
        if (enabled && !animateNext) reel.controller.update({ animated: true });
      });
    }
    for (const [key, reel] of reels) {
      if (active.has(key)) continue;
      if (!reel.signature) continue;
      reel.signature = "";
      reel.controller.update({ animated: animateNext });
      reel.controller.update({ text: "" });
      if (enabled && !animateNext) reel.controller.update({ animated: true });
    }
    animateNext = false;
  };

  const layout = () => {
    scheduled = 0;
    if (destroyed) return;
    if (!title.getBoundingClientRect().width) return;
    title.style.removeProperty("--album-title-size");
    title.style.removeProperty("max-height");
    title.removeAttribute("data-title-overflow");
    const rootRect = root.getBoundingClientRect();
    const navRect = navigation.getBoundingClientRect();
    const bottomGap = rootRect.bottom - navRect.top + 28;
    root.style.setProperty("--callout-bottom", `${bottomGap}px`);
    const available = callout.clientHeight;
    const base = Number.parseFloat(getComputedStyle(title).fontSize);
    const min = Math.min(base, innerWidth <= 700 ? 18 : 20);
    if (!text) return;
    const outside = () =>
      [...callout.children]
        .filter((node) => node !== title)
        .reduce((sum, node) => {
          const element = node as HTMLElement;
          const style = getComputedStyle(element);
          if (style.display === "none") return sum;
          return (
            sum +
            element.getBoundingClientRect().height +
            Number.parseFloat(style.marginTop) +
            Number.parseFloat(style.marginBottom)
          );
        }, 0);
    const titleMargins =
      Number.parseFloat(getComputedStyle(title).marginTop) +
      Number.parseFloat(getComputedStyle(title).marginBottom);
    const budget = Math.max(28, available - outside() - titleMargins);
    const fits = () =>
      measurement.getBoundingClientRect().height <= budget + 1 &&
      main.scrollHeight <=
        Number.parseFloat(getComputedStyle(main).lineHeight) * 2 + 1;
    if (!fits()) {
      let low = min,
        high = base;
      for (let i = 0; i < 7; i++) {
        const mid = (low + high) / 2;
        title.style.setProperty("--album-title-size", `${mid}px`);
        if (fits()) low = mid;
        else high = mid;
      }
      title.style.setProperty(
        "--album-title-size",
        `${Math.floor(low * 10) / 10}px`,
      );
      if (!fits()) {
        // Extremely long tags keep their full accessible name and detail title.
        title.dataset.titleOverflow = "true";
        title.style.maxHeight = `${budget}px`;
      }
    }
    renderLines();
  };
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(layout);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(navigation);
  for (const id of ["selection-artist", "selection-meta"]) {
    const element = root.querySelector<HTMLElement>(`#${id}`);
    if (element) resize.observe(element);
  }
  const changes = new MutationObserver(schedule);
  // Never observe the rolling engine's glyph subtree: it changes every frame.
  changes.observe(root, {
    attributes: true,
    attributeFilter: ["data-mode", "data-layout"],
  });
  void document.fonts.ready.then(schedule);
  schedule();
  return {
    update(next: string, animated: boolean) {
      enabled = animated;
      if (next === text) {
        if (enabled)
          reels.forEach(({ controller }) =>
            controller.update({ animated: true }),
          );
        return;
      }
      const parts = albumTitleParts(next);
      animateNext = animated && !!text;
      text = next;
      title.title = next;
      title.setAttribute("aria-label", next);
      main.textContent = parts.main;
      translation.textContent = parts.translation;
      translation.hidden = !parts.translation;
      schedule();
    },
    finish() {
      enabled = false;
      animateNext = false;
      if (scheduled) {
        cancelAnimationFrame(scheduled);
        layout();
      }
      reels.forEach(({ controller }) => controller.finish());
    },
    destroy() {
      destroyed = true;
      resize.disconnect();
      changes.disconnect();
      cancelAnimationFrame(scheduled);
      reels.forEach(({ controller }) => controller.destroy());
      title.innerHTML = albumTitleMarkup(text);
    },
  };
}
