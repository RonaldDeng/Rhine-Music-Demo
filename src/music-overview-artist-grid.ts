import type { OverviewArtist } from "./music-overview-artists";
import { SurfaceTransition } from "./ui-transitions";
import { followMusicMotionSpeed } from "./music-motion-ui";

const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const glassFilter = "blur(4px) saturate(0.95)";
const clearFilter = "blur(0px) saturate(1)";

/** A complete library list. Camera projections never control membership. */
export class MusicOverviewArtistGrid {
  private artists = new Map<string, OverviewArtist>();
  private buttons = new Map<string, HTMLButtonElement>();
  private active = false;
  private selectedAlbum = "";
  private catalogSignature = "";
  private pendingArtists?: readonly OverviewArtist[];
  private transition: SurfaceTransition;
  private frost: HTMLElement;
  private glass?: Animation;
  private tiles = new Map<HTMLButtonElement, Animation>();

  constructor(private root: HTMLElement, private returnFocus: () => void) {
    root.hidden = true;
    this.frost = document.createElement("div");
    this.frost.className = "overview-artist-frost";
    this.frost.hidden = true;
    this.frost.setAttribute("aria-hidden", "true");
    root.before(this.frost);
    this.transition = new SurfaceTransition(root, undefined, 460, 240, "up",
      "cubic-bezier(0.4, 0, 0.2, 1)", [root, this.frost]);
    root.addEventListener("keydown", this.onKeyDown);
    root.addEventListener("scroll", this.onScroll, { passive: true });
    root.addEventListener("focusin", this.onFocus);
  }

  get visible() { return !this.root.hidden; }
  get count() { return this.artists.size; }
  artist(key: string) { return this.artists.get(key); }

  setArtists(artists: readonly OverviewArtist[]) {
    // A library refresh must not replace fading tiles with fully opaque nodes.
    // Apply only the latest snapshot once the exit ends (or the user reopens).
    if (!this.active && this.visible && this.root.dataset.transition === "closing") {
      this.pendingArtists = artists;
      return;
    }
    const signature = JSON.stringify(artists);
    if (signature === this.catalogSignature) return;
    this.finishTiles();
    this.catalogSignature = signature;
    const scroll = this.root.scrollTop;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.overviewArtist;
    const next = new Map(artists.map(artist => [artist.key, artist]));
    for (const [key, button] of this.buttons) if (!next.has(key)) {
      button.remove();
      this.buttons.delete(key);
    }
    // Reconcile only when the library changes; scrolling and scene frames never
    // rebuild the list or remove offscreen artists from keyboard navigation.
    for (const artist of artists) {
      let button = this.buttons.get(artist.key);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "overview-artist";
        button.dataset.overviewArtist = artist.key;
        button.append(document.createElement("strong"), document.createElement("small"));
        this.buttons.set(artist.key, button);
      }
      button.querySelector("strong")!.textContent = artist.name;
      button.querySelector("small")!.textContent = `${artist.albumIds.length} 张专辑`;
      button.setAttribute("aria-label", `选择歌手：${artist.name}，${artist.albumIds.length} 张专辑`);
      this.root.append(button);
    }
    this.artists = next;
    this.syncSelection();
    this.root.scrollTop = scroll;
    if (focused !== undefined && this.active) {
      const target = this.buttons.get(focused);
      if (target) target.focus({ preventScroll: true });
      else this.returnFocus();
    }
  }

  setSelectedAlbum(id: string) {
    if (id === this.selectedAlbum) return;
    this.selectedAlbum = id;
    this.syncSelection();
  }

  private syncSelection() {
    for (const [key, button] of this.buttons)
      button.setAttribute("aria-pressed", String(this.artists.get(key)!.albumIds.includes(this.selectedAlbum)));
  }

  setActive(active: boolean, reduced: boolean) {
    if (active === this.active) {
      if (reduced) {
        this.finish();
        if (!active && this.visible) this.transition.hide(true, this.completeExit);
      }
      return;
    }
    const fresh = this.root.hidden;
    const filter = fresh ? clearFilter : getComputedStyle(this.frost).backdropFilter;
    this.active = active;
    if (active) this.applyPendingArtists();
    this.root.inert = !active;
    this.root.setAttribute("aria-hidden", String(!active));
    this.glass?.cancel();
    this.glass = undefined;
    if (active) this.frost.hidden = false;
    if (!reduced) {
      const glass = this.glass = followMusicMotionSpeed(this.frost.animate([
        { backdropFilter: filter },
        { backdropFilter: active ? glassFilter : clearFilter },
      ], { duration: active ? 460 : 240,
        easing: active ? enterEase : "cubic-bezier(0.4, 0, 1, 1)", fill: "both" }));
      void glass.finished.then(() => {
        if (this.glass !== glass || !this.active) return;
        glass.cancel();
        this.glass = undefined;
      }, () => {});
    }
    if (active) {
      this.transition.show(reduced);
      if (reduced) this.finishTiles();
      else this.revealTiles(fresh);
    }
    else {
      if (this.root.contains(document.activeElement)) this.returnFocus();
      if (reduced) this.finishTiles();
      else this.hideTiles();
      this.transition.hide(reduced, this.completeExit);
    }
  }

  private completeExit = () => {
    this.frost.hidden = true;
    this.finishTiles();
    this.glass?.cancel();
    this.glass = undefined;
    this.applyPendingArtists();
  };

  private applyPendingArtists() {
    const artists = this.pendingArtists;
    this.pendingArtists = undefined;
    if (artists) this.setArtists(artists);
  }

  private revealTiles(fresh: boolean) {
    // Only the current viewport is choreographed. A long library or a restored
    // scroll position must never leave later artists waiting behind a timer.
    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight;
    const visible = Array.from(this.buttons.values()).filter(button =>
      button.offsetTop + button.offsetHeight > top && button.offsetTop < bottom);
    const interval = Math.min(28, 196 / Math.max(1, visible.length - 1));
    let order = 0;
    for (const button of this.buttons.values()) {
      const previous = this.tiles.get(button);
      if (button.offsetTop + button.offsetHeight <= top || button.offsetTop >= bottom) {
        previous?.cancel();
        this.tiles.delete(button);
        continue;
      }
      const style = getComputedStyle(button);
      const opacity = fresh ? "0" : style.opacity;
      const transform = fresh ? "translateY(8px)" : style.transform;
      previous?.cancel();
      const animation = followMusicMotionSpeed(button.animate([
        { opacity, transform }, { opacity: 1, transform: "translateY(0)" },
      ], { duration: 360, delay: fresh ? 80 + order++ * interval : 0,
        easing: enterEase, fill: "both" }));
      this.tiles.set(button, animation);
      void animation.finished.then(() => {
        if (this.tiles.get(button) !== animation || !this.active) return;
        animation.cancel();
        this.tiles.delete(button);
      }, () => {});
    }
  }

  private hideTiles() {
    // Freeze delayed entrances at their current appearance before fading out.
    // Keep the final fill until the sheet is hidden, including interrupted exits.
    for (const [button, previous] of this.tiles) {
      const style = getComputedStyle(button);
      const opacity = style.opacity, transform = style.transform;
      previous.cancel();
      this.tiles.set(button, followMusicMotionSpeed(button.animate([
        { opacity, transform }, { opacity: 0, transform },
      ], { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" })));
    }
  }

  private finishTiles = () => {
    // CSS is the fully visible resting state. No inline opacity survives a
    // scroll, catalog update, reduced-motion change or later reopening.
    this.tiles.forEach(animation => animation.cancel());
    this.tiles.clear();
  };

  private onFocus = (event: FocusEvent) => {
    const button = event.target as HTMLButtonElement;
    if (!this.active) return;
    this.tiles.get(button)?.cancel();
    this.tiles.delete(button);
  };

  private onScroll = () => {
    if (this.active) this.finishTiles();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(this.root.querySelectorAll<HTMLButtonElement>(".overview-artist"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const columns = Math.max(1, getComputedStyle(this.root).gridTemplateColumns.split(" ").length);
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 :
      event.key === "ArrowUp" ? -columns : columns;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      Math.max(0, Math.min(buttons.length - 1, index + delta));
    buttons[next]?.focus();
  };

  finish() {
    this.transition.finish();
    this.finishTiles();
    this.glass?.finish();
  }
  dispose() {
    this.transition.dispose();
    this.finishTiles();
    this.glass?.cancel();
    this.glass = undefined;
    this.pendingArtists = undefined;
    this.frost.remove();
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.root.removeEventListener("scroll", this.onScroll);
    this.root.removeEventListener("focusin", this.onFocus);
  }
}
