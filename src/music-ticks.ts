type MusicTickItem = { index: number; title: string };

/** Persistent display slots preserve CSS motion when albums or genres change. */
export function setupMusicTicks(host: HTMLElement) {
  const slots = Array.from({ length: 12 }, () => {
    const button = document.createElement("button");
    button.type = "button";
    button.hidden = true;
    button.tabIndex = -1;
    return button;
  });
  host.replaceChildren(...slots);
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "选择专辑");
  let windowStart = 0,
    previousItems = "";
  return {
    update(items: MusicTickItem[], selected: number, reduced: boolean) {
      host.dataset.reduced = String(reduced);
      const selectedSlot = Math.max(
        0,
        items.findIndex((item) => item.index === selected),
      );
      const itemKey = items.map((item) => item.index).join(",");
      // Keep twelve items visible, but don't chase every selection with the
      // window: that would pin the active bar to slot six for long genres.
      // Recenter only on entry or after the selection crosses a window edge.
      if (
        itemKey !== previousItems ||
        selectedSlot < windowStart ||
        selectedSlot >= windowStart + slots.length
      )
        windowStart = Math.max(
          0,
          Math.min(selectedSlot - 5, items.length - slots.length),
        );
      previousItems = itemKey;
      const visible = items.slice(windowStart, windowStart + slots.length);
      const focused = document.activeElement;
      slots.forEach((button, slot) => {
        const item = visible[slot];
        button.hidden = !item;
        button.tabIndex = item ? 0 : -1;
        const active = item?.index === selected;
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", String(active));
        button.setAttribute("aria-pressed", String(active));
        if (item) {
          button.dataset.select = String(item.index);
          button.setAttribute("aria-label", `选择专辑 ${item.title}`);
          button.title = item.title;
        } else {
          delete button.dataset.select;
          button.removeAttribute("aria-label");
          button.removeAttribute("title");
        }
      });
      // A shorter genre must not leave keyboard focus on a hidden old slot.
      if (slots.some((button) => button === focused && button.hidden))
        (
          slots.find(
            (button) => !button.hidden && button.classList.contains("active"),
          ) || slots.find((button) => !button.hidden)
        )?.focus({ preventScroll: true });
    },
  };
}
