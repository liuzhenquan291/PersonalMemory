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
  it("renders a personal empty state without team concepts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          page: 1,
          page_size: 12,
          total: 0,
          has_previous: false,
          has_next: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderRoute("/memories");

    expect(
      screen.getByRole("heading", { name: "把散落的上下文，变成可掌控的线索" }),
    ).toBeVisible();
    expect(await screen.findByText("这个层级还没有记录")).toBeVisible();
    expect(screen.queryByText(/团队|成员|工作区/)).not.toBeInTheDocument();
  });

  it("searches, opens long details, and states provenance truthfully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "memory-1",
              level: "L1",
              title: "用户偏好简洁回答",
              content: "很长的结构化内容".repeat(80),
              source: {
                status: "unavailable",
                label: "来源未记录",
                explanation: "当前存储未保留可验证的原消息引用。",
              },
            },
          ],
          page: 1,
          page_size: 12,
          total: 1,
          has_previous: false,
          has_next: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderRoute("/memories");
    const user = userEvent.setup();

    expect(await screen.findByText("用户偏好简洁回答")).toBeVisible();
    await user.click(screen.getByText("用户偏好简洁回答"));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getAllByText("来源未记录").length).toBeGreaterThan(0);
    expect(screen.getByText(/当前存储未保留/)).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭记忆详情" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows memory loading and a retryable error state", async () => {
    let rejectRequest!: (reason: Error) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    renderRoute("/memories");
    expect(screen.getByRole("status")).toHaveTextContent("正在读取本地记忆");
    rejectRequest(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法读取记忆",
    );
    expect(screen.getByRole("button", { name: "重新加载" })).toBeEnabled();
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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        const body = url.startsWith("/api/v1/memories?")
          ? {
              items: [],
              page: 1,
              page_size: 12,
              total: 0,
              has_previous: false,
              has_next: false,
            }
          : { authenticationConfigured: true, modelConfigured: false };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
    window.history.replaceState(null, "", "/memories");
    const user = userEvent.setup();
    const view = render(<App />);

    await user.click(screen.getByRole("link", { name: /^设置$/ }));
    expect(await screen.findByText("已连接")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<App />);
    expect(
      screen.getByRole("heading", { name: "知道数据会去哪里" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
