import * as THREE from "three";

// Reuse the existing Blender shell. Its source bounds are 4.3 × 3.7 × 0.26;
// normalise baked geometry once, keeping the extraction/camera centre unchanged.
export const MUSIC_MODEL = {
  width: 4.45,
  height: 3.35,
  depth: 0.14,
  center: { x: 0, y: 1.85, z: 0 },
} as const;

// The artwork is a surface print in front of every glass vertex (max z=.07).
// Keep its native proportions and a visible glass border on all four sides.
export const MUSIC_COVER = {
  width: 2.98,
  height: 2.98,
  x: 0.14,
  y: MUSIC_MODEL.center.y,
  z: MUSIC_MODEL.depth / 2 + 0.012,
} as const;

export function normalizeMusicGeometry(geometry: THREE.BufferGeometry) {
  if (geometry.userData.musicDimensions) return geometry;
  geometry.translate(0, -MUSIC_MODEL.center.y, 0);
  geometry.scale(MUSIC_MODEL.width / 4.3, MUSIC_MODEL.height / 3.7, MUSIC_MODEL.depth / 0.26);
  geometry.translate(0, MUSIC_MODEL.center.y, 0);
  geometry.userData.musicDimensions = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** All three music contexts share soft frosted glass beneath a sharp surface print. */
export function configureMusicGlass(surface: string, material: THREE.MeshPhysicalMaterial) {
  material.color.set("#fffdfa");
  material.metalness = 0;
  material.envMapIntensity = 0.65;
  material.ior = 1.46;
  material.attenuationColor.set("#f3e9db");
  material.attenuationDistance = 4.5;
  material.clearcoat = 0.16;
  material.clearcoatRoughness = 0.2;
  material.transparent = false;
  material.opacity = 1;
  if (surface === "Frosted_Polymer") {
    material.transmission = 0.96;
    material.thickness = 0.026;
    material.roughness = 0.4;
  } else if (surface === "Ivory_Edges") {
    material.transmission = 0.84;
    material.thickness = 0.06;
    material.roughness = 0.25;
  } else if (surface === "Optical_Diffuser") {
    material.transmission = 0.66;
    material.thickness = 0.035;
    material.roughness = 0.4;
  }
  material.userData.musicShell = true;
}

export function musicAssemblyPart(surface: string) {
  if (surface === "Frosted_Polymer") return "cover";
  if (surface === "Optical_Diffuser") return "substrate";
  return "carrier";
}

/** Clarity applies to the glass substrate only; the cover never enters this path. */
export function setMusicGlassClarity(material: THREE.MeshPhysicalMaterial, clarity: number) {
  // Inspection softens the frosting slightly; it never becomes polished plastic.
  // The image sits ahead of this material and remains completely independent.
  material.roughness = THREE.MathUtils.lerp(0.4, 0.3, THREE.MathUtils.clamp(clarity, 0, 1));
}

export function createAlbumPrintMaterial(map: THREE.Texture) {
  return new THREE.MeshBasicMaterial({
    map,
    alphaTest: 0.025,
    toneMapped: false,
    fog: false,
  });
}
