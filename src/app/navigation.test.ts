import { describe, expect, it } from "vitest";
import { migrateNavigation, NAV_ITEMS, resolveSidebar, WORKSPACE_ORDERABLE_ROUTES } from "./navigation";
import { ROUTES } from "./routes";

describe("navigation registry", () => {
  it("has unique route ids", () => {
    const ids = NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no dead links: every nav item resolves to a page component", () => {
    for (const item of NAV_ITEMS) {
      // Lazy pages are exotic component objects; wrappers are plain functions.
      expect(["function", "object"], item.id).toContain(typeof ROUTES[item.id]);
      expect(ROUTES[item.id], item.id).toBeTruthy();
    }
  });

  it("covers every section required by the product spec", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Home",
      "System",
      "Apps",
      "NOVA AI",
      "Productivity",
      "Routines",
      "NOVA Island",
      "Discord",
      "Live Information",
      "Media",
      "Files",
      "Widget Studio",
      "Plugins",
      "Settings",
    ]);
  });

  it("applies the user's sidebar order and visibility", () => {
    const groups = resolveSidebar(["media", "system", "apps", "ai", "productivity", "routines", "files", "live"], ["apps", "studio", "plugins"]);
    expect(groups.workspace.map((i) => i.id)).toEqual(["home", "media", "system", "ai", "productivity", "routines", "files", "live", "island", "discord"]);
    expect(groups.customize).toEqual([]);
    expect(groups.footer.map((i) => i.id)).toEqual(["settings"]);
  });

  it("puts Island and Discord where Media and Files were, and hides those two", () => {
    const next = migrateNavigation(["files", "system", "media", "apps"], ["plugins"]);
    expect(next.order.slice(0, 4)).toEqual(["discord", "system", "island", "apps"]);
    expect(next.order).toHaveLength(WORKSPACE_ORDERABLE_ROUTES.length);
    expect(new Set(next.order).size).toBe(next.order.length);
    expect(next.hidden).toEqual(["plugins", "media", "files"]);
    // Running it twice changes nothing more.
    expect(migrateNavigation(next.order, next.hidden).hidden).toEqual(next.hidden);
  });

  it("never hides or moves Home and Settings", () => {
    const groups = resolveSidebar([...WORKSPACE_ORDERABLE_ROUTES].reverse(), ["home", "settings"]);
    expect(groups.workspace[0]?.id).toBe("home");
    expect(groups.footer.map((i) => i.id)).toEqual(["settings"]);
  });

});
