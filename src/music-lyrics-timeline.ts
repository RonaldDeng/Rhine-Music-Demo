/** A lyric cue uses seconds on the recording's media clock. */
export interface TimelineLyricLine {
  time: number;
  text: string;
}

export interface LyricTimelineGroup {
  /** Inclusive indices, so translations at the same timestamp remain together. */
  start: number;
  end: number;
  time: number;
}

const timestampTag = /\[(\d{1,4}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
const wordTimestampTag = /<\d{1,4}:[0-5]?\d(?:[.:]\d{1,3})?>/g;

/** Parse LRC without interpreting its text as HTML or changing the media clock. */
export function parseTimelineLrc(input: string): TimelineLyricLine[] {
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const offsetTags = [...source.matchAll(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/gim)];
  const offset = Number(offsetTags.at(-1)?.[1] ?? 0) / 1000;
  const lines: TimelineLyricLine[] = [];
  for (const line of source.split("\n")) {
    const tags = [...line.matchAll(timestampTag)];
    if (!tags.length) continue;
    const text = line.replace(timestampTag, "").replace(wordTimestampTag, "").trim();
    for (const tag of tags) {
      const seconds = Number(tag[1]) * 60 + Number(tag[2]) + Number(`0.${tag[3] ?? "0"}`);
      // A positive LRC offset advances the lyrics, matching the local service.
      const time = Math.max(0, Math.round((seconds - offset) * 1000) / 1000);
      if (Number.isFinite(time)) lines.push({ time, text });
    }
  }
  // Stable sorting retains the source order of original/translated cue pairs.
  lines.sort((left, right) => left.time - right.time);
  const seen = new Set<string>();
  return lines.filter(({ time, text }) => {
    const key = JSON.stringify([time, text]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Find the active group in a chronological timeline, including blank clear cues. */
export function lyricGroupAt(
  lines: readonly { time: number | null }[],
  seconds: number,
): LyricTimelineGroup | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  let group: LyricTimelineGroup | null = null;
  for (let index = 0; index < lines.length; index++) {
    const time = lines[index].time;
    if (time === null || !Number.isFinite(time) || time < 0) continue;
    if (time > seconds) break;
    if (group !== null && group.time === time) group.end = index;
    else group = { start: index, end: index, time };
  }
  return group;
}
