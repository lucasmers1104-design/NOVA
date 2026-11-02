import { describe, expect, it } from "vitest";
import { filterCommands, scoreCommand } from "./search";

const items = [
  { title: "Go to Home", group: "Navigate", keywords: ["dashboard"] },
  { title: "Go to System", group: "Navigate", subtitle: "Live hardware monitoring" },
  { title: "Go to Settings", group: "Navigate" },
  { title: "Collapse sidebar", group: "Layout", keywords: ["navigation", "panel"] },
  { title: "Accent: Emerald", group: "Appearance", keywords: ["color", "theme"] },
];

describe("command search", () => {
  it("returns everything in registry order for an empty query", () => {
    expect(filterCommands(items, "  ")).toEqual(items);
  });

  it("ranks title prefixes above keyword matches", () => {
    expect(filterCommands(items, "set")[0]?.title).toBe("Go to Settings");
    expect(filterCommands(items, "color").map((i) => i.title)).toEqual(["Accent: Emerald"]);
  });

  it("matches word starts inside titles", () => {
    expect(filterCommands(items, "emer")[0]?.title).toBe("Accent: Emerald");
  });

  it("requires every term to match", () => {
    expect(filterCommands(items, "go sys").map((i) => i.title)).toEqual(["Go to System"]);
    expect(filterCommands(items, "go zebra")).toEqual([]);
  });

  it("supports fuzzy subsequences as a last resort", () => {
    expect(scoreCommand(items[3]!, "clsb")).toBeGreaterThan(0);
    expect(scoreCommand(items[3]!, "x")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(items, "HOME")[0]?.title).toBe("Go to Home");
  });
});
