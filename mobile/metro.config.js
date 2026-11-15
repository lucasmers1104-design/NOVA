// The shared protocol package lives next to the app (../packages), with its own
// node_modules for the @noble crypto libraries. A cloud build only gets this folder:
// scripts/eas-build.mjs puts a copy of the package's sources into vendor/ for it.
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const PACKAGE = "@nova/companion-protocol";
const ENTRIES = { "": "index", "/crypto": "crypto", "/client": "client", "/state": "state", "/app": "app" };

const config = getDefaultConfig(__dirname);
const sibling = path.resolve(__dirname, "../packages/companion-protocol");
const vendored = process.env.NOVA_VENDORED_PROTOCOL === "1" || !fs.existsSync(sibling);
const shared = vendored ? path.resolve(__dirname, "vendor/companion-protocol") : sibling;

if (vendored) {
  // The node_modules link points at ../packages, which isn't there: resolve the package to the copy.
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, name, platform) => {
    if (name === PACKAGE || name.startsWith(`${PACKAGE}/`)) {
      const entry = ENTRIES[name.slice(PACKAGE.length)];
      if (entry) return { type: "sourceFile", filePath: path.join(shared, "src", `${entry}.ts`) };
    }
    return (upstream ?? context.resolveRequest)(context, name, platform);
  };
} else {
  config.watchFolders = [shared];
}
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.join(shared, "node_modules")];

module.exports = config;
