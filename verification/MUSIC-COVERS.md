# Music cover integration

Validated 2026-09-09 in the local Codex browser, 1280 × 720.

- `setMusicAlbums(albums, genres)` replaces the display index. `scene.refreshLibrary(index)` rebuilds card ownership after a membership, genre-layout, or artwork change. Metadata-only UI updates do not need to reset the scene.
- The visible pool remains 9 × 32 instances. Each slot has independent atlas UVs and resolves its album from the logical lane/row. Dynamic category counts and album counts do not change draw-call count.
- The GLB front polymer cover reaches z = 0.206; existing ink/internal detail reaches z = 0.2464. Artwork is at z = 0.255 within a 4.2 × 3.15 display box centered at y = 1.85. This preserves the original outer case, fasteners, rings and motion.
- The atlas has 288 tiles of 256 × 192 (4096 × 3456 total on supported hardware). Selected cards use a separate 1024 × 768 canvas. Every image uses contain fitting with transparent margins; source proportions are retained. Missing art has an explicit placeholder.
- Returning copies own independent artwork snapshots and finish loading the original selected album even during rapid navigation. Their texture/material resources are disposed after returning. Decoded image cache is bounded to 48 items, with a longest edge of 1024 pixels.
- Theme switching updates scene background, fog, floor, lights and actual case materials. Night adds a sparse procedural star field and white/cool frosted polymer. Album images are shared across themes. No GLB art, geometry or animation timeline was replaced.

## Checks

`node --experimental-strip-types scripts/check-music-scene.mjs` passes 1 / 2 / 7 categories × 1 / 3 / 40 albums, both directions across boundaries, negative/unbounded coordinates, unique pool cells, slot round trips, empty libraries, and square/portrait/landscape contain geometry.

`reference/music-cover-review.html` is an isolated fixture page, not user library data. Visual checks confirmed all four marked corners remain visible for 1:1, 3:5 and 50:21 covers, with circular markers retaining their proportions. The array, selected cover and returning copies use matching album art. Day and night were inspected after extraction. Existing internal structure remains behind the artwork and visible in uncovered areas; the old research label alone is hidden in music mode.

No browser error was observed. The existing `PCFSoftShadowMap` deprecation warning remains. At the tested viewport, settled frames sampled around 16.7 ms, with 103 draw calls by day / 105 at night and approximately 5.33 million triangles. This is a local fixture observation, not a cross-device performance guarantee; the integrated UI and actual library need their own check.
