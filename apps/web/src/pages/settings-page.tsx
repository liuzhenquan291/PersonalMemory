import { useQuery } from "@tanstack/react-query";

import { fetchGatewayStatus } from "../api/gateway";

export function SettingsPage() {
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
