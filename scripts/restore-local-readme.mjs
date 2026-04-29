#!/usr/bin/env node
/**
 * Replace the rewritten `extension/readme.md` inside the packaged .vsix with
 * the original `README.md`, so the locally-installed extension shows images
 * loaded from the bundled `media/` folder instead of GitHub URLs (which 404
 * before the repo is published).
 *
 * vsce rewrites `<img src="media/…">` to absolute GitHub URLs unconditionally
 * and ignores `--baseImagesUrl ''`, so we patch the .vsix after the fact.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");

const pkg = JSON.parse(readFileSync(`${extRoot}/package.json`, "utf-8"));
const vsix = `${extRoot}/${pkg.name}-${pkg.version}.vsix`;
if (!existsSync(vsix)) {
  console.error(`vsix not found: ${vsix}`);
  process.exit(1);
}

// Replace extension/readme.md inside the .vsix with the original README.md.
// We use python3's zipfile (instead of macOS `zip`) so we don't introduce the
// Unix UT/ux extra fields that OpenVSX rejects with
// "Extension contains zip entries with unsupported extra fields".
const py = `
import os, shutil, sys, zipfile
vsix, src = sys.argv[1], sys.argv[2]
tmp = vsix + ".tmp"
with zipfile.ZipFile(vsix, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = open(src, "rb").read() if item.filename == "extension/readme.md" else zin.read(item.filename)
        info = zipfile.ZipInfo(filename=item.filename, date_time=item.date_time)
        info.compress_type = item.compress_type
        info.external_attr = item.external_attr
        info.create_system = item.create_system
        zout.writestr(info, data)
os.replace(tmp, vsix)
`;
execFileSync("python3", ["-c", py, vsix, `${extRoot}/README.md`], { stdio: "inherit" });
console.log(`patched ${vsix}: replaced extension/readme.md with original README.md (relative media/ paths)`);
