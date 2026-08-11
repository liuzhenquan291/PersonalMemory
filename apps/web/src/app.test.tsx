import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { AppLayout } from "./components/app-layout";
import { MemoriesPage } from "./pages/memories-page";
import { InboxPage } from "./pages/inbox-page";
import { SettingsPage } from "./pages/settings-page";
import { AuditPage } from "./pages/audit-page";

function renderRoute(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          { path: "memories", element: <MemoriesPage /> },
          { path: "inbox", element: <InboxPage /> },
          { path: "audit", element: <AuditPage /> },
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
  it("shows redacted audit events without memory bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [
            {
              sequence: 2,
              event_id: "event-2",
              action: "memory.updated",
              outcome: "success",
              subject: { level: "L1", reference: "a1b2c3d4e5f60708" },
              details: { changed_content: true },
              occurred_at: "2026-08-11T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderRoute("/audit");
    expect(await screen.findByText("修改记忆")).toBeVisible();
    expect(screen.getByText(/a1b2c3d4e5f60708/)).toBeVisible();
    expect(screen.getByText(/不保存记忆正文/)).toBeVisible();
  });

  it("reviews a corrected pending memory before it can be recalled", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        if (String(input).startsWith("/api/v1/memories?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: "pending-1",
                    level: "L1",
                    title: "界面偏好",
                    content: "用户喜欢蓝色",
                    state: { status: "active", revision: 0 },
                    review: { status: "pending", revision: 0 },
                    source: {
                      status: "original",
                      label: "1 条对话原文",
                      explanation: "source",
                    },
                  },
                ],
                page: 1,
                page_size: 12,
                total: null,
                has_previous: false,
                has_next: false,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        expect(init?.method).toBe("POST");
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [{ id: "pending-1", ok: true }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      });
    renderRoute("/inbox");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox"));
    const editor = screen.getByLabelText("修改 界面偏好");
    await user.clear(editor);
    await user.type(editor, "用户喜欢墨绿色");
    await user.click(screen.getByRole("button", { name: "接受" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory-reviews",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("用户喜欢墨绿色"),
      }),
    );
    expect(await screen.findByText("已接受所选记忆。")).toBeVisible();
  });

  it("creates a conflict only after the user selects a candidate", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.startsWith("/api/v1/memories?")) {
          const candidate = url.includes("query=%E5%80%99%E9%80%89");
          const item = candidate
            ? {
                id: "candidate",
                level: "L1",
                title: "候选事实",
                content: "候选事实内容",
              }
            : {
                id: "current",
                level: "L1",
                title: "当前事实",
                content: "当前事实内容",
              };
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    ...item,
                    state: { status: "active", revision: 0 },
                    source: {
                      status: "original",
                      label: "对话原文",
                      explanation: "source",
                    },
                    governance: {
                      recallable: true,
                      validity: {
                        level: "L1",
                        memoryId: item.id,
                        revision: 0,
                      },
                      relations: [],
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
        }
        expect(init?.method).toBe("POST");
        return Promise.resolve(
          new Response(JSON.stringify({ relation: { id: "relation-1" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
    renderRoute("/memories");
    const user = userEvent.setup();
    await user.click(await screen.findByText("当前事实"));
    await user.click(screen.getByRole("button", { name: "治理冲突" }));
    await user.type(screen.getByLabelText("查找相似候选"), "候选");
    await user.click(await screen.findByRole("radio"));
    await user.type(screen.getByLabelText("判断依据"), "用户确认存在矛盾");
    await user.click(screen.getByRole("button", { name: "确认治理关系" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/memory-relations",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"kind":"conflicts_with"'),
      }),
    );
  });
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
    expect(fetchMock).toHaveBeenCalledWith(
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

  it("shows the cascade matrix and requires both acknowledgements", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = String(input);
        if (url.startsWith("/api/v1/memories?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: "memory-1",
                    level: "L1",
                    title: "需要彻底删除",
                    content: "敏感内容",
                    state: { status: "active", revision: 0 },
                    source: {
                      status: "original",
                      label: "1 条对话原文",
                      explanation: "source-1",
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
        }
        if (url.startsWith("/api/v1/audit?")) {
          return Promise.resolve(
            new Response(JSON.stringify({ events: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url === "/api/v1/privacy-deletions/preview") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                token: "plan-1",
                level: "L1",
                memory_id: "memory-1",
                expires_at: "2026-08-11T00:10:00.000Z",
                confirmation: "ERASE L1:memory-1",
                scope: {
                  source_l0: 1,
                  index_l1: 1,
                  derived_l2: 1,
                  derived_l3: 0,
                  readable_l0: 1,
                  readable_l1: 1,
                  managed_copies: 1,
                },
                managed_copies: [
                  {
                    id: "artifact-1",
                    kind: "readable_export",
                    path: "/safe/export.json",
                  },
                ],
                limitations: ["无法发现用户自行复制的文件。"],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "partial",
              memory_id: "memory-1",
              retryable: true,
              verification: {
                l1_remaining: 1,
                l0_remaining: 0,
                derived_occurrences: 0,
                readable_rows: 0,
                managed_copies_remaining: 0,
                tombstone_present: true,
              },
              errors: [{ step: "index_l1", code: "ERASURE_STEP_FAILED" }],
            }),
            { status: 207, headers: { "content-type": "application/json" } },
          ),
        );
      });
    renderRoute("/memories");
    const user = userEvent.setup();
    await user.click(await screen.findByText("需要彻底删除"));
    await user.click(screen.getByRole("button", { name: "彻底删除" }));
    expect(
      await screen.findByRole("list", { name: "删除范围核对表" }),
    ).toBeVisible();
    expect(screen.getByText("/safe/export.json")).toBeVisible();
    const confirmButton = screen.getByRole("button", { name: "确认彻底删除" });
    expect(confirmButton).toBeDisabled();
    await user.click(screen.getByLabelText(/确认删除上方所有已登记/));
    await user.click(screen.getByLabelText(/已自行处理系统无法发现/));
    await user.type(
      screen.getByLabelText(/输入 ERASE L1:memory-1 确认/),
      "ERASE L1:memory-1",
    );
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    expect(await screen.findByText("删除尚未完成")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试彻底删除" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/privacy-deletions/plan-1/execute",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"unmanaged_copies_acknowledged":true'),
      }),
    );
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
