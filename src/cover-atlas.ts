import * as THREE from "three";
import type { ArchiveRecord } from "./data";

// The GLB's front cover is z=0.206; the original printed ink reaches z=0.2464.
// A single flat print at z=0.255 leaves the original shell and fasteners intact.
export const COVER_SIZE = { width: 4.2, height: 3.15, y: 1.85, z: 0.255 };
type CoverImage = { source: HTMLCanvasElement; width: number; height: number };

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

function paintCover(
  canvas: HTMLCanvasElement,
  record: ArchiveRecord | undefined,
  image?: CoverImage,
) {
  const context = canvas.getContext("2d")!;
  const width = canvas.width,
    height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (image) {
    const box = containCover(image.width, image.height, width - 4, height - 4);
    context.drawImage(
      image.source,
      box.x + 2,
      box.y + 2,
      box.width,
      box.height,
    );
    return;
  }
  // A missing cover is explicit and never substituted with another album's art.
  const size = height - 4,
    left = (width - size) / 2;
  context.fillStyle = "#c9c9c4";
  context.fillRect(left, 2, size, size);
  context.strokeStyle = "#f8f7f1";
  context.lineWidth = Math.max(1, height / 180);
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.2, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.04, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#3f4849";
  context.textAlign = "center";
  context.font = `500 ${Math.max(12, height * 0.045)}px sans-serif`;
  context.fillText(
    record?.title ?? "暂无专辑封面",
    width / 2,
    height * 0.8,
    height * 0.83,
  );
  context.font = `${Math.max(9, height * 0.025)}px sans-serif`;
  context.fillText(
    "LOCAL COLLECTION / NO COVER",
    width / 2,
    height * 0.87,
    height * 0.83,
  );
}

/** One fixed-size atlas for the visible pool, regardless of total library size. */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly atlasCanvas = document.createElement("canvas");
  private readonly selectedCanvas = document.createElement("canvas");
  private readonly tileCanvas = document.createElement("canvas");
  private readonly atlas: THREE.CanvasTexture;
  private readonly selectedTexture: THREE.CanvasTexture;
  private readonly images = new Map<string, Promise<CoverImage | undefined>>();
  private readonly slots: (ArchiveRecord | undefined)[];
  private selectedRecord?: ArchiveRecord;
  private generation = 0;
  private disposed = false;
  private readonly columns = 16;
  private readonly rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;

  constructor(count: number, maxTextureSize: number, anisotropy: number) {
    this.rows = Math.ceil(count / this.columns);
    this.tileWidth = Math.min(
      256,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(((maxTextureSize / this.rows) * 4) / 3),
    );
    this.tileHeight = Math.floor((this.tileWidth * 3) / 4);
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileCanvas.width = this.tileWidth;
    this.tileCanvas.height = this.tileHeight;
    this.selectedCanvas.width = 1024;
    this.selectedCanvas.height = 768;
    this.slots = Array(count);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    // No whole-atlas mip pyramid: independent transparent tile margins prevent bleed.
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.anisotropy = Math.min(4, anisotropy);
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = Math.min(8, anisotropy);
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(0, COVER_SIZE.y, COVER_SIZE.z);
    const tileOffsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      tileOffsets.set(
        [
          (i % this.columns) / this.columns,
          1 - (Math.floor(i / this.columns) + 1) / this.rows,
          1 / this.columns,
          1 / this.rows,
        ],
        i * 4,
      );
    }
    geometry.setAttribute(
      "coverTile",
      new THREE.InstancedBufferAttribute(tileOffsets, 4),
    );
    const material = new THREE.MeshBasicMaterial({
      map: this.atlas,
      alphaTest: 0.025,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = "attribute vec4 coverTile;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvMapUv = coverTile.xy + uv * coverTile.zw;",
      );
    };
    material.customProgramCacheKey = () => "album-cover-atlas-v1";
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        0,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      new THREE.MeshBasicMaterial({
        map: this.selectedTexture,
        alphaTest: 0.025,
        toneMapped: false,
      }),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
  }

  private loadImage(url?: string) {
    if (!url) return Promise.resolve(undefined);
    let pending = this.images.get(url);
    if (!pending) {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url;
      pending = image
        .decode()
        .then(() => {
          // Retain bounded thumbnails, not decoded multi-megapixel source art.
          const width = image.naturalWidth,
            height = image.naturalHeight;
          const scale = Math.min(1, 1024 / Math.max(width, height));
          const source = document.createElement("canvas");
          source.width = Math.max(1, Math.round(width * scale));
          source.height = Math.max(1, Math.round(height * scale));
          source
            .getContext("2d")!
            .drawImage(image, 0, 0, source.width, source.height);
          image.src = "";
          return { source, width, height };
        })
        .catch(() => undefined);
      this.images.set(url, pending);
      if (this.images.size > 48)
        this.images.delete(this.images.keys().next().value!);
    }
    return pending;
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    if (this.slots[slot] === record) return;
    this.slots[slot] = record;
    const draw = (image?: CoverImage) => {
      if (this.disposed || this.slots[slot] !== record) return;
      paintCover(this.tileCanvas, record, image);
      const x = (slot % this.columns) * this.tileWidth,
        y = Math.floor(slot / this.columns) * this.tileHeight;
      const context = this.atlasCanvas.getContext("2d")!;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      this.atlas.needsUpdate = true;
    };
    draw();
    void this.loadImage(record?.album?.coverUrl).then(draw);
  }

  async select(record: ArchiveRecord | undefined) {
    this.selectedRecord = record;
    const generation = this.generation;
    paintCover(this.selectedCanvas, record);
    this.selectedTexture.needsUpdate = true;
    const image = await this.loadImage(record?.album?.coverUrl);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.selectedRecord !== record
    )
      return;
    paintCover(this.selectedCanvas, record, image);
    this.selectedTexture.needsUpdate = true;
  }

  snapshot(mesh: THREE.Mesh) {
    const canvas = document.createElement("canvas");
    canvas.width = this.selectedCanvas.width;
    canvas.height = this.selectedCanvas.height;
    canvas.getContext("2d")!.drawImage(this.selectedCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.selectedTexture.anisotropy;
    mesh.material = this.selected.material.clone();
    (mesh.material as THREE.MeshBasicMaterial).map = texture;
    const record = this.selectedRecord;
    mesh.userData.coverDisposed = false;
    void this.loadImage(record?.album?.coverUrl).then((image) => {
      if (mesh.userData.coverDisposed || this.disposed) return;
      paintCover(canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  reset() {
    this.generation++;
    this.slots.fill(undefined);
    this.selectedRecord = undefined;
    this.images.clear();
  }
  dispose() {
    this.disposed = true;
    this.images.clear();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
  }
}
