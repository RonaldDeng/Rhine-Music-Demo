/** V0.4.1's warm daylight palette, with the newer stable exposure/fog path. */
export const MUSIC_DAYLIGHT = {
  background: "#eae5e1",
  floor: "#d8c9b9",
  key: "#fff7ed",
  sky: "#fffaf5",
  ground: "#b4a18c",
} as const;

/** Keep fog behind the displayed case, including the inspection transition.
 * The distance comes from the rendered camera, never its damped destination.
 * Day keeps a stable depth interval while the case is extracted: contracting
 * white fog across the shelf would brighten the same background that the
 * glass is sampling. The reading veil handles the detail page's separation.
 * Night/dusk retain their original detail curve, including theme interpolation.
 */
export function musicFogDistances(distance: number, detail: number, daylight: number) {
  const t = Math.min(1, Math.max(0, detail));
  const day = Math.min(1, Math.max(0, daylight));
  const near = 5 - 6 * t;
  const far = 25 - 13 * t;
  return {
    near: distance + near + day * (10 - near),
    far: distance + far + day * (40 - far),
  };
}
