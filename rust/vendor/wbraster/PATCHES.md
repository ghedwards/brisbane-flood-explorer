# Raster dependency security patch

Source: https://github.com/opengeos/whitebox-wasm/tree/f0076c2383ebd9248454b32f13cd002fa27f21b0/crates/wbraster

This crate is vendored to use zip 9 and ruzstd 0.9.1. Upstream still requires vulnerable zip 8 and ruzstd 0.8. Sibling Whitebox crates remain pinned to the same upstream Git revision. The manifest also removes the reference to an absent README. Source code is retained unchanged unless API adaptations are listed below.

Keep the upstream MIT/Apache licensing files with this copy. Remove this patch once upstream supports fixed archive releases, then rerun the six-raster hydrology comparison.
