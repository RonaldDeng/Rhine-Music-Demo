import { musicIntroLightRow } from "./music-intro-motion.ts";
import { MUSIC_COLUMN_SPACING } from "./music-model.ts";

/** V0.3.1: a world-space shelf ribbon. Width is its full width at half maximum,
 * measured in archive rows, not screen pixels or the height of a CD case. */
export type RowLightingMode = "baseline" | "area" | "guided" | "hybrid";
export type RowLightingSettings = {
  mode: RowLightingMode;
  strength: number;
  dayGain: number;
  width: number;
  offset: number;
  fill: number;
  transitionDuration: number;
};

/** Absolute shelf coordinates include the scene's accumulated rebase origin. */
export type RowLightingFrame = {
  row: number;
  lane: number;
  introTime?: number;
  /** Real shelves each have their own displayed vertical origin. */
  independentColumns?: boolean;
};

export type RowLightMotion = { value: number; velocity: number };

/** A soft start and finish in shelf coordinates. The duration is the time to
 * travel 95% from rest, matching the archive's critically damped rail. Keep
 * useful forward momentum on repeated input, but never carry it past a target
 * or in the opposite direction after a reversal. */
export function followRowLight(state: RowLightMotion, target: number, dt: number, duration: number) {
  const previous = state.value;
  const distance = target - previous;
  if (!distance) { state.velocity = 0; return previous; }
  const rate = 4.743864518390578 / duration; // (1 + x) * exp(-x) = 0.05
  const direction = Math.sign(distance);
  // This envelope gives the analytical spring a monotone, asymptotic finish,
  // even if a nearer target or slower duration arrives while it is moving.
  const speed = Math.min(Math.max(0, state.velocity * direction), rate * Math.abs(distance));
  const velocity = speed * direction;
  const elapsed = Math.max(0, dt);
  const impulse = velocity - rate * distance;
  const decay = Math.exp(-rate * elapsed);
  const next = target + (-distance + impulse * elapsed) * decay;
  state.value = Math.min(Math.max(next, Math.min(previous, target)), Math.max(previous, target));
  state.velocity = state.value === target || state.value !== next ? 0 :
    (velocity - rate * impulse * elapsed) * decay;
  return state.value;
}

/** The opening scan shares the new edit's clock. It remains a common scanning
 * ribbon across columns; column height waves have their own delayed clocks. */
export const introRowOffset = musicIntroLightRow;

export const ROW_LIGHTING = {
  rowSpacing: 0.62,
  laneSpacing: MUSIC_COLUMN_SPACING,
  laneRadius: 27,
  gaussianHalfMaximum: Math.LN2,
  modes: { baseline: 0, area: 1, guided: 2, hybrid: 3 },
} as const;

export const DEFAULT_ROW_LIGHTING: Readonly<RowLightingSettings> = {
  mode: "baseline", strength: 1, dayGain: 11, width: 1, offset: 0, fill: 1, transitionDuration: 1.2,
};

/** User-approved V0.3.1 preset, shared by first use and the reset control.
 * Keep the unconfigured controller above neutral for the original comparison. */
export const DEFAULT_LIGHTING_PRESET: Readonly<RowLightingSettings> = {
  mode: "guided", strength: 1.3, dayGain: 11, width: 1.35, offset: 0.3, fill: 1, transitionDuration: 1.1,
};

export function normalizeRowLighting(
  value: Partial<RowLightingSettings>,
  previous: RowLightingSettings = DEFAULT_ROW_LIGHTING,
): RowLightingSettings {
  const number = (next: number | undefined, fallback: number, min: number, max: number) =>
    Number.isFinite(next) ? Math.min(max, Math.max(min, next!)) : fallback;
  return {
    mode: value.mode && Object.hasOwn(ROW_LIGHTING.modes, value.mode) ? value.mode : previous.mode,
    strength: number(value.strength, previous.strength, 0, 2),
    dayGain: number(value.dayGain, previous.dayGain ?? 11, 0, 20),
    width: number(value.width, previous.width, 0.6, 2.5),
    offset: number(value.offset, previous.offset, -6, 6),
    fill: number(value.fill, previous.fill, 0, 1),
    transitionDuration: number(value.transitionDuration, previous.transitionDuration, 0.4, 2.4),
  };
}

/** CPU counterpart of the shader's field, for quantitative controls/checks. */
export function sampleRowLighting(dx: number, dz: number, settings: RowLightingSettings) {
  const row = (dz - settings.offset * ROW_LIGHTING.rowSpacing) /
    (0.5 * settings.width * ROW_LIGHTING.rowSpacing);
  const lane = dx / ROW_LIGHTING.laneRadius;
  return Math.exp(-ROW_LIGHTING.gaussianHalfMaximum * row * row) *
    Math.exp(-Math.pow(lane, 6));
}

/** The same expression is used by prints and shells. Instance ownership, the
 * album's y elevation, local vertex position and camera do not affect the row. */
export const ROW_LIGHTING_GLSL = `
  uniform vec3 musicRowColumn;
  uniform vec4 musicRowSettings;
  uniform float musicRowDetail;
  uniform float musicRowFill;
  float musicRowField(vec3 origin, vec3 column) {
    float row = (origin.z - column.z - musicRowSettings.w * ${ROW_LIGHTING.rowSpacing}) /
      (0.5 * musicRowSettings.z * ${ROW_LIGHTING.rowSpacing});
    float lane = (origin.x - column.x) / ${ROW_LIGHTING.laneRadius.toFixed(1)};
    float lane2 = lane * lane;
    return exp(-${ROW_LIGHTING.gaussianHalfMaximum} * row * row) *
      exp(-lane2 * lane2 * lane2);
  }
`;
