/** Read-only local lyrics service. All timestamps are seconds on the audio clock. */
export interface MusicLyricLine {
  time: number | null;
  text: string;
}

export interface MusicLyricsResult {
  trackId: string;
  status: "synced" | "plain" | "instrumental" | "not-found" | "error";
  lines: MusicLyricLine[];
  source?: {
    name: string;
    kind: "sidecar" | "embedded" | "online";
    url?: string;
  };
  message?: string;
}
