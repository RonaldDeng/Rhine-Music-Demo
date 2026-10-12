import { visibleOverviewLabels, overviewLabelOpacity, overviewCollisionOpacity, overviewLabelClearance, overviewBoundaryClearance, type OverviewColumn, type OverviewBounds } from "./music-overview";
import { SurfaceTransition } from "./ui-transitions";
import { MusicOverviewArtistGrid } from "./music-overview-artist-grid";
import { overviewUsesArtistGrid, type OverviewArtist } from "./music-overview-artists";

interface LabelSurface {
  anchor: HTMLDivElement;
  card: HTMLDivElement;
  label: HTMLButtonElement;
  enter: HTMLButtonElement;
  transition: SurfaceTransition;
  visible: boolean;
  physicalLane?: number;
}

/** Projected anchors never animate: the card inside owns its visible lifetime. */
export class MusicOverviewUI {
  private labels = new Map<number, LabelSurface>();
  private chrome: SurfaceTransition[];
  private active = false;
  private chromeShown = false;
  private revision = 0;
  private expandedLane: number | null = null;
  private collisionLanes: number[] = [];
  private previousProjections = new Map<number, OverviewColumn>();
  private previousWidth = 0;
  private previousHeight = 0;
  private entryCandidates = new Map<number, { physicalLane?: number; seconds: number }>();
  private artistGrid?: MusicOverviewArtistGrid;
  private gridMode = false;
  private headingTitle: string;
  private headingDescription: string;

  constructor(private surface: HTMLElement, private container: HTMLElement,
    private returnFocus: () => void, artistPanel?: HTMLElement) {
    if (artistPanel) this.artistGrid = new MusicOverviewArtistGrid(artistPanel, returnFocus);
    this.headingTitle = surface.querySelector(".overview-heading h2")?.textContent ?? "";
    this.headingDescription = surface.querySelector(".overview-heading p")?.textContent ?? "";
    this.chrome = Array.from(surface.querySelectorAll<HTMLElement>(
      ".overview-heading, .overview-controls, .overview-return",
    )).map((element) => {
      element.hidden = true;
      return new SurfaceTransition(element, element, 460, 240, "up",
        "cubic-bezier(0.4, 0, 0.2, 1)");
    });
  }

  setActive(active: boolean, reduced: boolean) {
    if (this.active === active && (active || this.surface.hidden)) return;
    const revision = ++this.revision;
    this.active = active;
    this.entryCandidates.clear();
    this.collapse();
    this.surface.inert = !active;
    this.surface.setAttribute("aria-hidden", String(!active));
    if (active) {
      this.surface.hidden = false;
      if (reduced) this.showChrome(true);
      return;
    }
    this.chromeShown = false;
    this.artistGrid?.setActive(false, reduced);
    if (this.surface.contains(document.activeElement)) this.returnFocus();
    for (const [lane, label] of this.labels) if (label.visible || reduced)
      this.hideLabel(lane, label, reduced);
    this.chrome.forEach((motion, index) => motion.hide(reduced, () => {
      if (index === this.chrome.length - 1 && revision === this.revision && !this.active)
        this.surface.hidden = true;
    }));
  }

  private showChrome(reduced: boolean) {
    if (this.chromeShown) return;
    this.chromeShown = true;
    this.chrome.forEach((motion) => motion.show(reduced));
    this.returnFocus();
  }

  expand(lane: number) {
    if (!this.active || !this.labels.get(lane)?.visible) return;
    this.expandedLane = lane;
    this.syncExpansion();
  }

  collapse() {
    this.expandedLane = null;
    this.syncExpansion();
  }

  get hasLabels() { return this.labels.size > 0 || !!this.artistGrid?.visible; }
  get isArtistGrid() { return this.active && this.gridMode; }
  artist(key: string) { return this.artistGrid?.artist(key); }
  setArtists(artists: readonly OverviewArtist[]) { this.artistGrid?.setArtists(artists); this.syncHeading(); }
  setSelectedAlbum(id: string) { this.artistGrid?.setSelectedAlbum(id); }

  private syncHeading() {
    const title = this.surface.querySelector(".overview-heading h2");
    const description = this.surface.querySelector(".overview-heading p");
    if (title) title.textContent = this.gridMode ? "选择歌手" : this.headingTitle;
    if (description) description.textContent = this.gridMode
      ? `${this.artistGrid?.count ?? 0} 位歌手 · 点击返回近景` : this.headingDescription;
  }

  canEnter(lane: number) {
    return this.active && this.expandedLane === lane && !!this.labels.get(lane)?.visible;
  }

  private syncExpansion() {
    for (const [lane, item] of this.labels) {
      const expanded = lane === this.expandedLane && item.visible;
      // Keep focus on the name if a navigation input folds its entry button.
      if (!expanded && document.activeElement === item.enter) item.label.focus({ preventScroll: true });
      item.card.dataset.expanded = String(expanded);
      item.label.setAttribute("aria-expanded", String(expanded));
      item.enter.disabled = !expanded;
      item.enter.tabIndex = expanded ? 0 : -1;
      item.enter.setAttribute("aria-hidden", String(!expanded));
    }
  }

  update(columns: OverviewColumn[], width: number, height: number, progress: number,
    reduced: boolean, columnName: string, dt = 0, artistGridAllRatios = false) {
    if (this.surface.hidden) return;
    const gridMode = !!this.artistGrid && overviewUsesArtistGrid(width, height, artistGridAllRatios);
    if (gridMode !== this.gridMode) {
      this.gridMode = gridMode;
      this.surface.dataset.layout = gridMode ? "grid" : "projected";
      this.collapse();
      // A layout change replaces the interaction surface, not its coordinates.
      // Retire old projected anchors before the independent panel can appear.
      for (const [lane, item] of this.labels) this.hideLabel(lane, item, true);
      this.previousProjections.clear();
      this.entryCandidates.clear();
      this.collisionLanes = [];
      if (!gridMode) this.artistGrid?.setActive(false, true);
      this.syncHeading();
    }
    if (this.active && progress > .12) this.showChrome(reduced);
    this.artistGrid?.setActive(this.active && gridMode && progress > .12, reduced);
    if (gridMode) {
      this.surface.dataset.ready = String(this.active && progress > .12);
      return;
    }
    const ready = this.active && progress > .75;
    this.surface.dataset.ready = String(ready);
    const bounds = this.bounds(height);
    const projections = new Map(columns.map(column => [column.lane, column]));
    // dt shares the animation-speed clock with the 240 ms card exit. Looking
    // 500 ms ahead includes acceleration/frame margins; anchors stay exact.
    const forecasts = !reduced && dt > 0 && dt <= .15 &&
      width === this.previousWidth && height === this.previousHeight
      ? [.2, .5].map(seconds => new Map(columns.map(column => {
        const previous = this.previousProjections.get(column.lane);
        if (!previous || previous.physicalLane !== column.physicalLane) return [column.lane, column];
        const ahead = (current: number, before: number) => current + (current - before) * seconds / dt;
        return [column.lane, { ...column, x: ahead(column.x, previous.x), y: ahead(column.y, previous.y),
          extent: ahead(column.extent ?? 1, previous.extent ?? 1),
          copyClearance: column.copyClearance !== undefined && previous.copyClearance !== undefined
            ? ahead(column.copyClearance, previous.copyClearance) : column.copyClearance }];
      }))) : [];

    for (const [lane, item] of this.labels) {
      const column = projections.get(lane);
      // A repeated pool slot is a new physical occurrence, never a moving label.
      if (!column || item.physicalLane !== column.physicalLane ||
        overviewLabelOpacity(column, width, height, bounds) === 0)
        this.hideLabel(lane, item, true);
    }
    const retained = new Set(Array.from(this.labels).filter(([, item]) => item.visible).map(([lane]) => lane));
    // Once retirement starts, complete it. A decelerating/reversing forecast
    // must not restart show/hide on the same half-faded card every frame.
    const candidates = columns.filter(column => !this.labels.has(column.lane) || this.labels.get(column.lane)!.visible);
    const desired = ready ? visibleOverviewLabels(candidates, width, height, retained,
      this.expandedLane, bounds, forecasts) : [];
    const desiredLanes = new Set(desired.map(column => column.lane));
    const retiring = [...this.labels.keys()].filter(lane => !desiredLanes.has(lane))
      .flatMap(lane => projections.has(lane) ? [projections.get(lane)!] : []);
    const unobstructed = desired.filter(column => this.labels.get(column.lane)?.visible ||
      !retiring.some(other => overviewLabelClearance(column, other, width) <= 10 ||
        forecasts.some(forecast => overviewLabelClearance(forecast.get(column.lane) ?? column,
          forecast.get(other.lane) ?? other, width) <= 10)));
    // Brief safe gaps during a moving squeeze are not a fresh entrance. Wait
    // for continuous clearance; an already readable name needs no extra delay.
    const pending = new Map<number, { physicalLane?: number; seconds: number }>();
    const visible = unobstructed.filter(column => {
      if (this.labels.get(column.lane)?.visible || reduced || dt === 0) return true;
      const previous = this.entryCandidates.get(column.lane);
      const seconds = (previous?.physicalLane === column.physicalLane ? previous?.seconds ?? 0 : 0) + dt;
      pending.set(column.lane, { physicalLane: column.physicalLane, seconds });
      return seconds >= .12;
    });
    this.entryCandidates = pending;
    const wanted = new Set(visible.map(column => column.lane));
    // Keep the same collision priority during the whole surface exit. Clearing
    // it when ready becomes false would brighten a fading card for one frame.
    const outgoing = this.collisionLanes.filter(lane => !wanted.has(lane) && this.labels.has(lane))
      .flatMap(lane => projections.has(lane) ? [projections.get(lane)!] : []);
    const collisionColumns = [...visible, ...outgoing];
    this.collisionLanes = collisionColumns.map(column => column.lane);
    // A retiring card follows the same projection until its finite fade ends.
    // Predictable movement has already reserved its full fade. Keep the hard
    // guard only for discontinuities (resize, a new layout or a sudden jump).
    for (const column of collisionColumns) {
      const item = this.labels.get(column.lane);
      const present = collisionColumns.filter(other => wanted.has(other.lane) || this.labels.has(other.lane));
      if (item && !wanted.has(column.lane) && !this.place(item, column, width, height, bounds, present))
        this.hideLabel(column.lane, item, true);
    }
    for (const [lane, item] of this.labels) if (!wanted.has(lane) && item.visible)
      this.hideLabel(lane, item, reduced);
    // A near-edge card can start moving from rest with less than 240 ms of
    // room. Finish its existing fade continuously inside that shrinking room,
    // instead of cancelling it at contact. Ordinary exits retain full timing.
    if (forecasts.length) for (const column of outgoing) {
      const item = this.labels.get(column.lane), previous = this.previousProjections.get(column.lane);
      if (!item || item.visible || !previous || previous.physicalLane !== column.physicalLane) continue;
      let time = Infinity;
      const approach = (now: number, before: number) => {
        if (now > 0 && before > now) time = Math.min(time, now * dt / (before - now));
      };
      approach(overviewBoundaryClearance(column, width, height, bounds),
        overviewBoundaryClearance(previous, width, height, bounds));
      approach(column.extent ?? 1, previous.extent ?? 1);
      if (column.copyClearance !== undefined && previous.copyClearance !== undefined)
        approach(column.copyClearance, previous.copyClearance);
      const index = collisionColumns.findIndex(other => other.lane === column.lane);
      for (const other of collisionColumns.slice(0, index)) {
        const before = this.previousProjections.get(other.lane);
        if (before && before.physicalLane === other.physicalLane)
          approach(overviewLabelClearance(column, other, width), overviewLabelClearance(previous, before, width));
      }
      if (Number.isFinite(time)) item.transition.finishWithin(Math.max(dt, time * .85 - dt) * 1000);
    }
    this.previousProjections = new Map(columns.map(column => [column.lane, { ...column }]));
    this.previousWidth = width;
    this.previousHeight = height;
    for (const column of visible) {
      let item = this.labels.get(column.lane);
      if (!item) {
        const anchor = document.createElement("div");
        anchor.className = "overview-anchor";
        anchor.innerHTML = '<div class="overview-column"><button type="button" class="overview-column-label"><strong></strong><small></small></button><span class="overview-enter-slot"><button type="button" class="overview-enter"><span aria-hidden="true">→</span></button></span></div>';
        const card = anchor.querySelector<HTMLDivElement>(".overview-column")!;
        card.hidden = true;
        const label = anchor.querySelector<HTMLButtonElement>(".overview-column-label")!;
        const enter = anchor.querySelector<HTMLButtonElement>(".overview-enter")!;
        label.dataset.overviewLane = String(column.lane);
        enter.dataset.overviewEnterLane = String(column.lane);
        enter.id = `overview-enter-${column.lane}`;
        label.setAttribute("aria-controls", enter.id);
        item = { anchor, card, label, enter, visible: false, physicalLane: column.physicalLane,
          transition: new SurfaceTransition(card, undefined, 460, 240, "up",
            "cubic-bezier(0.4, 0, 0.2, 1)") };
        this.labels.set(column.lane, item);
        this.container.append(anchor);
      }
      this.place(item, column, width, height, bounds, collisionColumns);
      item.label.title = column.name;
      item.label.setAttribute("aria-label", `切换到${columnName}：${column.name}`);
      const name = item.label.querySelector("strong")!, count = item.label.querySelector("small")!;
      const caption = `${String(column.lane + 1).padStart(2, "0")} / ${column.count} 张专辑`;
      if (name.textContent !== column.name) name.textContent = column.name;
      if (count.textContent !== caption) count.textContent = caption;
      item.enter.setAttribute("aria-label", `进入${column.name}的标准视图`);
      item.card.setAttribute("aria-current", String(column.selected));
      item.label.disabled = !ready;
      if (!item.visible) {
        item.visible = true;
        item.anchor.inert = false;
        item.transition.show(reduced);
      }
    }
    this.syncExpansion();
  }

  private bounds(height: number): OverviewBounds {
    const heading = this.surface.querySelector<HTMLElement>(".overview-heading");
    const controls = this.surface.querySelector<HTMLElement>(".overview-controls");
    const back = this.surface.querySelector<HTMLElement>(".overview-return");
    const header = this.surface.parentElement?.querySelector<HTMLElement>(".music-header");
    return {
      top: header ? header.offsetTop + header.offsetHeight + 16 : 115,
      // The heading occupies its own corner, not a full-width exclusion band.
      obstacles: heading?.offsetHeight ? [{ left: heading.offsetLeft, top: heading.offsetTop,
        right: heading.offsetLeft + heading.offsetWidth, bottom: heading.offsetTop + heading.offsetHeight }] : [],
      bottom: Math.min(controls?.offsetTop ?? height - 88, back?.offsetTop ?? height - 88) - 24,
    };
  }

  private place(item: LabelSurface, column: OverviewColumn, width: number, height: number,
    bounds: OverviewBounds, visible: OverviewColumn[]) {
    item.anchor.style.left = `${column.x.toFixed(2)}px`;
    item.anchor.style.top = `${column.y.toFixed(2)}px`;
    let opacity = overviewLabelOpacity(column, width, height, bounds);
    // Only the lower priority member yields as two projections converge.
    // New entrants wait outside this list while an outgoing footprint is held.
    const index = visible.findIndex(other => other.lane === column.lane);
    for (const other of index < 0 ? visible : visible.slice(0, index))
      opacity = Math.min(opacity, overviewCollisionOpacity(column, other, width));
    item.anchor.style.opacity = String(opacity);
    return opacity === 1;
  }

  private hideLabel(lane: number, item: LabelSurface, reduced: boolean) {
    item.visible = false;
    item.anchor.inert = true;
    if (this.expandedLane === lane) this.expandedLane = null;
    if (item.anchor.contains(document.activeElement)) this.returnFocus();
    item.transition.hide(reduced, () => {
      if (item.visible) return;
      item.transition.dispose();
      item.anchor.remove();
      if (this.labels.get(lane) === item) this.labels.delete(lane);
    });
  }

  finish() {
    this.artistGrid?.finish();
    this.chrome.forEach((motion) => motion.finish());
    for (const item of this.labels.values()) item.transition.finish();
  }

  dispose() {
    this.artistGrid?.dispose();
    this.revision++;
    this.chrome.forEach((motion) => motion.dispose());
    for (const item of this.labels.values()) item.transition.dispose();
    this.labels.clear();
    this.collisionLanes = [];
    this.previousProjections.clear();
    this.entryCandidates.clear();
  }
}
