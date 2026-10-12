const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, "../..");
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(root, "node_modules"),
];
// Also watch the real target when a local investigation reuses dependencies
// through a symlink. Normal standalone installs do not need this extra folder.
const rootModules = path.resolve(root, "node_modules");
if (fs.existsSync(rootModules)) {
  const resolved = fs.realpathSync(rootModules);
  if (resolved !== rootModules) config.watchFolders.push(resolved);
}
module.exports = config;
