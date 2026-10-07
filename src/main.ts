// Keep the browser's image/canvas export menu out of the application surface.
// This only suppresses UI shortcuts; it cannot prevent system screenshots.
document.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});
document.addEventListener("dragstart", (event) => {
  if (event.target instanceof Element && event.target.closest("img, canvas")) {
    event.preventDefault();
  }
}, { capture: true });

// Preserve the original experience as a visual reference while developing music mode.
if (new URLSearchParams(location.search).get("original") === "1") {
  void import("./archive-main");
} else {
  void import("./music-app");
}
