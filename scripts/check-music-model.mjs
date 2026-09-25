import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MUSIC_MODEL, MUSIC_COVER, normalizeMusicGeometry, configureMusicGlass, createAlbumPrintMaterial } from "../src/music-model.ts";
import { CardAppearance } from "../src/appearance.ts";

const bytes = await fs.readFile(new URL("../public/assets/music-cd.glb", import.meta.url));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
gltf.scene.updateMatrixWorld(true);
const surfaces = [];
const appearance = new CardAppearance();
const appearanceModel = new THREE.Group();
gltf.scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const surface = object.material.name;
  surfaces.push(surface);
  normalizeMusicGeometry(object.geometry);
  const once = [...object.geometry.attributes.position.array];
  normalizeMusicGeometry(object.geometry);
  assert.deepEqual([...object.geometry.attributes.position.array], once, "normalisation must never compound");
  const material = new THREE.MeshPhysicalMaterial();
  configureMusicGlass(surface, material);
  assert.ok(material.transmission >= 0.65, `${surface} remains glass`);
  const [minimum, maximum] = surface === "Ivory_Edges" ? [0.23, 0.28] : [0.38, 0.42];
  assert.ok(material.roughness >= minimum && material.roughness <= maximum, `${surface} retains the reference's soft frosted finish`);
  assert.ok(material.clearcoat <= 0.18, `${surface} avoids a polished plastic coat`);
  appearance.register(surface, material, material.clone());
  const appearanceMesh = new THREE.Mesh(object.geometry, material);
  appearanceMesh.userData.surface = surface;
  appearanceMesh.userData.musicShell = true;
  appearanceModel.add(appearanceMesh);
});
assert.deepEqual(surfaces.sort(), ["Frosted_Polymer", "Ivory_Edges", "Optical_Diffuser"].sort(), "music model contains only shell, frame and backing; no rings or screws");
const bounds = new THREE.Box3().setFromObject(gltf.scene);
const size = bounds.getSize(new THREE.Vector3());
for (const [axis, dimension] of [["x", "width"], ["y", "height"], ["z", "depth"]])
  assert.ok(Math.abs(size[axis] - MUSIC_MODEL[dimension]) < 1e-6, `actual GLB ${dimension} matches the camera dimensions`);
assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).y - MUSIC_MODEL.center.y) < 1e-6);
assert.ok(MUSIC_COVER.z > bounds.max.z + 0.01, "cover is in front of every transmitting surface");
assert.ok(MUSIC_COVER.x - MUSIC_COVER.width / 2 > bounds.min.x);
assert.ok(MUSIC_COVER.x + MUSIC_COVER.width / 2 < bounds.max.x);
assert.ok(MUSIC_COVER.y - MUSIC_COVER.height / 2 > bounds.min.y);
assert.ok(MUSIC_COVER.y + MUSIC_COVER.height / 2 < bounds.max.y);
const print = createAlbumPrintMaterial(new THREE.Texture());
assert.equal(print.isMeshBasicMaterial, true);
assert.equal(print.toneMapped, false);
assert.equal(print.fog, false);
assert.equal(print.transparent, false);
appearance.prepare(appearanceModel);
const printedCover = new THREE.Mesh(new THREE.PlaneGeometry(MUSIC_COVER.width, MUSIC_COVER.height), print);
printedCover.userData.albumCover = true;
appearanceModel.add(printedCover);
const printBefore = JSON.stringify(print.toJSON());
// Exercise the actual main-scene/viewer appearance path. Its final clarity
// update must retain frosting after selection quality and theme changes.
for (const theme of ["day", "night", "dusk"]) {
  appearance.setTheme(theme);
  for (const quality of [0, 0.5, 1]) for (const clarity of [0, 0.5, 1]) {
    appearance.apply(appearanceModel, quality);
    appearance.setClarity(appearanceModel, clarity);
    const glass = appearanceModel.children.find(child => child.userData.surface === "Frosted_Polymer").material;
    assert.ok(glass.roughness >= 0.28 && glass.roughness <= 0.42, "Every rendered cover-glass state retains visible frosting");
    if (clarity === 1) assert.ok(glass.roughness >= 0.28 && glass.roughness <= 0.32, "Final inspection and viewer clear state never revert to polished 0.07 roughness");
    assert.equal(printedCover.material, print, "Appearance never replaces the separate artwork material");
    assert.equal(JSON.stringify(print.toJSON()), printBefore, "Frosting, selection quality and themes do not mutate the artwork material");
  }
}
console.log("Music glass model passed: actual GLB 5 × 3.35 × 0.14, single normalisation, no rings/screws, 0.012 clear-print gap, frosted glass including final inspection, unchanged artwork across appearance states.");
