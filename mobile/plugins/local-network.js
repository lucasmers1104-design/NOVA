// The phone talks to the PC over ws:// inside the home network. Android blocks
// plain-text connections in release builds unless the app allows them. That is fine
// here: every message is end-to-end encrypted before it reaches the socket.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLocalNetwork(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
};
