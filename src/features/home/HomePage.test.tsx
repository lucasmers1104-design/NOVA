import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { flushDashboardSaves, useDashboard } from "@/features/dashboard/store";
import { renderWithQuery } from "@/test/render";
import HomePage from "./HomePage";

function activeWidgets() {
  const { layouts, activeId } = useDashboard.getState();
  return layouts.find((l) => l.id === activeId)!.widgets;
}

describe("Home customize mode", () => {
  beforeEach(async () => {
    useDashboard.setState({ status: "idle", layouts: [], activeId: "", editing: false, lastRemoved: null, storageError: null });
    await useDashboard.getState().load();
  });

  it("adds, configures, moves, removes and restores a widget", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);

    await user.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getAllByRole("group", { name: /Arrow keys move/ })).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: "Add widget" }));
    await user.click(within(screen.getByRole("dialog", { name: "Add a widget" })).getByRole("button", { name: /World clock/ }));
    expect(activeWidgets().at(-1)?.widgetId).toBe("clock");

    await user.click(screen.getByRole("button", { name: "World clock settings" }));
    const settings = screen.getByRole("dialog", { name: "World clock settings" });
    await user.selectOptions(within(settings).getByLabelText("Time zone"), "Asia/Tokyo");
    expect(activeWidgets().at(-1)?.config).toEqual({ timeZone: "Asia/Tokyo" });
    await user.click(within(settings).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Keyboard move and resize.
    const overlay = screen.getByRole("group", { name: /^World clock, 4 by 2/ });
    overlay.focus();
    await user.keyboard("{ArrowLeft}");
    expect(activeWidgets().at(-2)?.widgetId).toBe("clock");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(activeWidgets().find((w) => w.widgetId === "clock")).toMatchObject({ w: 5, h: 2 });

    await user.click(screen.getByRole("button", { name: "Remove World clock" }));
    expect(activeWidgets().some((w) => w.widgetId === "clock")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Undo remove" }));
    expect(activeWidgets().some((w) => w.widgetId === "clock")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useDashboard.getState().editing).toBe(false);
    await flushDashboardSaves();
    // Many real interactions; generous timeout for slower machines.
  }, 20_000);

  it("exits customize mode with Escape", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Customize" }));
    await user.keyboard("{Escape}");
    expect(useDashboard.getState().editing).toBe(false);
  });

  it("creates and switches to a new empty layout", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);

    await user.click(screen.getByRole("button", { name: /switch layout/ }));
    await user.click(screen.getByRole("menuitem", { name: "New layout…" }));
    const dialog = screen.getByRole("dialog", { name: "New layout" });
    await user.type(within(dialog).getByLabelText("Name"), "Gaming");
    await user.click(within(dialog).getByText("Empty"));
    await user.click(within(dialog).getByRole("button", { name: "Create layout" }));

    expect(await screen.findByText("“Gaming” is empty")).toBeInTheDocument();
    expect(useDashboard.getState().layouts.map((l) => l.name)).toEqual(["Default", "Gaming"]);

    await user.click(screen.getByRole("button", { name: /switch layout/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Default" }));
    expect(screen.queryByText("“Gaming” is empty")).not.toBeInTheDocument();
    await flushDashboardSaves();
  });

  it("asks before deleting a layout", async () => {
    const user = userEvent.setup();
    useDashboard.getState().createLayout("Temporary", "empty");
    renderWithQuery(<HomePage />);

    await user.click(screen.getByRole("button", { name: /switch layout/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete “Temporary”…" }));
    expect(useDashboard.getState().layouts).toHaveLength(2);
    await user.click(within(screen.getByRole("dialog", { name: "Delete “Temporary”?" })).getByRole("button", { name: "Delete layout" }));
    expect(useDashboard.getState().layouts.map((l) => l.name)).toEqual(["Default"]);
    await flushDashboardSaves();
  });
});
