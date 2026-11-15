import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLASS_OPACITY } from "@/design/backdrop";
import { defaultSettings, useSettings } from "@/stores/settings";
import { renderWithQuery } from "@/test/render";
import { AppearanceSettings } from "./AppearanceSettings";
import { NavigationSettings } from "./NavigationSettings";

const stage = () => screen.getByRole("group", { name: /Vorschau: ein kleines NOVA-Fenster/ });

describe("Darstellung", () => {
  beforeEach(() => useSettings.setState(defaultSettings()));

  it("tries an accent on in the small window before NOVA wears it", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AppearanceSettings />);
    expect(stage().style.getPropertyValue("--nova-accent")).toBe("#8b5cf6");
    expect(screen.getByRole("radio", { name: "Violett" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Cyan" }));
    // The stage wears it, with the text color that reads on NOVA's surfaces; the app not yet.
    expect(stage().style.getPropertyValue("--nova-accent")).toBe("#22d3ee");
    expect(stage().style.getPropertyValue("--nova-on-accent")).toBe("#0a0c14");
    expect(within(stage()).getByText("Vorschau: Cyan")).toBeInTheDocument();
    expect(screen.getByText("In der Vorschau")).toBeInTheDocument();
    expect(useSettings.getState().accent).toEqual({ kind: "preset", id: "purple" });

    await user.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(stage().style.getPropertyValue("--nova-accent")).toBe("#8b5cf6");
    expect(screen.getByRole("button", { name: "Akzent übernehmen" })).toBeDisabled();

    // A color of one's own, by its hex value.
    fireEvent.change(screen.getAllByLabelText("Hex")[0]!, { target: { value: "#ff5d8f" } });
    await user.click(screen.getByRole("button", { name: "Akzent übernehmen" }));
    expect(useSettings.getState().accent).toEqual({ kind: "custom", color: "#ff5d8f" });
    expect(screen.getByText("Eigene Farbe #FF5D8F")).toBeInTheDocument();
  });

  it("follows an accent set elsewhere", async () => {
    renderWithQuery(<AppearanceSettings />);
    fireEvent.click(screen.getByRole("radio", { name: "Bernstein" }));
    // e.g. a profile or the command palette: the draft gives way.
    useSettings.getState().setAccent({ kind: "preset", id: "blue" });
    expect(await screen.findByRole("radio", { name: "Blau", checked: true })).toBeInTheDocument();
    expect(stage().style.getPropertyValue("--nova-accent")).toBe("#3d7bff");
  });

  it("chooses a background, which brings its accent, and offers what only a gradient has", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AppearanceSettings />);
    expect(screen.getByRole("radio", { name: "Windows" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("slider", { name: "Abdunkeln" })).toBeNull();

    await user.click(screen.getByRole("radio", { name: "Aurora" }));
    expect(useSettings.getState().backdropGradient).toMatchObject({ presetId: "aurora", style: "mesh" });
    expect(useSettings.getState().accent).toEqual({ kind: "custom", color: "#00d9f5" });
    // The wallpaper gives way to the gradient.
    expect(screen.getByRole("switch", { name: "Windows-Hintergrundbild zeigen" })).toBeDisabled();

    fireEvent.change(screen.getByRole("slider", { name: "Abdunkeln" }), { target: { value: "60" } });
    expect(useSettings.getState().backdropDim).toBe(60);
    // A mesh has no direction; a linear gradient does.
    expect(screen.queryByRole("slider", { name: "Richtung" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Linear" }));
    fireEvent.change(screen.getByRole("slider", { name: "Richtung" }), { target: { value: "90" } });
    // Changing it makes the gradient one's own, which then has its own card to return to.
    expect(useSettings.getState().backdropGradient).toMatchObject({ presetId: null, style: "linear", angle: 90 });
    expect(screen.getByRole("radio", { name: "Dein Verlauf" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("button", { name: "Farbe hinzufügen" }));
    expect(useSettings.getState().backdropGradient?.colors).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Farbe 4 entfernen" }));
    expect(useSettings.getState().backdropGradient?.colors).toHaveLength(3);

    await user.click(screen.getByRole("radio", { name: "Windows" }));
    expect(useSettings.getState().backdropGradient).toBeNull();
  });

  it("sets glass, corners, font and motion at once", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AppearanceSettings />);
    fireEvent.change(screen.getByRole("slider", { name: "Glasstärke" }), { target: { value: "80" } });
    expect(useSettings.getState().glassOpacity).toBe(80);
    // A double-click goes back to how NOVA ships it.
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Glasstärke" }));
    expect(useSettings.getState().glassOpacity).toBe(DEFAULT_GLASS_OPACITY);

    await user.click(screen.getByRole("radio", { name: "#1d4f7a" }));
    expect(useSettings.getState().glassTint).toBe("#1d4f7a");
    await user.click(screen.getByRole("radio", { name: "Dunkles Glas" }));
    expect(useSettings.getState().glassTint).toBeNull();

    fireEvent.change(screen.getByRole("slider", { name: "Ecken" }), { target: { value: "140" } });
    expect(useSettings.getState().cornerScale).toBe(140);
    await user.click(screen.getByRole("radio", { name: "Bahnschrift" }));
    expect(useSettings.getState().uiFont).toBe("bahnschrift");
    await user.click(screen.getByRole("radio", { name: /^Reduziert/ }));
    expect(useSettings.getState().motion).toBe("reduced");

    // Without transparency there is no glass to set.
    await user.click(screen.getByRole("switch", { name: "Transparenz" }));
    expect(useSettings.getState().transparency).toBe(false);
    expect(screen.getByRole("slider", { name: "Glasstärke" })).toBeDisabled();
  });

  it("goes back to how NOVA ships, on the second click, and leaves the rest alone", async () => {
    const user = userEvent.setup();
    useSettings.setState({ cornerScale: 20, uiFont: "comic", motion: "full", glassTint: "#4c3a8f", displayName: "Luca", navHidden: ["media"] });
    renderWithQuery(<AppearanceSettings />);
    await user.click(screen.getByRole("button", { name: "Zurücksetzen …" }));
    expect(useSettings.getState().cornerScale).toBe(20);
    await user.click(screen.getByRole("button", { name: "Wirklich zurücksetzen" }));
    expect(useSettings.getState()).toMatchObject({ cornerScale: 100, uiFont: "inter", motion: "system", glassTint: null, displayName: "Luca", navHidden: ["media"] });
  });

  it("shows the small window with the user's own sidebar, and lets it change pages", async () => {
    const user = userEvent.setup();
    useSettings.setState({ displayName: "Luca", navOrder: ["media", ...defaultSettings().navOrder.filter((id) => id !== "media")], navHidden: ["system"] });
    renderWithQuery(<AppearanceSettings />);
    const pages = within(within(stage()).getByRole("navigation", { name: "Seiten der Vorschau" })).getAllByRole("button");
    // Home first, then the user's order, without what they hid.
    expect(pages.slice(0, 3).map((button) => button.getAttribute("aria-label"))).toEqual(["Home in der Vorschau zeigen", "Media in der Vorschau zeigen", "Apps in der Vorschau zeigen"]);
    expect(pages[0]).toHaveAttribute("aria-current", "page");
    expect(within(stage()).getByText(/, Luca$/)).toBeInTheDocument();
    await user.click(pages[1]!);
    expect(pages[1]).toHaveAttribute("aria-current", "page");
    expect(await within(stage()).findByText("Control what's playing on this PC")).toBeInTheDocument();
  });
});

describe("Navigation", () => {
  beforeEach(() => useSettings.setState(defaultSettings()));

  it("orders the sidebar with the keyboard: Space, arrows, Space", () => {
    renderWithQuery(<NavigationSettings />);
    const grip = screen.getByRole("button", { name: "Apps verschieben" });
    fireEvent.keyDown(grip, { key: " " });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(useSettings.getState().navOrder.slice(0, 2)).toEqual(["apps", "system"]);
    expect(screen.getByRole("status")).toHaveTextContent("Apps: Platz 1 von 10");
    fireEvent.keyDown(grip, { key: " " });
    // The cards follow the stored order.
    expect(within(screen.getByRole("list", { name: "Reihenfolge der Seitenleiste" })).getAllByRole("listitem")[0]).toHaveTextContent("Apps");
  });

  it("hides and shows sections, and keeps what is hidden in its place", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NavigationSettings />);
    // Media and Files start hidden; showing Media again and hiding Live works the same way.
    await user.click(screen.getByRole("switch", { name: "Media in der Seitenleiste zeigen" }));
    expect(useSettings.getState().navHidden).toEqual(["files"]);
    await user.click(screen.getByRole("switch", { name: "Live Information in der Seitenleiste zeigen" }));
    expect(useSettings.getState().navHidden).toEqual(["files", "live"]);
    expect(screen.getAllByText("Ausgeblendet").length).toBeGreaterThan(0);
    expect(useSettings.getState().navOrder).toEqual(defaultSettings().navOrder);
    // Widget Studio has a fixed place, so it only has a switch.
    await user.click(screen.getByRole("switch", { name: "Widget Studio in der Seitenleiste zeigen" }));
    expect(useSettings.getState().navHidden).toEqual(["files", "live", "studio"]);
    expect(screen.queryByRole("button", { name: "Widget Studio verschieben" })).toBeNull();
  });

  it("restores the default order on the second click", async () => {
    const user = userEvent.setup();
    useSettings.getState().setNavOrder(["files", "media"]);
    useSettings.getState().setNavHidden("apps", true);
    renderWithQuery(<NavigationSettings />);
    await user.click(screen.getByRole("button", { name: "Standard wiederherstellen" }));
    expect(useSettings.getState().navOrder[0]).toBe("files");
    await user.click(screen.getByRole("button", { name: "Wirklich zurücksetzen" }));
    expect(useSettings.getState()).toMatchObject({ navOrder: defaultSettings().navOrder, navHidden: ["media", "files"] });
  });
});
