import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { AppLayout } from "./components/app-layout";
import { MemoriesPage } from "./pages/memories-page";
import { SettingsPage } from "./pages/settings-page";

function renderRoute(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          { path: "memories", element: <MemoriesPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("PersonalMemory Web", () => {
  it("renders a personal empty state without team concepts", () => {
    renderRoute("/memories");

    expect(
      screen.getByRole("heading", { name: "把散落的上下文，变成可掌控的线索" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "第一条记忆，会从一次真实对话开始" }),
    ).toBeVisible();
    expect(screen.queryByText(/团队|成员|工作区/)).not.toBeInTheDocument();
  });

  it("supports keyboard navigation to settings", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => undefined),
    );
    renderRoute("/memories");
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByText("跳到主要内容")).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("heading", { name: "知道数据会去哪里" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("正在确认本地服务");
  });

  it("shows a useful Gateway error and retry action", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    renderRoute("/settings");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法连接本地服务",
    );
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  });

  it("renders the validated Gateway status contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticationConfigured: true,
          modelConfigured: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderRoute("/settings");

    expect(await screen.findByText("记忆访问保护")).toBeVisible();
    expect(screen.getByText("已配置")).toBeVisible();
    expect(screen.getByText("模型连接")).toBeVisible();
    expect(screen.getByText("关闭")).toBeVisible();
  });

  it("keeps router state and query cache across parent rerenders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          authenticationConfigured: true,
          modelConfigured: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    window.history.replaceState(null, "", "/memories");
    const user = userEvent.setup();
    const view = render(<App />);

    await user.click(screen.getByRole("link", { name: /^设置$/ }));
    expect(await screen.findByText("已连接")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(<App />);
    expect(
      screen.getByRole("heading", { name: "知道数据会去哪里" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
