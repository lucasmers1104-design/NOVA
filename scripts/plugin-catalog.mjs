#!/usr/bin/env node
// Adds or updates a plugin in releases/plugins/catalog.json, the list NOVA's Plugins
// page offers ("Available"). NOVA downloads the package from next to the list, checks
// its SHA-256 against it and its signature as with any plugin.
//
//   node scripts/plugin-catalog.mjs <manifest.json> <releases/plugins/file.novaplugin>

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [manifestPath, packagePath] = process.argv.slice(2);
if (!manifestPath || !packagePath) {
  console.error("usage: plugin-catalog.mjs <manifest.json> <releases/plugins/file.novaplugin>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bytes = readFileSync(packagePath);
const catalogPath = join(dirname(resolve(packagePath)), "catalog.json");
const catalog = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, "utf8")) : { plugins: [] };

const entry = {
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author ?? "",
  file: basename(packagePath),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
catalog.plugins = [...catalog.plugins.filter((p) => p.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(`✔ ${entry.id} ${entry.version} in ${catalogPath}`);
