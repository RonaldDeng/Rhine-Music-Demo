import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
import { CoverAtlas, COVER_INSET, COVER_PAINT_SIZE, COVER_SIZE, containCover, paintCover } from "../src/cover-atlas.ts";
import { generatedCoverSource, generatedCoverDataUrl } from "../src/generated-album-cover.ts";
import { escapeHtml } from "../src/html.ts";
import { LOOP_COLUMNS, MUSIC_LOOP_ROWS } from "../src/archive-loop.ts";

// Deterministic image decode/canvas harness exercises production ownership and
// drawing code. Pixel quality and GPU transmission are checked in the browser.
class Canvas {
  width = 0; height = 0; token = "empty"; tiles = new Map(); calls = []; sources = [];
  context;
  toDataURL() { return `data:image/png;base64,${Buffer.from(this.token).toString("base64")}`; }
  getContext() {
    return this.context ??= {
      font: "400 16px sans-serif",
      measureText(text) {
        const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16);
        return { width: Array.from(text).length * size * 0.56,
          actualBoundingBoxLeft: 0, actualBoundingBoxRight: Array.from(text).length * size * 0.56,
          actualBoundingBoxAscent: size * 0.78, actualBoundingBoxDescent: size * 0.2 };
      },
      setTransform: (...args) => this.calls.push(["transform", ...args]),
      clearRect: (x, y) => { this.token = "cleared"; this.tiles.delete(`${x},${y}`); },
      fillRect: () => { this.token = "placeholder"; },
      beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {},
      fillText: (title) => { this.calls.push(["text", title]); if (this.token === "placeholder") this.token = `generated:${title}`; },
      drawImage: (source, ...args) => {
        this.sources.push(source);
        const token = args.length === 8 ? source.tiles.get(`${args[0]},${args[1]}`) ?? source.token : source.token;
        this.token = token;
        this.calls.push(["draw", token, ...args]);
        if (args.length === 2) this.tiles.set(`${args[0]},${args[1]}`, token);
      },
    };
  }
}
const pending = new Map();
const imageSources = [];
let decodes = 0;
class DeferredImage {
  naturalWidth = 1200; naturalHeight = 800; token = "";
  set src(value) { if (value) { this.token = value; imageSources.push(value); } else this.reject?.(new DOMException("Cancelled", "AbortError")); }
  decode() {
    decodes++;
    return new Promise((resolve, reject) => { this.reject = reject; pending.set(this.token, { resolve, reject }); });
  }
}
const previousDocument = globalThis.document, previousImage = globalThis.Image;
globalThis.document = { createElement: (name) => { assert.equal(name, "canvas"); return new Canvas(); } };
globalThis.Image = DeferredImage;
const record = (id) => ({ id, title: `Album ${id}`, album: { id, title: `Album ${id}`, coverUrl: `cover-${id}` } });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

try {
  const missingMetadata = { id: "no-original", title: "Entire Words Stay Together", artist: "Synthetic Artist" };
  const generated = generatedCoverSource(missingMetadata);
  assert.deepEqual([generated.width, generated.height], [800, 800]);
  assert.equal(generatedCoverSource({ ...missingMetadata }), generated, "metadata-identical requests share the B source");
  assert.match(generatedCoverDataUrl(missingMetadata), /^data:image\/png;base64,/);
  assert.ok(generated.calls.some(call => call[0] === "text" && call[1] === "Synthetic Artist"), "artist metadata reaches the shared B painter");
  for (let index = 0; index < 23; index++) generatedCoverSource({ id: `lru-${index}`, title: `Synthetic ${index}` });
  assert.equal(generatedCoverSource(missingMetadata), generated, "the most recently used source survives eviction");
  for (let index = 23; index < 48; index++) generatedCoverSource({ id: `lru-${index}`, title: `Synthetic ${index}` });
  assert.notEqual(generatedCoverSource(missingMetadata), generated, "cache releases older sources after 24 entries");

  // Exercise the production DOM thumbnail markup and capture-phase error
  // handler as well as the 3D painter; broken files must not leave blank art.
  const appSource = await fs.readFile(new URL("../src/music-app.ts", import.meta.url), "utf8");
  const appTree = ts.createSourceFile("music-app.ts", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const coverMarkup = appTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "cover");
  const coverErrorListener = appTree.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(appTree) === "document.addEventListener" &&
    node.expression.arguments[0]?.getText(appTree) === '"error"');
  assert.ok(coverMarkup && coverErrorListener);
  const domCode = ts.transpileModule(`${coverMarkup.getText(appTree)}\nconst onError = ${coverErrorListener.expression.arguments[1].getText(appTree)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  class DomImage { dataset = {}; src = ""; alt = ""; }
  const domAlbum = { ...missingMetadata, coverUrl: "synthetic-original.png" };
  const dom = new Function("generatedCoverDataUrl", "esc", "albums", "HTMLImageElement", `${domCode}; return { cover, onError };`)(
    generatedCoverDataUrl, escapeHtml, [domAlbum], DomImage,
  );
  assert.match(dom.cover(domAlbum), /src="synthetic-original\.png"/, "normal DOM thumbnails retain original covers");
  assert.match(dom.cover({ ...domAlbum, coverUrl: undefined }), /src="data:image\/png;base64,/, "missing DOM thumbnails use B");
  const brokenDom = new DomImage(); brokenDom.dataset.albumCover = domAlbum.id;
  dom.onError({ target: brokenDom });
  assert.equal(brokenDom.src, generatedCoverDataUrl(domAlbum));
  assert.equal(brokenDom.dataset.albumCover, undefined, "failed original thumbnail falls back only once");
  brokenDom.src = "sentinel"; dom.onError({ target: brokenDom });
  assert.equal(brokenDom.src, "sentinel", "a data URL failure cannot trigger a retry loop");

  // Complete art, centred on all aspect ratios, with resolution-independent
  // physical margins. No crop, negative size, UV flip or ownership rescale.
  for (const [width, height] of [[1024, 1024], [1800, 600], [600, 1800], [1, 2000], [2000, 1]]) {
    const box = containCover(width, height, 992, 992);
    assert.ok(Math.abs(box.width / box.height - width / height) < 1e-8);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 992 && box.y + box.height <= 992);
    const commands = [];
    for (const size of [128, 248, 256, 1024]) {
      const canvas = new Canvas(); canvas.width = canvas.height = size;
      paintCover(canvas, record("art"), { source: { token: "asymmetric-art" }, width, height });
      const draw = canvas.calls.find(call => call[0] === "draw");
      const [, token, x, y, w, h] = draw;
      assert.equal(token, "asymmetric-art");
      assert.ok(x >= COVER_PAINT_SIZE * COVER_INSET && y >= COVER_PAINT_SIZE * COVER_INSET);
      assert.ok(w > 0 && h > 0, "source orientation is preserved");
      assert.ok(x + w <= COVER_PAINT_SIZE * (1 - COVER_INSET));
      assert.ok(y + h <= COVER_PAINT_SIZE * (1 - COVER_INSET));
      commands.push(draw);
    }
    commands.forEach(command => assert.deepEqual(command, commands[0], "atlas, selection and viewer paint in the same UV space"));
  }
  const atlas = new CoverAtlas(32, 4096, 16);
  assert.equal(atlas.array.geometry.attributes.coverTile.count, 32);
  assert.equal(atlas.array.material.map.generateMipmaps, false);
  assert.equal(atlas.array.material.map.anisotropy, 1);
  assert.ok(atlas.selected.material.map.anisotropy > 1);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  atlas.array.material.onBeforeCompile(shader, {});
  assert.ok(shader.fragmentShader.includes("clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5"), "every sample stays within its own tile centres");
  assert.deepEqual(shader.uniforms.coverAtlasTexel.value.toArray(), [1 / 4096, 1 / 512]);
  const positions = atlas.selected.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) assert.ok(Math.abs(positions.getZ(i) - COVER_SIZE.z) < 1e-8);
  const uvs = atlas.selected.geometry.attributes.uv;
  assert.deepEqual(Array.from(uvs.array), [0, 1, 1, 1, 0, 0, 1, 0], "front-facing artwork is not reversed");

  const a = record("a"), b = record("b");
  atlas.setSlot(0, a);
  const selectA = atlas.select(a);
  assert.equal(decodes, 1, "slot and selection share one in-flight decode");
  const selectB = atlas.select(b);
  pending.get("cover-b").resolve(); await selectB;
  assert.equal(atlas.selected.material.map.image.token, "cover-b");
  const version = atlas.selected.material.map.version;
  pending.get("cover-a").resolve(); await selectA; await flush();
  assert.equal(atlas.selected.material.map.image.token, "cover-b", "late previous image cannot replace the active cover");
  assert.equal(atlas.selected.material.map.version, version, "late image does not clear or upload the active texture");
  await atlas.select(a);
  assert.equal(atlas.selected.material.map.image.token, "cover-a", "decoded cached artwork is installed synchronously");
  const snapshot = new THREE.Mesh(atlas.selected.geometry, atlas.selected.material);
  atlas.snapshot(snapshot);
  assert.equal(snapshot.material.map.image.token, "cover-a");
  await atlas.select(b);
  assert.equal(snapshot.material.map.image.token, "cover-a", "returning copy owns the old album's pixels");
  atlas.setSlot(1, record("old")); atlas.setSlot(1, record("new"));
  pending.get("cover-new").resolve(); await flush();
  const tile = atlas.array.material.map.image.tiles.get("256,0");
  pending.get("cover-old").resolve(); await flush();
  assert.equal(atlas.array.material.map.image.tiles.get("256,0"), tile, "recycled slots reject stale decoding");
  assert.equal(tile, "cover-new");

  const missingAlbum = { id: "no-original", title: missingMetadata.title, album: { ...missingMetadata } };
  atlas.setSlot(2, missingAlbum);
  await atlas.select(missingAlbum);
  assert.equal(atlas.selected.material.map.image.sources.at(-1), generatedCoverSource(missingMetadata), "normal missing selection uses 800px B directly instead of upscaling its atlas tile");
  assert.equal(atlas.selected.material.map.image.sources.at(-1).width, 800);
  const broken = record("broken");
  atlas.setSlot(3, broken);
  const selectBroken = atlas.select(broken);
  pending.get("cover-broken").reject(new Error("Synthetic missing file")); await selectBroken; await flush();
  assert.equal(atlas.selected.material.map.image.sources.at(-1).width, 800, "failed original decode also resolves to full-resolution B");
  assert.match(atlas.selected.material.map.image.token, /^generated:/);

  const brokenReturning = record("broken-returning");
  atlas.setSlot(4, brokenReturning);
  const selectReturning = atlas.select(brokenReturning);
  const returning = new THREE.Mesh(atlas.selected.geometry, atlas.selected.material);
  const disposedReturning = new THREE.Mesh(atlas.selected.geometry, atlas.selected.material);
  atlas.snapshot(returning);
  atlas.snapshot(disposedReturning);
  disposedReturning.userData.coverDisposed = true;
  const disposedReturningVersion = disposedReturning.material.map.version;
  await atlas.select(b);
  pending.get("cover-broken-returning").reject(new Error("Synthetic failed returning cover"));
  await selectReturning; await flush();
  assert.equal(returning.material.map.image.sources.at(-1), generatedCoverSource({ id: brokenReturning.id, title: brokenReturning.title }),
    "an early snapshot receives its own full 800px B source when the pending original fails after selection leaves");
  assert.equal(atlas.selected.material.map.image.token, "cover-b", "failed returning artwork never replaces the current selection");
  assert.equal(disposedReturning.material.map.version, disposedReturningVersion, "failed original loading cannot revive a disposed returning snapshot");
  for (const item of [returning, disposedReturning]) { item.material.map.dispose(); item.material.dispose(); }

  // The standalone viewer calls the same painter, including missing art.
  const url = new URL("../src/viewer-album-cover.ts", import.meta.url);
  const { outputText } = ts.transpileModule(await fs.readFile(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier === "./cover-atlas" ? "./cover-atlas.ts" : specifier, url).href : import.meta.resolve(specifier))}`);
  const { ViewerAlbumCover } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const viewer = new ViewerAlbumCover(record("viewer").album, 8);
  pending.get("cover-viewer").resolve(); await viewer.ready;
  assert.equal(viewer.mesh.material.map.image.token, "cover-viewer");
  assert.equal(viewer.mesh.userData.coverStatus, "loaded");
  viewer.dispose();
  const missing = new ViewerAlbumCover({ id: "missing", title: "Missing" });
  await missing.ready;
  assert.equal(missing.mesh.userData.coverStatus, "missing");
  assert.match(missing.mesh.material.map.image.token, /^generated:/);
  assert.equal(missing.mesh.material.map.image.sources.at(-1).width, 800);
  missing.dispose();
  const lateViewer = new ViewerAlbumCover(record("late").album);
  lateViewer.dispose(); pending.get("cover-late").resolve(); await lateViewer.ready;
  assert.equal(lateViewer.mesh.userData.coverDisposed, true, "disposing during decode cannot revive a viewer");

  // Cold start: requests are bounded before Image allocation/decode, not merely
  // after completion in the LRU. The expanded shelf keeps one instanced batch.
  const poolSize = LOOP_COLUMNS * MUSIC_LOOP_ROWS;
  const cold = new CoverAtlas(poolSize, 8192, 16);
  const copies = [], allocations = [];
  const renderer = {
    initTexture: texture => allocations.push({ ready: texture.source.dataReady, version: texture.version }),
    copyTextureToTexture: (source, destination, region, position) => copies.push({
      token: source.image.token, position: position.toArray(),
      width: source.image.width, height: source.image.height, region,
    }),
  };
  const versionBefore = cold.array.material.map.version;
  for (let slot = 0; slot < 100; slot++) cold.setSlot(slot, record(`cold-${slot}`));
  assert.deepEqual([cold.getStats().atlasWidth, cold.getStats().atlasHeight, cold.getStats().atlasBytes], [6144, 6656, 156 * 1024 ** 2]);
  assert.equal(cold.getStats().activeDecodes, 3);
  assert.equal(cold.getStats().queuedDecodes, 97);
  assert.equal((await cold.prepareVisible(0)).settled, false, "prewarm has a bounded deadline when sources have not decoded");
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0);
  assert.equal(cold.flushUploads(renderer), 8);
  assert.deepEqual(allocations, [{ ready: false, version: versionBefore }], "initial GPU storage is allocated without uploading the 156 MiB canvas");
  assert.deepEqual(copies[0].position, [0, 6400], "top canvas row maps to the top WebGL tile");
  assert.deepEqual(copies[7].position, [1792, 6400]);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(7), 1);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(8), 0, "unuploaded cells cannot show stale artwork");
  assert.equal(cold.getStats().uploadedBytes, 2 * 1024 ** 2, "one frame uploads at most 2 MiB at the default budget");
  assert.equal(cold.array.material.map.version, versionBefore, "dirty tile painting never requests a whole-atlas upload");
  const selectedCold = cold.select(record("cold-99"));
  pending.get("cover-cold-0").resolve(); await flush();
  assert.ok(pending.has("cover-cold-99"), "selection jumps ahead of the background decode queue");
  pending.get("cover-cold-99").resolve(); await selectedCold;
  assert.equal(cold.selected.material.map.image.token, "cover-cold-99");
  assert.equal(cold.decodedImages.get("cover-cold-99").decodedSize, 1024, "priority selection keeps detailed artwork");
  assert.equal(cold.decodedImages.get("cover-cold-0").decodedSize, 256, "background cache retains thumbnails rather than 1024px sources");
  const resolved = new Set([0, 99]);
  while (cold.getStats().pendingImages) {
    for (let slot = 0; slot < 100; slot++) if (!resolved.has(slot) && pending.has(`cover-cold-${slot}`)) {
      resolved.add(slot); pending.get(`cover-cold-${slot}`).resolve();
    }
    await flush();
  }
  assert.equal(cold.getStats().peakDecodes, 3);
  assert.ok(cold.getStats().cachedBytes <= 16 * 1024 ** 2);
  assert.ok(cold.getStats().cachedImages <= 48);
  while (cold.getStats().dirtyTiles) cold.flushUploads(renderer);
  assert.equal(allocations.length, 1);
  assert.equal(cold.array.material.map.version, versionBefore);
  const last = copies.find(copy => copy.token === "cover-cold-99");
  assert.deepEqual(last.position, [768, 5376], "each asynchronous result reaches its own flipped atlas row");
  assert.equal(cold.flushUploads(renderer), 0, "settled frames upload nothing");
  assert.equal((await cold.prepareVisible()).settled, true);

  cold.setSlot(0, record("recycle"));
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0, "recycled cells hide old GPU art immediately");
  cold.flushUploads(renderer);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 1);
  const pendingBeforeReset = cold.select(record("reset-stale"));
  cold.reset(); await pendingBeforeReset; await flush();
  assert.equal(cold.getStats().dirtyTiles, 0);
  assert.equal(cold.getStats().pendingImages, 0);
  assert.equal(cold.getStats().activeDecodes, 0);
  assert.equal(cold.getStats().cachedBytes, 0);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0);
  cold.setSlot(poolSize - 1, record("after-reset"));
  pending.get("cover-after-reset").resolve(); await flush();
  cold.flushUploads(renderer);
  assert.deepEqual(copies.at(-1).position, [2816, 0], "last occupied tile retains its mapping after reset");
  assert.equal(copies.at(-1).token, "cover-after-reset");
  const pendingAtDisposal = cold.select(record("dispose-active"));
  for (let slot = 0; slot < 8; slot++) cold.setSlot(slot, record(`dispose-queued-${slot}`));
  cold.dispose(); await pendingAtDisposal; await flush();
  assert.equal(cold.getStats().pendingImages, 0);
  assert.equal(cold.getStats().queuedDecodes, 0);
  assert.equal(cold.getStats().activeDecodes, 0);
  assert.equal(cold.flushUploads(renderer), 0, "disposing cancels queue, source decoding and GPU uploads");
  atlas.dispose();
  snapshot.material.map.dispose(); snapshot.material.dispose();
  console.log("V0.4.3 cover pipeline passed: approved B missing/failed covers, direct 800px selection/viewer sources, bounded 24-source generation cache, DOM original/fallback handling, all aspect ratios, shared UV/painter, half-texel guards, 3-source cold-start bound, priority selection, 16 MiB decode cap, 8-tile/2 MiB partial uploads, no stale recycled art, bounded prewarm, reset/dispose races and independent snapshots.");
} finally {
  globalThis.document = previousDocument; globalThis.Image = previousImage;
}
