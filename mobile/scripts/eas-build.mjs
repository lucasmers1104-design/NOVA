#!/usr/bin/env node
// Builds the APK in Expo's cloud (EAS) from this folder alone.
//
//   npm run build:apk
//
// The app shares @nova/companion-protocol with the PC (../packages). EAS only gets this folder,
// so the package's sources are copied to vendor/ for the upload (metro.config.js uses that copy
// when ../packages isn't there) and removed again afterwards. The whole repository can't be the
// upload root: eas-cli's ignore rules miss nested node_modules on Windows.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(app, "../packages/companion-protocol");
const vendor = join(app, "vendor", "companion-protocol");

rmSync(join(app, "vendor"), { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
cpSync(join(shared, "package.json"), join(vendor, "package.json"));
cpSync(join(shared, "src"), join(vendor, "src"), { recursive: true, filter: (file) => !/\.test\.ts$/.test(file) });

try {
  const args = ["--yes", "eas-cli", "build", "-p", "android", "--profile", "preview", "--non-interactive", "--no-wait", ...process.argv.slice(2)];
  const result = spawnSync("npx", args, {
    cwd: app,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EAS_NO_VCS: "1", EAS_PROJECT_ROOT: app, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-system-ca"].filter(Boolean).join(" ") },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(join(app, "vendor"), { recursive: true, force: true });
}
