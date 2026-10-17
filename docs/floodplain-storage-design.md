# Floodplain Storage in Routing — Design

## Problem
Below the gauge, floods are routed (Muskingum-Cunge) with tributary inflows,
measured ratings, tides. Tributary floods copy the gauge's shape and places
above the gauge without a recorded gauge are only time-shifted. Floodplain
storage (water spreading onto the floodplain and delaying/attenuating the
peak) is not modelled, so peaks are over-attenuated? Actually currently
storage is ignored, so peaks are under-attenuated (too sharp).

## Goal
Add a storage term to each reach so the peak is attenuated and delayed in
proportion to the floodplain area and depth, improving downstream hydrographs.

## Proposed model
Muskingum-Cunge with storage coefficient K adjusted by floodplain area:
- For each reach, estimate floodplain width from the terrain (cells within
  e.g. 2 m of the channel, excluding the channel itself).
- Storage volume S = A_fp * h (floodplain area * average depth).
- Modified Muskingum: O_{t+1} = C0*I_{t+1} + C1*I_t + C2*O_t, with
  C0,C1,C2 derived from K = (L / (c * (1 + (A_fp/A_chan)))) and X = 0.2.
- Tributary inflows: instead of copying the gauge's shape, scale by
  catchment-area ratio and shift by difference in time of concentration
  (already done), then route through the tributary's own floodplain.

## Implementation plan
- Rust: `route_down` in `rust/flood-core/src/wave.rs`: compute floodplain
  area per reach from `a` (grid), adjust K.
- JS: mirror in `viewer/flood-core.js` (wave setup).
- Add `floodplainWidth` to Analysis? Or compute on the fly.
- Update `tests/core.test.js` routing test (peak arrives later/lower).

## Validation
- Compare attenuated peak to a simple Muskingum hand calc.
- Parity Rust/JS.

## Status
Not started. Design pending review.
