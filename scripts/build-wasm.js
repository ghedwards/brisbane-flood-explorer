const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "rust/Cargo.toml",
    "-p",
    "flood-wasm",
    "--target",
    "wasm32-unknown-unknown",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
fs.copyFileSync(
  path.join(root, "rust/target/wasm32-unknown-unknown/release/flood_wasm.wasm"),
  path.join(root, "viewer/flood.wasm"),
);
