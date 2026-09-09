// Preserve the original experience as a visual reference while developing music mode.
if (new URLSearchParams(location.search).get("original") === "1") {
  void import("./archive-main");
} else {
  void import("./music-app");
}
