import { describe, expect, it } from "vitest";
import changelog from "../../../CHANGELOG.md?raw";
import { compareVersions, parseChangelog, sectionsSince } from "./WhatsNew";

const TEXT = `# Changelog

## Unreleased

### Fixed
- Not out yet.

## 1.10.0 — 2026-12-01

### Added
- **Big**: new.

## 1.9.0 — 2026-11-06

### Fixed
- Older.

## 1.8.0 — 2026-11-05
- Oldest.
`;

describe("what's new", () => {
  it("reads released versions and leaves out what isn't released", () => {
    const sections = parseChangelog(TEXT);
    expect(sections.map((s) => s.version)).toEqual(["1.10.0", "1.9.0", "1.8.0"]);
    expect(sections[0]).toEqual({ version: "1.10.0", date: "2026-12-01", body: "### Added\n- **Big**: new." });
  });

  it("compares versions as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.9.0")).toBe(0);
    expect(compareVersions("1.8.9", "1.9")).toBeLessThan(0);
  });

  it("shows only what is new since the last version", () => {
    expect(sectionsSince(TEXT, "1.9.0", "1.10.0").map((s) => s.version)).toEqual(["1.10.0"]);
    // Skipped a version: both.
    expect(sectionsSince(TEXT, "1.8.0", "1.10.0").map((s) => s.version)).toEqual(["1.10.0", "1.9.0"]);
    // Nothing from the future, and nothing after going back.
    expect(sectionsSince(TEXT, "1.8.0", "1.9.0").map((s) => s.version)).toEqual(["1.9.0"]);
    expect(sectionsSince(TEXT, "1.10.0", "1.9.0")).toEqual([]);
  });

  it("knows the version being released", () => {
    expect(parseChangelog(changelog)[0]?.version).toBe(__NOVA_VERSION__);
  });
});
