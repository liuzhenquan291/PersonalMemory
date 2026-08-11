import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { createBrowserSession, fetchGatewayStatus } from "../api/gateway";

export function SettingsPage() {
  const [token, setToken] = useState("");
  const [sessionState, setSessionState] = useState<
    "idle" | "submitting" | "ready" | "error"
  >("idle");
  const status = useQuery({
    queryKey: ["gateway-status"],
    queryFn: ({ signal }) => fetchGatewayStatus(signal),
  });

  return (
    <div className="page page-settings">
      <header className="page-heading compact">
        <span className="eyebrow">设置</span>
        <h1>知道数据会去哪里</h1>
        <p>所有外部连接默认关闭；启用前会明确显示目标和发送内容。</p>
      </header>

      <section className="settings-panel" aria-labelledby="connection-title">
        <div>
          <span className="section-kicker">运行状态</span>
          <h2 id="connection-title">本地服务</h2>
        </div>

        {status.isPending ? (
          <div className="status-row" role="status">
            <span className="loading-pulse" aria-hidden="true" />
            <span>正在确认本地服务…</span>
          </div>
        ) : status.isError ? (
          <div className="status-message is-error" role="alert">
            <strong>暂时无法连接本地服务</strong>
            <span>请确认 Gateway 已启动，然后重试。</span>
            <button type="button" onClick={() => void status.refetch()}>
              重新检查
            </button>
          </div>
        ) : (
          <dl className="status-list">
            <div>
              <dt>Gateway</dt>
              <dd>
                <span className="status-dot" aria-hidden="true" /> 已连接
              </dd>
            </div>
            <div>
              <dt>记忆访问保护</dt>
              <dd>
                {status.data.authenticationConfigured ? "已配置" : "待配置"}
              </dd>
            </div>
            <div>
              <dt>模型连接</dt>
              <dd>{status.data.modelConfigured ? "已配置" : "关闭"}</dd>
            </div>
          </dl>
        )}
      </section>

      {status.data?.authenticationConfigured ? (
        <section className="settings-panel" aria-labelledby="unlock-title">
          <div>
            <span className="section-kicker">浏览器会话</span>
            <h2 id="unlock-title">解锁记忆管理</h2>
          </div>
          <form
            className="session-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSessionState("submitting");
              void createBrowserSession(token)
                .then(() => {
                  setToken("");
                  setSessionState("ready");
                })
                .catch(() => setSessionState("error"));
            }}
          >
            <label>
              <span>本地访问令牌</span>
              <input
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={!token || sessionState === "submitting"}
            >
              {sessionState === "submitting" ? "正在解锁…" : "建立安全会话"}
            </button>
            {sessionState === "ready" ? (
              <p role="status">已解锁。访问令牌未保存在浏览器中。</p>
            ) : sessionState === "error" ? (
              <p className="is-error" role="alert">
                解锁失败，请检查本地访问令牌。
              </p>
            ) : (
              <p>令牌只用于换取本机短期会话，不会写入浏览器存储。</p>
            )}
          </form>
        </section>
      ) : null}

      <section className="settings-panel subdued" aria-labelledby="agent-title">
        <div>
          <span className="section-kicker">连接入口</span>
          <h2 id="agent-title">Agent 接入</h2>
        </div>
        <p>通用 MCP 接入将在后续步骤开放。当前不会自动连接任何 Agent。</p>
        <span className="coming-soon">即将可用</span>
      </section>
    </div>
  );
}
