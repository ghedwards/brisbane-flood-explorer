# Levee Overtopping Volume Model — Design

## Problem
Current model: when a levee is overtopped, water carries the full river level
behind the levee and floods all connected low land to that level, with no volume
limit. Short overtopping is therefore overstated.

## Goal
Limit the volume of water that passes a levee to a physically defensible
estimate, so protected land fills only to the level the overtopping volume
supports.

## Inputs available
- Levee mask (`s.levee`: cells on the levee crest).
- Terrain DEM (`a.dem`) and water surface (`level`/`wse`).
- Cell size (`a.cell`), grid dimensions.
- Crest height per levee cell (currently burned into DEM; not stored separately).

## Proposed model
1. **Crest height**: store crest elevation per levee cell (currently derived from
   terrain). For each levee cell, crest = DEM after burn (or mapped height).
2. **Overtopping depth**: d_o = max(0, stage - crest) for each levee cell.
3. **Overtopping discharge** (weir equation): q = C_d * (2/3) * sqrt(2g) * L * d_o^(3/2)
   per unit length, where L is the effective levee length (sum of levee cell
   edges exposed to water) and C_d ~ 0.6 (broad-crested weir).
4. **Duration**: in the steady model there is no time. Use a characteristic
   duration T (e.g., 24 h, or the flood's rise time from the scenario) to
   convert to a volume: V = q * T.
5. **Volume budget**: V_budget = sum over levee cells of q_cell * T.
6. **Fill behind levee**: instead of carrying the full river level, fill cells in
   order of increasing ground elevation (lowest first) until the cumulative
   volume (depth * cell area) reaches V_budget. Cells beyond the budget stay
   dry or flood only to their natural (non-carried) level.

## Implementation plan
- Rust: modify `inundate_with` in `rust/flood-core/src/surface.rs`:
  - Compute crest per levee cell, overtopping depth, budget.
  - BFS behind levee sorted by ground elevation; fill until budget exhausted.
- JS: mirror in `viewer/flood-core.js`.
- Add `duration_h` to `Scenario` (default 24) for the time conversion.
- Update tests: levee overtopping test should check that protected area no longer
  fills entirely to river level for short overtopping.

## Validation
- Compare with a simple 1D weir calculation by hand.
- Re-run `tests/core.test.js` levee tests (update expectations).
- Parity: Rust vs JS must match.

## Open questions
- Is 24 h a sensible default duration, or should it tie to the scenario's rise time?
- Should the budget be per-levee (segment) or global? Per-segment is more correct.
- How to handle multiple breaches (sum budgets).

## Status
Not started. Design approved pending review.
