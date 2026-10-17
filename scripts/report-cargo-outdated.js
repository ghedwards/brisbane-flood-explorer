// cargo-outdated copies workspace members to a temporary directory but omits
// excluded path patches. Use a temporary manifest with an absolute patch path.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flood-outdated-"));
try {
  fs.cpSync(path.join(root, "rust"), temp, {
    recursive: true,
    filter: (source) => !["target", "vendor"].includes(path.basename(source)),
  });
  const manifest = path.join(temp, "Cargo.toml");
  const vendor = path.join(root, "rust/vendor/wbraster").replaceAll("\\", "/");
  fs.writeFileSync(
    manifest,
    fs
      .readFileSync(manifest, "utf8")
      .replace('path = "vendor/wbraster"', `path = ${JSON.stringify(vendor)}`),
  );
  const result = spawnSync(
    "cargo",
    [
      "outdated",
      "--manifest-path",
      manifest,
      "--workspace",
      "--exit-code",
      "0",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  fs.writeFileSync(
    "cargo-outdated.txt",
    (result.stdout || "") + (result.stderr || ""),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Cargo outdated\n\n\`\`\`text\n${result.stdout}\`\`\`\n`,
    );
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
