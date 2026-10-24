import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  normalizeQuality,
  qualityPresets,
  matchingPreset,
  renderDimensions,
} from "../src/render-quality.ts";

assert.deepEqual(normalizeQuality(null), qualityPresets.original);
const legacy = normalizeQuality(undefined, false);
assert.equal(legacy.pixelRatio, 1);
assert.equal(legacy.aoSamples, 0);
assert.equal(legacy.depthOfField, 0);
assert.equal(legacy.shadows, 2048, "Migration preserves old low-mode shadows");
assert.equal(legacy.transmission, 1, "Migration preserves old low-mode glass");
for (const bad of [
  null,
  false,
  "ultra",
  [],
  {
    scale: NaN,
    pixelRatio: 99,
    antialias: "injected",
    shadows: -1,
    aoSamples: Infinity,
  },
]) {
  assert.deepEqual(normalizeQuality(bad), qualityPresets.original);
}
assert.equal(normalizeQuality({ scale: 99999 }).scale, 200);
assert.equal(normalizeQuality({ scale: -1 }).scale, 50);
assert.equal(normalizeQuality({ depthOfField: 99999 }).depthOfField, 150);
for (const [name, quality] of Object.entries(qualityPresets)) {
  assert.equal(matchingPreset(normalizeQuality(quality)), name);
  const reloaded = normalizeQuality(JSON.parse(JSON.stringify(quality)));
  assert.deepEqual(reloaded, quality);
}
assert.equal(matchingPreset({ ...qualityPresets.ultra, scale: 145 }), "custom");
for (const width of [640, 1920, 3840, 7680]) {
  for (const dpr of [1, 1.5, 2, 3]) {
    for (const max of [2048, 4096, 16384]) {
      const dimensions = renderDimensions(
        normalizeQuality({ scale: 200, pixelRatio: 3 }),
        1920,
        1080,
        width / 1920,
        dpr,
        max,
      );
      assert.ok(dimensions.width * dimensions.height <= 8_294_400);
      assert.ok(dimensions.width <= max && dimensions.height <= max);
      assert.ok(dimensions.ratio > 0);
    }
  }
}
const native = renderDimensions(
  qualityPresets.original,
  1920,
  1080,
  1,
  1,
  16384,
);
const ultra = renderDimensions(qualityPresets.ultra, 1920, 1080, 1, 1, 16384);
assert.equal(native.width, 1920);
assert.equal(ultra.width, 2880);
assert.equal(
  (ultra.width * ultra.height) / (native.width * native.height),
  2.25,
);
assert.equal(
  renderDimensions(qualityPresets.ultra, 1920, 1080, 2, 2, 16384).limited,
  true,
);
console.log(
  "Quality checks passed: migration, invalid storage, presets, supersampling and 48 device-limit combinations.",
);

// Exercise the actual original-mode settings summary. Removing development
// diagnostics must not turn a real 16× texture setting into a reported 1×.
const archiveSource = await readFile(new URL("../src/archive-main.ts", import.meta.url), "utf8");
const archiveTree = ts.createSourceFile("archive-main.ts", archiveSource, ts.ScriptTarget.Latest, true);
const summaryFunction = archiveTree.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "updateQualitySummary");
assert.ok(summaryFunction);
const summaryCode = ts.transpileModule(summaryFunction.getText(archiveTree), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function summaryFixture({ quality = qualityPresets.original, maximumAnisotropy = 16,
  maximumTextureSize = 16384, scale = 1, dpr = 1 } = {}) {
  const summary = { textContent: "" };
  const host = { clientWidth: 1920, clientHeight: 1080,
    getBoundingClientRect: () => ({ width: 1920 * scale }),
    get dataset() { throw new Error("Settings must not depend on retired DOM diagnostics"); } };
  const canvas = { width: 1920, height: 1080, parentElement: host };
  const scene = { renderer: { domElement: canvas, capabilities: {
    maxTextureSize: maximumTextureSize, getMaxAnisotropy: () => maximumAnisotropy,
  } } };
  const prefs = { rendering: { ...quality } };
  const document = { querySelector: () => summary };
  const update = new Function("document", "scene", "prefs", "renderDimensions", "devicePixelRatio",
    `${summaryCode}\nreturn updateQualitySummary;`)(document, scene, prefs, renderDimensions, dpr);
  update();
  return { summary, prefs, update };
}
const originalSummary = summaryFixture();
assert.equal(originalSummary.summary.textContent, "实际渲染 1920 × 1080 · 原始抗锯齿 · 纹理 16×");
originalSummary.prefs.rendering.anisotropy = 2;
originalSummary.update();
assert.match(originalSummary.summary.textContent, /纹理 2×$/u, "Changing a preference immediately updates the displayed filtering");
assert.match(summaryFixture({ maximumAnisotropy: 4 }).summary.textContent, /纹理 4×$/u,
  "The user-facing summary respects the device's actual texture filtering limit");
assert.match(summaryFixture({ quality: qualityPresets.ultra, scale: 2, dpr: 2 }).summary.textContent,
  /SMAA · 纹理 16× · 已达到缓冲上限$/u, "The pixel budget limit remains visible without diagnostic attributes");
assert.match(summaryFixture({ maximumTextureSize: 1024 }).summary.textContent, /已达到缓冲上限$/u,
  "The hardware texture size limit also remains visible");
console.log("Original quality summary passed: actual canvas size, selected/device-limited texture filtering, pixel and hardware limits, no DOM diagnostics.");
