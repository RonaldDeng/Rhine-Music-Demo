/**
 * Independent music-opening reconstruction from the ordered 001–120 images.
 * These are authored estimates, not a recovered source frame rate or a unique
 * 3D camera solution. Twenty-five samples per second maps that ordering to a
 * 4.76-second edit, followed by 0.44 seconds of live browsing motion.
 * The historical shot clock is retained only as an integration adapter.
 */
export const MUSIC_INTRO_SHOT_START = 21.92;
export const MUSIC_INTRO_SAMPLE_RATE = 25;
export const MUSIC_INTRO_LAST_FRAME = 120;
/** Reconstruction estimate: the same complete motion reaches each next lane
 * four authored samples later. Positive lanes are farther from the -X camera. */
export const MUSIC_INTRO_LANE_DELAY = 4;

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return Math.max(0, Math.min(1, t * t * t * (10 + t * (-15 + 6 * t))));
};
const progress = (frame: number, start: number, end: number) =>
  smooth((frame - start) / (end - start));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const bell = (distance: number, width: number) => Math.exp(-0.5 * (distance / width) ** 2);

/** Continuous, one-based authored sample index; deliberately continues past
 * 120 so delayed lanes can use the same clock without per-lane clipping. */
export function musicIntroFrame(shot: number) {
  return 1 + (shot - MUSIC_INTRO_SHOT_START) * MUSIC_INTRO_SAMPLE_RATE;
}

function localFrame(relativeLane: number, shot: number) {
  return musicIntroFrame(shot) + relativeLane * MUSIC_INTRO_LANE_DELAY;
}

type Key = readonly [frame: number, value: number];
function track(frame: number, keys: readonly Key[]) {
  if (frame <= keys[0][0]) return keys[0][1];
  for (let index = 1; index < keys.length; index++) {
    const [end, value] = keys[index];
    const [start, previous] = keys[index - 1];
    if (frame <= end) return lerp(previous, value, progress(frame, start, end));
  }
  return keys[keys.length - 1][1];
}

export function musicIntroPose(shot: number) {
  const frame = musicIntroFrame(shot);
  return {
    yaw: track(frame, [[1, 89], [44, 85], [80, 59]]),
    elevation: track(frame, [[1, 36], [45, 40], [80, 25]]),
    span: track(frame, [[1, 10.8], [44, 10.3], [80, 7.33]]),
    distance: track(frame, [[1, 38], [44, 42], [88, 140]]),
    aimX: -1.091,
    aimY: track(frame, [[1, -2.55], [44, -1.7], [112, -0.045]]),
    // A physical axial dolly: the shelf no longer needs a Z-entry translation.
    aimZ: track(frame, [[1, 22], [15, 2], [32, 4], [76, 2], [112, 0.481]]),
    // Camera reframing is independent of the delayed per-lane surface blend.
    settle: progress(frame, 76, 112),
    lift: 0.9 * progress(frame, 89, MUSIC_INTRO_LAST_FRAME),
  };
}

/** Each lane shares the full rise/travel/return/settle trajectory. With the
 * nine-lane window (-4…4), the nearest lane joins the live idle field by sample 120. */
export function musicIntroLaneSettle(relativeLane: number, shot: number) {
  return progress(localFrame(relativeLane, shot), 76, 104);
}

function packets(frame: number) {
  return {
    forwardRow: (frame - 24) * 1.2,
    forwardGain: progress(frame, 10, 19) * (1 - progress(frame, 29, 43)),
    returnRow: lerp(31, 0, progress(frame, 44, 84)),
    returnGain: 0.76 * progress(frame, 43, 53) * (1 - progress(frame, 69, 89)),
  };
}

export function musicIntroWave(relativeRow: number, relativeLane: number, shot: number) {
  const frame = localFrame(relativeLane, shot);
  const { forwardRow, forwardGain, returnRow, returnGain } = packets(frame);
  // A broad crest and a modest trailing trough describe a single surface,
  // rather than separately tweened albums. The return packet reverses travel.
  const forward = 2.2 * bell(relativeRow - forwardRow, 5) -
    0.3 * bell(relativeRow - forwardRow + 7, 4.4);
  const returning = 2.2 * bell(relativeRow - returnRow, 5) -
    0.3 * bell(relativeRow - returnRow - 7, 4.4);
  // No global fade: the scene mixes this with its existing resting field using
  // musicIntroLaneSettle, preserving the same temporal shift through handoff.
  return forward * forwardGain + returning * returnGain;
}

/** Row-light travel follows the central lane's crest, then returns to its
 * selected slot. This is an offset in rows, independent of the camera dolly. */
export function musicIntroLightRow(shot: number) {
  const frame = musicIntroFrame(shot);
  const { forwardRow, returnRow } = packets(frame);
  const forward = Math.max(-26, forwardRow);
  const row = lerp(forward, returnRow, progress(frame, 35, 47));
  return row * (1 - progress(frame, 76, 104));
}
