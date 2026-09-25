import type { ArchiveNavigation } from "./archive-loop.ts";

export interface AlbumSelection {
  index: number;
  navigation?: ArchiveNavigation;
}

export type MusicPresentationPhase =
  | "archive" | "opening" | "detail" | "hiding" | "returning" | "selecting";

export interface MusicPresentationPorts {
  presentationReady(): boolean;
  archiveReady(): boolean;
  archiveInteractive?(): boolean;
  enterCamera(): void;
  returnCamera(): void;
  select(selection: AlbumSelection): void;
  prepareMenu(): void;
  showMenu(): void;
  hideMenu(done: () => void): void;
  hideBrowse(done: () => void): void;
  showBrowse(): void;
  mode(mode: "archive" | "detail"): void;
}

/** Serializes the visible transition; requests may change while a shot is moving. */
export class MusicPresentation {
  phase: MusicPresentationPhase = "archive";
  pendingSelection?: AlbumSelection;
  private wantsDetail = false;
  private revision = 0;
  private browseHidden = false;

  constructor(private readonly ports: MusicPresentationPorts) {}

  get openingOrDetail() { return this.wantsDetail; }

  open() {
    this.wantsDetail = true;
    if (this.phase === "archive") this.beginOpen();
  }

  back() {
    this.wantsDetail = false;
    this.pendingSelection = undefined;
    if (this.phase === "archive") return;
    if (this.phase === "selecting") {
      // A rail movement already committed may settle, but no new detail opens.
      return;
    }
    this.beginExit();
  }

  select(selection: AlbumSelection, openAfter = this.wantsDetail) {
    this.pendingSelection = selection;
    this.wantsDetail = openAfter;
    if (this.phase === "archive") {
      this.commitSelection();
      if (openAfter) {
        this.phase = "selecting";
        this.ports.hideBrowse(() => {});
      }
    } else if (this.phase !== "selecting") this.beginExit();
  }

  update() {
    if (this.phase === "opening") {
      if (this.browseHidden && this.ports.presentationReady()) {
        this.phase = "detail";
        this.ports.showMenu();
      }
      return;
    }
    if (this.phase !== "returning" && this.phase !== "selecting") return;
    // Browsing can resume during the final camera/lift easing. Automatic album
    // handoffs still wait for the fully settled archive below.
    if (this.phase === "returning" && !this.wantsDetail && this.ports.archiveInteractive?.()) {
      this.phase = "archive";
      this.ports.mode("archive");
      if (this.pendingSelection) this.commitSelection();
      this.ports.showBrowse();
      return;
    }
    if (!this.ports.archiveReady()) return;
    if (this.pendingSelection) {
      this.commitSelection();
      this.phase = "selecting";
      return; // Read the newly selected camera/rail state on the following frame.
    }
    if (this.wantsDetail) this.beginOpen();
    else {
      this.phase = "archive";
      this.ports.mode("archive");
      this.ports.showBrowse();
    }
  }

  /** Replay/library replacement invalidate callbacks from the previous album. */
  reset() {
    this.revision++;
    this.pendingSelection = undefined;
    this.wantsDetail = false;
    this.browseHidden = false;
    this.phase = "archive";
    this.ports.mode("archive");
  }

  private beginOpen() {
    const revision = ++this.revision;
    this.phase = "opening";
    this.browseHidden = false;
    this.ports.mode("detail");
    this.ports.prepareMenu();
    this.ports.hideBrowse(() => {
      if (revision === this.revision) this.browseHidden = true;
    });
    this.ports.enterCamera();
  }

  private beginExit() {
    if (this.phase === "hiding" || this.phase === "returning") return;
    const revision = ++this.revision;
    this.phase = "hiding";
    this.ports.hideMenu(() => {
      if (revision !== this.revision) return;
      this.phase = "returning";
      this.ports.mode("archive");
      this.ports.returnCamera();
    });
  }

  private commitSelection() {
    const request = this.pendingSelection!;
    this.pendingSelection = undefined;
    this.ports.select(request);
  }
}
