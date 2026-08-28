import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  createBrowserSession,
  authorizeModel,
  fetchModelAuthorization,
  fetchModelConfiguration,
  fetchGatewayStatus,
  fetchHookAuthorization,
  hasBrowserSession,
  saveModelConfiguration,
  revokeModelAuthorization,
  updateHookAuthorization,
} from "../api/gateway";

export function SettingsPage() {
  const [token, setToken] = useState("");
  const [sessionState, setSessionState] = useState<
    "idle" | "submitting" | "ready" | "error"
  >(() => (hasBrowserSession() ? "ready" : "idle"));
  const status = useQuery({
    queryKey: ["gateway-status"],
    queryFn: ({ signal }) => fetchGatewayStatus(signal),
  });
  const hookAuthorization = useQuery({
    queryKey: ["hook-authorization"],
    queryFn: ({ signal }) => fetchHookAuthorization(signal),
    retry: false,
    enabled: sessionState === "ready",
  });
  const [authorizationMessage, setAuthorizationMessage] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [modelKeySaved, setModelKeySaved] = useState(false);
  const modelConfiguration = useQuery({
    queryKey: ["model-configuration"],
    queryFn: ({ signal }) => fetchModelConfiguration(signal),
    retry: false,
    enabled: sessionState === "ready",
  });
  const modelAuthorization = useQuery({
    queryKey: ["model-authorization"],
    queryFn: ({ signal }) => fetchModelAuthorization(signal),
    retry: false,
    enabled:
      sessionState === "ready" &&
      (modelKeySaved ||
        modelConfiguration.data?.configuration.enabled === true),
  });

  const changeHookAuthorization = (
    target: "recall" | "capture",
    enabled: boolean,
  ) => {
    const current = hookAuthorization.data?.authorization;
    const disclosureVersion = hookAuthorization.data?.disclosure.version;
    if (!current || disclosureVersion !== 1) return;
    setAuthorizationMessage("正在保存…");
    void updateHookAuthorization({
      current,
      disclosureVersion,
      recallEnabled: target === "recall" ? enabled : current.recall_enabled,
      captureEnabled: target === "capture" ? enabled : current.capture_enabled,
    })
      .then((authorization) => {
        hookAuthorization.refetch();
        setAuthorizationMessage(
          authorization.recall_enabled || authorization.capture_enabled
            ? "授权已更新。worker 会在下一次同步后应用。"
            : "自动召回与自动捕获均已关闭。",
        );
      })
      .catch(() => {
        setAuthorizationMessage("保存失败，请重新加载状态后再试。");
      });
  };

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
            <p>
              请在交互式终端运行 <code>personalmemory token show</code>{" "}
              取得令牌；不要把令牌粘贴到聊天、工单或公开终端记录中。
            </p>
            <p>浏览器安全会话默认有效 1 小时，关闭页面不会延长有效期。</p>
            <p>
              <code>gateway.env</code>{" "}
              是受权限保护的底层凭据文件，仅用于排障，不建议日常直接读取。
            </p>
          </form>
        </section>
      ) : null}

      <section className="settings-panel" aria-labelledby="agent-title">
        <div>
          <span className="section-kicker">连接入口</span>
          <h2 id="agent-title">Agent 接入</h2>
        </div>
        <p>
          安装器会受管配置 Codex 与 Claude Code 的自动记忆 Hook；Codex
          初次安装或定义升级后仍需在客户端检查并信任精确定义。
        </p>
        <p>
          Web 不读取 Agent 配置文件。请运行 <code>personalmemory status</code>
          查看 Hook 信任、worker、积压和保留期维护状态。
        </p>
      </section>

      <section className="settings-panel" aria-labelledby="model-title">
        <div>
          <span className="section-kicker">记忆提炼模型</span>
          <h2 id="model-title">OpenAI-compatible 模型</h2>
        </div>
        {sessionState !== "ready" ? (
          <p>请先解锁浏览器会话，再配置用于 L0 到 L1 提炼的模型。</p>
        ) : modelConfiguration.isPending ? (
          <p role="status">正在读取模型配置…</p>
        ) : modelConfiguration.isError ? (
          <p className="is-error" role="alert">
            模型配置读取失败，请重新解锁后再试。
          </p>
        ) : (
          <form
            className="session-form"
            onSubmit={(event) => {
              event.preventDefault();
              setModelMessage("正在保存…");
              void saveModelConfiguration({
                baseUrl: modelBaseUrl,
                apiKey: modelApiKey,
                modelName,
              })
                .then((result) => {
                  setModelApiKey("");
                  setModelKeySaved(result.configuration.api_key_configured);
                  setModelMessage(
                    result.restart_required
                      ? "配置已保存。请运行受管重启命令后再授权模型外联。"
                      : "模型配置已保存。",
                  );
                  void modelConfiguration.refetch();
                  void modelAuthorization.refetch();
                  void status.refetch();
                })
                .catch(() =>
                  setModelMessage("保存失败，请检查接口地址和配置项。"),
                );
            }}
          >
            <p>
              Provider 固定为 <code>openai-compatible</code>。
            </p>
            <label>
              <span>模型接口地址</span>
              <input
                type="url"
                required
                placeholder={modelConfiguration.data.configuration.base_url}
                value={modelBaseUrl}
                onChange={(event) => setModelBaseUrl(event.target.value)}
              />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={modelApiKey}
                onChange={(event) => setModelApiKey(event.target.value)}
              />
            </label>
            {modelKeySaved ||
            modelConfiguration.data.configuration.api_key_configured ? (
              <p>API Key 已配置</p>
            ) : null}
            <label>
              <span>模型名称</span>
              <input
                required
                placeholder={modelConfiguration.data.configuration.model_name}
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={!modelBaseUrl || !modelApiKey || !modelName}
            >
              保存模型配置
            </button>
            {modelMessage ? <p role="status">{modelMessage}</p> : null}
            {modelAuthorization.data ? (
              <div>
                <strong>模型外联披露</strong>
                <p>
                  目标：
                  <code>{modelAuthorization.data.disclosure.targetOrigin}</code>
                </p>
                <p>
                  发送内容：
                  {modelAuthorization.data.disclosure.sentFields.join("、")}
                </p>
                <p>
                  当前状态：
                  {modelAuthorization.data.authorization.status === "authorized"
                    ? "已授权"
                    : "未授权"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const action =
                      modelAuthorization.data.authorization.status ===
                      "authorized"
                        ? revokeModelAuthorization()
                        : authorizeModel(modelAuthorization.data.disclosure);
                    setModelMessage("正在更新模型外联授权…");
                    void action
                      .then(() => {
                        setModelMessage(
                          "模型外联授权已更新。请运行受管重启命令应用变更。",
                        );
                        void modelAuthorization.refetch();
                      })
                      .catch(() =>
                        setModelMessage(
                          "模型外联授权更新失败，请重新加载后再试。",
                        ),
                      );
                  }}
                >
                  {modelAuthorization.data.authorization.status === "authorized"
                    ? "撤销模型外联"
                    : "授权模型外联"}
                </button>
              </div>
            ) : null}
          </form>
        )}
      </section>

      <section className="settings-panel" aria-labelledby="automation-title">
        <div>
          <span className="section-kicker">自动记忆授权</span>
          <h2 id="automation-title">分别控制召回与本地捕获</h2>
        </div>
        {sessionState !== "ready" ? (
          <p>请先解锁浏览器会话，再读取或修改自动记忆授权。</p>
        ) : hookAuthorization.isPending ? (
          <p role="status">正在读取自动记忆授权…</p>
        ) : hookAuthorization.isError ? (
          <p>授权状态读取失败，请重新解锁或稍后重试。</p>
        ) : (
          <div className="status-list">
            <div>
              <strong>自动召回</strong>
              <dl>
                <div>
                  <dt>处理数据</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.data}</dd>
                </div>
                <div>
                  <dt>时机</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.timing}</dd>
                </div>
                <div>
                  <dt>用途</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.purpose}</dd>
                </div>
                <div>
                  <dt>目的地</dt>
                  <dd>
                    {hookAuthorization.data.disclosure.recall.destination}
                  </dd>
                </div>
                <div>
                  <dt>预算</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.budget}</dd>
                </div>
                <div>
                  <dt>失败行为</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.failure}</dd>
                </div>
                <div>
                  <dt>撤销效果</dt>
                  <dd>{hookAuthorization.data.disclosure.recall.revocation}</dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() =>
                  changeHookAuthorization(
                    "recall",
                    !hookAuthorization.data.authorization.recall_enabled,
                  )
                }
              >
                {hookAuthorization.data.authorization.recall_enabled
                  ? "关闭自动召回"
                  : "授权自动召回"}
              </button>
            </div>
            <div>
              <strong>自动本地捕获</strong>
              <dl>
                <div>
                  <dt>处理数据</dt>
                  <dd>{hookAuthorization.data.disclosure.capture.data}</dd>
                </div>
                <div>
                  <dt>时机</dt>
                  <dd>{hookAuthorization.data.disclosure.capture.timing}</dd>
                </div>
                <div>
                  <dt>用途</dt>
                  <dd>{hookAuthorization.data.disclosure.capture.purpose}</dd>
                </div>
                <div>
                  <dt>目的地</dt>
                  <dd>
                    {hookAuthorization.data.disclosure.capture.destination}
                  </dd>
                </div>
                <div>
                  <dt>预算</dt>
                  <dd>{hookAuthorization.data.disclosure.capture.budget}</dd>
                </div>
                <div>
                  <dt>失败行为</dt>
                  <dd>{hookAuthorization.data.disclosure.capture.failure}</dd>
                </div>
                <div>
                  <dt>撤销效果</dt>
                  <dd>
                    {hookAuthorization.data.disclosure.capture.revocation}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() =>
                  changeHookAuthorization(
                    "capture",
                    !hookAuthorization.data.authorization.capture_enabled,
                  )
                }
              >
                {hookAuthorization.data.authorization.capture_enabled
                  ? "关闭自动捕获"
                  : "授权自动捕获"}
              </button>
            </div>
          </div>
        )}
        {authorizationMessage ? (
          <p role="status">{authorizationMessage}</p>
        ) : null}
      </section>

      <section
        className="settings-panel subdued"
        aria-labelledby="boundary-title"
      >
        <div>
          <span className="section-kicker">首版使用边界</span>
          <h2 id="boundary-title">日常管理用 Web，系统操作用受管命令</h2>
        </div>
        <p>
          Web
          负责浏览、审核、纠错、冲突治理、审计和强确认删除。安装、升级、导出、备份、恢复、停止与卸载由同一套受管命令完成；不需要直接操作数据库或拼接
          Gateway API。
        </p>
        <p>
          可读 JSON/Markdown
          导出用于长期阅读和校验，当前不能导入或重建索引；迁移到另一安装请使用已验证的完整备份。
        </p>
      </section>
    </div>
  );
}
