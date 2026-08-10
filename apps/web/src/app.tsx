import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";

import { AppErrorBoundary } from "./components/app-error-boundary";
import { AppLayout } from "./components/app-layout";
import { MemoriesPage } from "./pages/memories-page";
import { SettingsPage } from "./pages/settings-page";

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: "/",
      element: <AppLayout />,
      errorElement: <AppErrorBoundary />,
      children: [
        { index: true, element: <Navigate replace to="/memories" /> },
        { path: "memories", element: <MemoriesPage /> },
        { path: "settings", element: <SettingsPage /> },
      ],
    },
  ]);
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function App() {
  const [queryClient] = useState(createAppQueryClient);
  const [router] = useState(createAppRouter);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
