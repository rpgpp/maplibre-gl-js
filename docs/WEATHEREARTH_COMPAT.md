# WeatherEarth compatibility

This branch keeps the WeatherEarth adapter surface on MapLibre 6.15.0.

- `BasicRenderer` and `BasicStyle` provide the explicit tile renderer used by the existing WebGL imagery path. They expose the legacy `sourceCaches`, painter pass state, raster fallback methods, and shader helpers consumed by `WeatherEarth/Source/Maplibre`.
- `BasicGlyphProvider` uses `GlyphManager` and returns the legacy `Record<string, Record<number, ...>>` response as well as the current nested glyph request shape. It is suitable for the native WebGPU symbol path and does not construct `BasicRenderer`.
- `Painter`, `TileManager`, `Tile`, and `GlyphManager` retain the small compatibility methods required by WeatherEarth. They do not change the WebGPU renderer route.

The application should consume this package through an ESM import (or its normal bundler dependency graph). The existing WeatherEarth generated bundle is a separate build artifact and must be refreshed by the application release process after this branch is published.
