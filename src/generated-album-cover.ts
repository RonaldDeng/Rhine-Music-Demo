import { drawCover } from "../reference/cover-candidates/generator.mjs";

export interface GeneratedCoverMetadata { id?: string; title: string; artist?: string }
type CachedCover = { canvas: HTMLCanvasElement; dataUrl?: string };
const cache = new Map<string, CachedCover>();
const maxCachedCovers = 24;
let fontsReady: Promise<void> | undefined;

/** Prefer stable font metrics without letting a stalled font block startup. */
export function prepareGeneratedCoverFonts() {
  return fontsReady ??= new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2500);
    const complete = () => { clearTimeout(timeout); resolve(); };
    void (async () => {
      if (!document.fonts) return;
      // Include the UI's semibold face so startup needs no second font wait.
      await Promise.allSettled([400, 600, 700].map(weight =>
        document.fonts.load(`${weight} 100px "MiSans"`, "风经过的地方 Where the Wind Goes"),
      ));
      await document.fonts.ready;
    })().then(() => {
      // If fonts arrive after the deadline, future requests should not reuse
      // a fallback-font bitmap. Existing canvases remain safe for their owners.
      cache.clear();
      complete();
    }, complete);
  });
}

function generatedCover(metadata: GeneratedCoverMetadata) {
  const title = metadata.title || "未命名专辑";
  const artist = metadata.artist || "未知艺术家";
  const key = JSON.stringify([metadata.id, title, artist]);
  let entry = cache.get(key);
  if (entry) cache.delete(key);
  else {
    const canvas = document.createElement("canvas");
    drawCover(canvas, { title, artist, albumKey: metadata.id }, "b");
    entry = { canvas };
  }
  cache.set(key, entry);
  // Release old sources without resizing them: a caller may still be painting.
  if (cache.size > maxCachedCovers) cache.delete(cache.keys().next().value!);
  return entry;
}

export const generatedCoverSource = (metadata: GeneratedCoverMetadata) => generatedCover(metadata).canvas;
export function generatedCoverDataUrl(metadata: GeneratedCoverMetadata) {
  const entry = generatedCover(metadata);
  return entry.dataUrl ??= entry.canvas.toDataURL("image/png");
}
