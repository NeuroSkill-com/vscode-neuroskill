#!/usr/bin/env node
/**
 * Generate `.marketplace.readme.md` with all relative `media/...` paths
 * rewritten to absolute GitHub URLs.
 *
 * Source `README.md` keeps relative paths so it renders correctly on
 * GitHub and against the bundled images in the installed extension.
 * The generated file is what `vsce package --readme-path` ships, because
 * the Marketplace web view can't read images out of the .vsix.
 *
 * vsce auto-rewrites <img src="…">, but it ignores <source srcset="…">
 * inside <picture> elements, so we do the full rewrite ourselves and
 * pass --baseImagesUrl '' to make vsce a no-op on URLs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");

const pkg = JSON.parse(readFileSync(`${extRoot}/package.json`, "utf-8"));
const repo = pkg.repository?.url?.replace(/\.git$/, "") ?? "";
if (!repo) {
  console.error("package.json `repository.url` is required to build the marketplace README");
  process.exit(1);
}
const baseUrl = `${repo}/raw/main/`;

const src = readFileSync(`${extRoot}/README.md`, "utf-8");

// Rewrite both <img src="media/…"> and <source srcset="media/…">.
// Markdown image syntax ![alt](media/…) is rare here but supported too.
const rewritten = src
  .replace(/(\bsrc=")(media\/)/g, `$1${baseUrl}$2`)
  .replace(/(\bsrcset=")(media\/)/g, `$1${baseUrl}$2`)
  .replace(/(!\[[^\]]*\]\()(media\/)/g, `$1${baseUrl}$2`);

const outPath = `${extRoot}/.marketplace.readme.md`;
writeFileSync(outPath, rewritten);
console.log(`wrote ${outPath} (${rewritten.length} bytes; base ${baseUrl})`);
