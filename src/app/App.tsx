import { QueryClientProvider } from "@tanstack/react-query";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { AppShell } from "./AppShell";
import { queryClient } from "./queryClient";

export function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
