import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callNative } from "@/lib/native";
import { useConsentPrompt } from "./api";
import { ConsentDialog } from "./ConsentDialog";

vi.mock("@/lib/native", async (original) => ({ ...(await original<typeof import("@/lib/native")>()), isDesktop: () => true, callNative: vi.fn() }));

const native = vi.mocked(callNative);

const status = (needsDecision: boolean, accepted = false) => ({ needsDecision, accepted, decidedAt: null, installId: null, displayName: null, lastSent: null, lastError: null, waiting: 0, privacyUrl: "https://example.test/privacy", host: "example.test" });

function show(needsDecision: boolean) {
  native.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "telemetry_status") return status(needsDecision);
    if (command === "telemetry_decide") return status(false, args?.accepted === true);
    return null;
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConsentDialog />
    </QueryClientProvider>,
  );
}

const decisions = () => native.mock.calls.filter(([command]) => command === "telemetry_decide");

describe("the consent popup", () => {
  beforeEach(() => {
    native.mockReset();
    useConsentPrompt.setState({ open: false });
  });

  it("asks when nothing is decided, and offers both answers", async () => {
    show(true);
    expect(await screen.findByRole("button", { name: "Akzeptieren" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nicht zustimmen" })).toBeTruthy();
    expect(screen.getByText(/Tastatureingaben/)).toBeTruthy();
    expect(decisions()).toEqual([]);
  });

  it("doesn't start on the accept button, so a stray Enter accepts nothing", async () => {
    show(true);
    const accept = await screen.findByRole("button", { name: "Akzeptieren" });
    await waitFor(() => expect(document.activeElement).not.toBeNull());
    expect(document.activeElement).not.toBe(accept);
  });

  it("stays away once decided", async () => {
    show(false);
    await waitFor(() => expect(native).toHaveBeenCalledWith("telemetry_status"));
    expect(screen.queryByRole("button", { name: "Akzeptieren" })).toBeNull();
    expect(useConsentPrompt.getState().open).toBe(false);
  });

  it("accepts only on the click", async () => {
    show(true);
    fireEvent.click(await screen.findByRole("button", { name: "Akzeptieren" }));
    await waitFor(() => expect(decisions()).toEqual([["telemetry_decide", { accepted: true }]]));
    await waitFor(() => expect(useConsentPrompt.getState().open).toBe(false));
  });

  it("records a refusal", async () => {
    show(true);
    fireEvent.click(await screen.findByRole("button", { name: "Nicht zustimmen" }));
    await waitFor(() => expect(decisions()).toEqual([["telemetry_decide", { accepted: false }]]));
  });

  it("decides nothing when dismissed with Esc", async () => {
    show(true);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(useConsentPrompt.getState().open).toBe(false));
    expect(decisions()).toEqual([]);
  });
});
