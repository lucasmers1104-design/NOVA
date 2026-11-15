import { describe, expect, it } from "vitest";
import { openingView, rememberRoute } from "./opening";

describe("where the main window opens", () => {
  it("opens Home on a fresh start, whatever page was open last time", () => {
    rememberRoute("media");
    expect(openingView(undefined)).toEqual({ route: "home", settingsSection: null });
    expect(openingView({})).toEqual({ route: "home", settingsSection: null });
  });

  it("comes back from the tray where it was", () => {
    expect(openingView({ reopened: true, route: null, section: null })).toEqual({ route: "home", settingsSection: null });
    rememberRoute("productivity");
    expect(openingView({ reopened: true, route: null, section: null })).toEqual({ route: "productivity", settingsSection: null });
  });

  it("opens where it is asked to, before where it was", () => {
    rememberRoute("media");
    expect(openingView({ reopened: true, route: "settings", section: "assistant" })).toEqual({ route: "settings", settingsSection: "assistant" });
    expect(openingView({ reopened: true, route: "routines", section: "" })).toEqual({ route: "routines", settingsSection: null });
    // A section means something in Settings only.
    expect(openingView({ reopened: true, route: "media", section: "assistant" })).toEqual({ route: "media", settingsSection: null });
  });

  it("ignores pages that don't exist", () => {
    localStorage.setItem("nova.lastRoute", "nowhere");
    expect(openingView({ reopened: true, route: "admin", section: 7 })).toEqual({ route: "home", settingsSection: null });
  });
});
