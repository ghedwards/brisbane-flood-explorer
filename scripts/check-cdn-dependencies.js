// CDN assets must use the versions covered by npm audit and Dependabot.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dependencies } = require("../package.json");
const seen = new Set();
for (const file of ["viewer/app.js", "viewer/sw.js"]) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /https:\/\/(?:unpkg\.com\/|cdn\.jsdelivr\.net\/npm\/)([^/@]+)@([^/'"\s]+)/g,
  )) {
    const [, name, version] = match;
    assert.equal(
      version,
      dependencies[name],
      `${file}: ${name}@${version} differs from package.json; update both CDN references and lockfile`,
    );
    seen.add(name);
  }
}
for (const name of Object.keys(dependencies))
  assert.ok(seen.has(name), `${name} has no tracked CDN reference`);
console.log("CDN versions match the audited dependencies.");
