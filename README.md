# map-designer

Standalone tool for hand-crafting RMRF maps (for the campaign of escalating,
deliberately-designed levels). Kept out of the game so the editor UI never
shows in front of players.

## The map config (what this tool produces)
A map is a config file in three layers:

1. **Base** — the `IslandMap` generator params (`seed`, `cols`, `rows`, `tile`,
   noise knobs). Deterministic terrain from the seed. The generator is NOT
   changing, so a saved seed stays stable.
2. **Overrides** — hand-placed assets from the manifest (asset `id` + grid
   position/rotation), plus any tile edits. Foliage is NOT hand-placed: the
   generator scatters it and skips occupied cells via the existing
   `Foliage.scatter` `avoid` predicate — placed assets feed that test.
3. **Rules** — per-team AI personality / unit mix / resource scarcity (the
   difficulty dial), plus campaign metadata (order, name).

## The contract
- The generator and renderer live in the **game** project (`../riposte-run/`).
  This tool imports them so the editor is WYSIWYG — what you place is exactly
  what the game draws. It does not reimplement map rendering.
- It reads the shared asset palette from `../riposte-run/js/assets.manifest.js`.
- **Dependency is one-way:** this tool imports from `../riposte-run/`; the game
  NEVER imports from here.

## Status
Scaffold only. Folder + contract defined; depends on the asset palette
(`asset-designer`) for the place-able dropdown.
