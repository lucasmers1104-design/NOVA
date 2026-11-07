import { focusManager, QueryClient } from "@tanstack/react-query";
import { NativeUnavailableError } from "@/lib/native";

// A desktop window gets focus without ever becoming "visible" again, so the
// default (visibility only) would miss coming back to NOVA from another app.
focusManager.setEventListener((changed) => {
  const onChange = () => changed();
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
});

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retrying cannot conjure a desktop runtime inside a browser.
        retry: (failureCount, error) => !(error instanceof NativeUnavailableError) && failureCount < 2,
        // Live data polls on its own interval; focus refetches would only duplicate work.
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** The app's single client; also read by non-React code such as the command registry. */
export const queryClient = createQueryClient();
