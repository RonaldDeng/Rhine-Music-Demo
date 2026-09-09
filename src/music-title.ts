import { escapeHtml } from "./html";

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

/** Measure the real navigation boundary rather than guessing from title length. */
export function setupMusicTitleLayout(root: HTMLElement) {
  const title = root.querySelector<HTMLElement>("#selection-title")!;
  const callout = root.querySelector<HTMLElement>(".album-callout")!;
  const navigation = root.querySelector<HTMLElement>(".music-navigation")!;
  let scheduled = 0;
  const layout = () => {
    scheduled = 0;
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
    const main = title.querySelector<HTMLElement>(".music-title-main")!;
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
      title.scrollHeight <= budget + 1 &&
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
  };
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(layout);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  resize.observe(navigation);
  const changes = new MutationObserver(schedule);
  changes.observe(title, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  changes.observe(root, {
    attributes: true,
    attributeFilter: ["data-mode", "data-layout"],
  });
  void document.fonts.ready.then(schedule);
  schedule();
  return () => {
    resize.disconnect();
    changes.disconnect();
    cancelAnimationFrame(scheduled);
  };
}
