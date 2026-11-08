// The shared protocol package lives next to the app (../packages), with its own
// node_modules for the @noble crypto libraries.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, "../packages/companion-protocol");
config.watchFolders = [shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.join(shared, "node_modules")];

module.exports = config;
