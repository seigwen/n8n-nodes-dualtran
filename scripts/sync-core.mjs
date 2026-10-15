#!/usr/bin/env node
/**
 * sync-core.mjs — vendor @dualtran/core into this host repository (plan 63 D2).
 *
 * Builds src/core in the extension repo, stages a publishable package (the
 * core repo does not ship npm metadata yet — consumers need a resolvable entry
 * point), packs it and drops vendor/dualtran-core.tgz, which package.json
 * references as a file: dependency. Re-run after any core change.
 *
 * CORE_REPO env overrides the default extension path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_REPO = process.env.CORE_REPO || "/root/DualTran-extension";
const VENDOR_DIR = path.join(HOST_ROOT, "vendor");
const STAGE_DIR = path.join(HOST_ROOT, ".core-stage");
const TARGET = path.join(VENDOR_DIR, "dualtran-core.tgz");

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// 1. Build the core bundle in the extension repo.
run("npm", ["run", "build:core"], CORE_REPO);

// 2. Stage a resolvable package.
const corePkg = JSON.parse(
  fs.readFileSync(path.join(CORE_REPO, "package.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")
);
fs.rmSync(STAGE_DIR, { recursive: true, force: true });
fs.mkdirSync(STAGE_DIR, { recursive: true });
for (const f of ["index.mjs", "index.mjs.map"]) {
  fs.copyFileSync(path.join(CORE_REPO, "dist-core", f), path.join(STAGE_DIR, f));
}
for (const f of ["LICENSE", "PROVENANCE.md"]) {
  fs.copyFileSync(path.join(CORE_REPO, f), path.join(STAGE_DIR, f));
}
fs.writeFileSync(
  path.join(STAGE_DIR, "package.json"),
  JSON.stringify(
    {
      name: "dualtran",
      version: corePkg.version || "0.0.0",
      type: "module",
      main: "index.mjs",
      exports: { ".": "./index.mjs" },
      license: "MPL-2.0",
      files: ["index.mjs", "index.mjs.map", "LICENSE", "PROVENANCE.md"],
    },
    null,
    2
  ) + "\n"
);

// 3. Pack and vendor it.
fs.mkdirSync(VENDOR_DIR, { recursive: true });
fs.rmSync(TARGET, { force: true });
run("npm", ["pack", "--pack-destination", VENDOR_DIR], STAGE_DIR);
const packed = fs
  .readdirSync(VENDOR_DIR)
  .filter((f) => f.startsWith("dualtran-") && f.endsWith(".tgz") && f !== "dualtran-core.tgz");
const newest = packed
  .map((f) => ({ f, t: fs.statSync(path.join(VENDOR_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.f;
if (!newest) {
  console.error("[sync-core] npm pack produced no tarball");
  process.exit(1);
}
fs.renameSync(path.join(VENDOR_DIR, newest), TARGET);
fs.rmSync(STAGE_DIR, { recursive: true, force: true });
console.log(`[sync-core] vendored ${newest} -> vendor/dualtran-core.tgz`);
