import * as THREE from "three";
import { COVER_SIZE, containCover } from "./cover-atlas";
import type { MusicAlbum } from "./music-types";

/** A viewer owns its own print and texture, independent of the array's selection. */
export class ViewerAlbumCover {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly ready: Promise<void>;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private image?: HTMLImageElement;
  private disposed = false;

  constructor(
    readonly album: MusicAlbum,
    anisotropy = 1,
  ) {
    this.canvas.width = 1024;
    this.canvas.height = 768;
    this.paintPlaceholder();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = Math.min(8, anisotropy);
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        0,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        alphaTest: 0.025,
        toneMapped: false,
      }),
    );
    this.mesh.name = "Album cover print";
    this.mesh.userData.albumCover = true;
    this.mesh.userData.albumId = album.id;
    this.mesh.userData.assemblyPart = "cover";
    this.mesh.userData.coverDisposed = false;
    this.mesh.userData.coverStatus = album.coverUrl ? "loading" : "missing";
    this.ready = this.load();
  }

  private paintPlaceholder() {
    const context = this.canvas.getContext("2d")!;
    const { width, height } = this.canvas;
    const size = height - 4,
      left = (width - size) / 2;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#c9c9c4";
    context.fillRect(left, 2, size, size);
    context.strokeStyle = "#f8f7f1";
    context.lineWidth = height / 180;
    for (const radius of [0.2, 0.04]) {
      context.beginPath();
      context.arc(width / 2, height * 0.43, height * radius, 0, Math.PI * 2);
      context.stroke();
    }
    context.fillStyle = "#3f4849";
    context.textAlign = "center";
    context.font = "500 34px sans-serif";
    context.fillText(
      this.album.title || "暂无专辑封面",
      width / 2,
      height * 0.8,
      height * 0.83,
    );
    context.font = "19px sans-serif";
    context.fillText(
      "LOCAL COLLECTION / NO COVER",
      width / 2,
      height * 0.87,
      height * 0.83,
    );
  }

  private async load() {
    if (!this.album.coverUrl) return;
    const image = new Image();
    this.image = image;
    image.crossOrigin = "anonymous";
    image.src = this.album.coverUrl;
    try {
      await image.decode();
      if (this.disposed || this.mesh.userData.coverDisposed) return;
      const context = this.canvas.getContext("2d")!;
      const { width, height } = this.canvas;
      const box = containCover(
        image.naturalWidth,
        image.naturalHeight,
        width - 4,
        height - 4,
      );
      context.clearRect(0, 0, width, height);
      context.drawImage(image, box.x + 2, box.y + 2, box.width, box.height);
      this.mesh.userData.coverStatus = "loaded";
      this.mesh.userData.coverImageSize = [
        image.naturalWidth,
        image.naturalHeight,
      ];
      this.texture.needsUpdate = true;
    } catch {
      if (!this.disposed) this.mesh.userData.coverStatus = "missing";
      // Keep this album's explicit missing-cover print; never reuse another album.
    } finally {
      image.src = "";
      if (this.image === image) this.image = undefined;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.userData.coverDisposed = true;
    if (this.image) this.image.src = "";
    this.mesh.removeFromParent();
    this.texture.dispose();
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
