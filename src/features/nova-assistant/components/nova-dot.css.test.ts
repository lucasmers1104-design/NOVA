/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: the test run leaves stylesheets out (`css: false`), also as `?raw`.
const sheet = (file: string) => readFileSync(resolve(process.cwd(), "src/features/nova-assistant", file), "utf8");
const orbCss = sheet("orb.css");
const dotCss = sheet("components/nova-dot.css");

/** The selectors of every rule that sets `property` to `value`, without comments. */
function rulesSetting(css: string, property: string, value: string): string[] {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  return [...rules].filter(([, , body]) => new RegExp(`(^|;|\\s)${property}:\\s*${value}\\s*(;|$)`).test(body ?? "")).map(([, selector]) => (selector ?? "").trim());
}

describe("the dot's body with the orb style", () => {
  // In the orb style the body carries both `.nova-dot__body` and `.nova-orb`. One says
  // "absolute, fill the dot", the other "relative". With equal weight, whichever
  // stylesheet a window loaded last won: fine in the dot's own window, a flat sliver
  // in NOVA's main window (Settings → Der NOVA-Punkt, the style card "Orb").
  it("fills the dot whichever stylesheet loads last", () => {
    expect(rulesSetting(orbCss, "position", "relative")).toContain(".nova-orb");
    const fills = rulesSetting(dotCss, "position", "absolute").filter((selector) => selector.includes(".nova-dot__body"));
    expect(fills).toEqual([".nova-dot > .nova-dot__body"]);
    // Two classes outweigh the orb's one, so the order of the files no longer matters.
    expect(fills[0]!.match(/\.[\w-]+/g)).toHaveLength(2);
  });
});
