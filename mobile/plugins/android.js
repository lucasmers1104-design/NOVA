// Android build settings the app needs, applied during `expo prebuild` (EAS runs it).
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod, withGradleProperties } = require("expo/config-plugins");

// One CPU architecture: arm64 covers practically every phone from the last years
// and keeps the APK small enough for GitHub (all four made it 122 MB).
function withArm64Only(config) {
  return withGradleProperties(config, (mod) => {
    mod.modResults = mod.modResults.filter((item) => !(item.type === "property" && item.key === "reactNativeArchitectures"));
    mod.modResults.push({ type: "property", key: "reactNativeArchitectures", value: "arm64-v8a" });
    return mod;
  });
}

// The phone talks to the PC over ws:// inside the home network. Android blocks
// plain-text connections in release builds unless the app allows them. That is fine
// here: every message is end-to-end encrypted before it reaches the socket.
function withLocalNetwork(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
}

// Release builds shrink the code with R8. Room creates its databases by reflection,
// so R8 dropped WorkManager's WorkDatabase_Impl constructor and the app crashed at
// start (expo-background-task uses WorkManager). Keep Room's generated databases.
const KEEP_ROOM = `
# NOVA Companion: Room databases are created by reflection (WorkManager, expo-background-task).
-keep class * extends androidx.room.RoomDatabase { <init>(...); }
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
`;

function withRoomKept(config) {
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const file = path.join(mod.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!current.includes("NOVA Companion: Room")) fs.writeFileSync(file, current + KEEP_ROOM);
      return mod;
    },
  ]);
}

module.exports = (config) => withArm64Only(withRoomKept(withLocalNetwork(config)));
