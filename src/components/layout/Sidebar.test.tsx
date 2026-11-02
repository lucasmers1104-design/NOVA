import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/app/navigation";
import { defaultSettings, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  beforeEach(() => {
    useSettings.setState(defaultSettings());
    useUi.setState({ route: "home", paletteOpen: false });
  });

  it("renders every navigation section", () => {
    renderWithQuery(<Sidebar />);
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole("button", { name: item.label })).toBeInTheDocument();
    }
  });

  it("marks the active route and navigates on click", async () => {
    renderWithQuery(<Sidebar />);
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "Productivity" }));

    expect(useUi.getState().route).toBe("productivity");
    expect(screen.getByRole("button", { name: "Productivity" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("respects hidden sections and custom order", () => {
    useSettings.setState({ navHidden: ["media"], navOrder: ["live", "system", "apps", "ai", "productivity", "media", "files"] });
    renderWithQuery(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Media" })).not.toBeInTheDocument();
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf("Live Information")).toBeLessThan(labels.indexOf("System"));
  });

  it("collapses and expands, persisting the preference", async () => {
    renderWithQuery(<Sidebar />);
    const aside = screen.getByRole("complementary", { name: "Primary" });
    expect(aside).toHaveAttribute("data-collapsed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
    // Collapsed items stay accessible by name and gain tooltips.
    expect(screen.getByRole("button", { name: "Media" })).toBeInTheDocument();
    expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });
});
