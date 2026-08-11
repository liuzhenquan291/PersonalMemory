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

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

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
              state: { status: "active", revision: 0 },
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

  it("updates a memory with its revision and refreshes the list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "memory-1",
                level: "L1",
                title: "旧内容",
                content: "旧内容",
                state: { status: "active", revision: 3 },
                source: {
                  status: "unavailable",
                  label: "来源未记录",
                  explanation: "没有来源引用",
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
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ state: { status: "active", revision: 4 } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
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
    const user = userEvent.setup();
    await user.click(
      await screen.findByText("旧内容", { selector: ".memory-card-title" }),
    );
    await user.click(screen.getByRole("button", { name: "修改" }));
    const textarea = screen.getByRole("textbox", { name: "修正后的内容" });
    await user.clear(textarea);
    await user.type(textarea, "新内容");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/memories/L1/memory-1/update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "新内容", expected_revision: 3 }),
      }),
    );
  });

  it("requires exact confirmation and explains controlled deletion scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "memory-1",
              level: "L1",
              title: "待删除",
              content: "内容",
              state: { status: "active", revision: 0 },
              source: {
                status: "unavailable",
                label: "来源未记录",
                explanation: "无",
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
    await user.click(await screen.findByText("待删除"));
    await user.click(screen.getByRole("button", { name: "受控删除" }));
    expect(screen.getByText("这是受控删除，不是彻底删除")).toBeVisible();
    expect(
      screen.getByText(/不会删除原始对话、派生画像、导出文件或备份/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认受控删除" })).toBeDisabled();
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

  it("exchanges the local token for a browser session without storing it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticationConfigured: true,
            modelConfigured: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ csrfToken: "csrf-local", expiresIn: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    renderRoute("/settings");
    const user = userEvent.setup();
    const tokenInput = await screen.findByLabelText("本地访问令牌");
    await user.type(tokenInput, "local-secret");
    await user.click(screen.getByRole("button", { name: "建立安全会话" }));
    expect(await screen.findByText(/访问令牌未保存在浏览器/)).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/session",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer local-secret",
        }),
      }),
    );
    expect(tokenInput).toHaveValue("");
    expect(sessionStorage.getItem("personalmemory.csrf")).toBe("csrf-local");
    expect(JSON.stringify(sessionStorage)).not.toContain("local-secret");
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
