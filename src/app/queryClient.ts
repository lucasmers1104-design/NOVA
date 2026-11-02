import { QueryClient } from "@tanstack/react-query";
import { NativeUnavailableError } from "@/lib/native";

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
