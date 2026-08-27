import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  addMemoryRelation,
  cancelPrivacyDeletion,
  fetchAudit,
  fetchMemories,
  deleteMemory,
  executePrivacyDeletion,
  GatewayRequestError,
  invalidateMemory,
  previewPrivacyDeletion,
  revokeMemoryRelation,
  setMemoryValidity,
  updateMemory,
  type MemoryLevel,
  type MemoryListItem,
  type PrivacyDeletionPreview,
  type PrivacyDeletionResult,
} from "../api/gateway";
import { AuditTimeline } from "../components/audit-timeline";

const levelLabels: Record<MemoryLevel, string> = {
  L0: "对话原文",
  L1: "结构化记忆",
  L2: "情境摘要",
  L3: "核心画像",
};

const erasureScopeLabels: Record<
  keyof PrivacyDeletionPreview["scope"],
  string
> = {
  source_l0: "来源对话",
  index_l1: "结构化记忆与索引",
  derived_l2: "情境摘要中的精确内容",
  derived_l3: "核心画像中的精确内容",
  readable_l0: "本地对话 JSONL",
  readable_l1: "本地记忆 JSONL",
  managed_copies: "已登记导出与备份",
};

function localDateTimeValue(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function MemoriesPage() {
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<MemoryLevel>("L1");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemoryListItem | null>(null);
  const [action, setAction] = useState<
    | "view"
    | "edit"
    | "invalidate"
    | "delete"
    | "erase"
    | "governance"
    | "validity"
  >("view");
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mutationMessage, setMutationMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [erasurePreview, setErasurePreview] =
    useState<PrivacyDeletionPreview | null>(null);
  const [erasureResult, setErasureResult] =
    useState<PrivacyDeletionResult | null>(null);
  const [managedCopiesConfirmed, setManagedCopiesConfirmed] = useState(false);
  const [unmanagedCopiesConfirmed, setUnmanagedCopiesConfirmed] =
    useState(false);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [relationKind, setRelationKind] = useState<
    "conflicts_with" | "supersedes"
  >("conflicts_with");
  const [validFrom, setValidFrom] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const memories = useQuery({
    queryKey: ["memories", level, query, page],
    queryFn: ({ signal }) => fetchMemories({ level, query, page }, signal),
  });
  const candidates = useQuery({
    queryKey: ["memory-candidates", candidateQuery],
    queryFn: ({ signal }) =>
      fetchMemories(
        { level: "L1", query: candidateQuery.trim(), page: 1 },
        signal,
      ),
    enabled:
      action === "governance" &&
      selected?.level === "L1" &&
      candidateQuery.trim().length > 0,
  });
  const timeline = useQuery({
    queryKey: ["audit", selected?.level, selected?.id],
    queryFn: ({ signal }) =>
      fetchAudit(
        {
          level: selected!.level,
          memoryId: selected!.id,
          limit: 12,
        },
        signal,
      ),
    enabled: Boolean(selected),
  });

  useEffect(() => {
    if (selected) {
      setAction("view");
      setContent(selected.content);
      setReason("");
      setConfirmation("");
      setMutationMessage("");
      setErasurePreview(null);
      setErasureResult(null);
      setManagedCopiesConfirmed(false);
      setUnmanagedCopiesConfirmed(false);
      setCandidateQuery("");
      setCandidateId("");
      setRelationKind("conflicts_with");
      setValidFrom(selected.governance?.validity.validFrom ?? "");
      setExpiresAt(selected.governance?.validity.expiresAt ?? "");
      closeButtonRef.current?.focus();
    } else previousFocusRef.current?.focus();
  }, [selected]);

  const finishMutation = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories"] });
    setSelected(null);
  };

  const submitMutation = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    setMutationMessage("");
    try {
      if (action === "erase" && erasurePreview) {
        const result = await executePrivacyDeletion(
          erasurePreview,
          confirmation,
        );
        setErasureResult(result);
        if (result.status === "complete") {
          await finishMutation();
        } else {
          setMutationMessage(
            "仍检测到受控范围内的残留。当前删除凭据已保留，请重试完成剩余步骤。",
          );
        }
        return;
      }
      if (action === "edit") await updateMemory(selected, content.trim());
      if (action === "invalidate")
        await invalidateMemory(selected, reason.trim());
      if (action === "delete")
        await deleteMemory(selected, reason.trim(), confirmation);
      if (action === "validity")
        await setMemoryValidity(selected, validFrom, expiresAt);
      if (action === "governance" && selected.level === "L1") {
        await addMemoryRelation({
          level: "L1",
          kind: relationKind,
          sourceId: selected.id,
          targetId: candidateId,
          reason: reason.trim(),
          ...(relationKind === "supersedes" &&
          content.trim() !== selected.content
            ? { mergedContent: content.trim() }
            : {}),
        });
      }
      await finishMutation();
    } catch (error) {
      setMutationMessage(
        error instanceof GatewayRequestError && error.status === 409
          ? "这条记忆已发生变化，请关闭后重新打开再试。"
          : "操作未完成。请确认浏览器会话仍有效，然后重试。",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const beginErasure = async () => {
    if (!selected || selected.level !== "L1") return;
    setAction("erase");
    setIsSubmitting(true);
    setMutationMessage("");
    setConfirmation("");
    setManagedCopiesConfirmed(false);
    setUnmanagedCopiesConfirmed(false);
    setErasureResult(null);
    try {
      setErasurePreview(await previewPrivacyDeletion(selected));
    } catch {
      setMutationMessage("无法生成删除范围，请确认本地服务可用后重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelErasure = async () => {
    if (erasurePreview && !erasureResult) {
      try {
        await cancelPrivacyDeletion(erasurePreview.token);
      } catch {
        setMutationMessage("删除预览取消失败，请关闭详情后重新加载。");
        return;
      }
    }
    setErasurePreview(null);
    setErasureResult(null);
    setAction("view");
  };

  const changeLevel = (next: MemoryLevel) => {
    setLevel(next);
    setPage(1);
    setSelected(null);
  };

  return (
    <div className="page page-memories">
      <header className="page-heading">
        <span className="eyebrow">你的记忆</span>
        <h1>把散落的上下文，变成可掌控的线索</h1>
        <p>在这里审阅、纠正和追溯由对话沉淀的个人记忆。</p>
      </header>

      <form
        className="memory-toolbar"
        aria-label="记忆工具栏"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draftQuery.trim());
          setPage(1);
        }}
      >
        <label className="search-field">
          <span className="sr-only">搜索记忆</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="搜索当前层级"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
          />
        </label>
        <button className="search-action" type="submit">
          搜索
        </button>
        <span className="count-label">
          {memories.data?.total === null
            ? "搜索结果"
            : `${memories.data?.total ?? 0} 条记录`}
        </span>
      </form>

      <div className="level-tabs" aria-label="记忆层级">
        {(Object.keys(levelLabels) as MemoryLevel[]).map((item) => (
          <button
            type="button"
            key={item}
            aria-pressed={level === item}
            onClick={() => changeLevel(item)}
          >
            <strong>{item}</strong>
            <span>{levelLabels[item]}</span>
          </button>
        ))}
      </div>

      {memories.isPending ? (
        <div className="memory-state" role="status">
          正在读取本地记忆…
        </div>
      ) : memories.isError &&
        memories.error instanceof GatewayRequestError &&
        memories.error.status === 401 ? (
        <div className="memory-state is-error" role="alert">
          <strong>需要先解锁记忆管理</strong>
          <span>当前浏览器还没有本机访问会话。</span>
          <Link className="button-link" to="/settings">
            前往设置解锁
          </Link>
        </div>
      ) : memories.isError ? (
        <div className="memory-state is-error" role="alert">
          <strong>暂时无法读取记忆</strong>
          <span>请确认本地服务和访问会话有效。</span>
          <button type="button" onClick={() => void memories.refetch()}>
            重新加载
          </button>
        </div>
      ) : memories.data.items.length === 0 ? (
        <div className="memory-state">
          <strong>{query ? "没有匹配的记录" : "这个层级还没有记录"}</strong>
          <span>尝试切换层级或修改搜索词。</span>
        </div>
      ) : (
        <section
          className="memory-list"
          aria-label={`${levelLabels[level]}列表`}
        >
          {memories.data.items.map((item) => (
            <button
              className="memory-card"
              type="button"
              key={`${item.level}:${item.id}`}
              onClick={(event) => {
                previousFocusRef.current = event.currentTarget;
                setSelected(item);
              }}
            >
              <span className="memory-card-meta">
                <strong>{item.level}</strong>
                <span className={`source-badge is-${item.source.status}`}>
                  {item.source.label}
                </span>
                {item.governance && !item.governance.recallable ? (
                  <span className="governance-badge">不参与召回</span>
                ) : null}
              </span>
              <span className="memory-card-title">{item.title}</span>
              <span className="memory-card-preview">{item.content}</span>
              <span className="memory-card-action">查看详情与来源 →</span>
            </button>
          ))}
        </section>
      )}

      <nav className="pagination" aria-label="记忆分页">
        <button
          type="button"
          disabled={!memories.data?.has_previous || memories.isFetching}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          上一页
        </button>
        <span>第 {page} 页</span>
        <button
          type="button"
          disabled={!memories.data?.has_next || memories.isFetching}
          onClick={() => setPage((current) => current + 1)}
        >
          下一页
        </button>
      </nav>

      {selected ? (
        <div
          className="memory-detail-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <section
            className="memory-detail"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-detail-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setSelected(null);
            }}
          >
            <header>
              <div>
                <span className="eyebrow">{selected.level} · 记忆详情</span>
                <h2 id="memory-detail-title">{selected.title}</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="关闭记忆详情"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </header>
            {action === "view" ? (
              <div className="memory-detail-content">{selected.content}</div>
            ) : action === "edit" ? (
              <label className="memory-action-field">
                <strong>修正后的内容</strong>
                <textarea
                  rows={10}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
            ) : action === "validity" ? (
              <div className="memory-action-form">
                <label className="memory-action-field">
                  <strong>生效时间（可留空）</strong>
                  <input
                    type="datetime-local"
                    value={localDateTimeValue(validFrom)}
                    onChange={(event) =>
                      setValidFrom(
                        event.target.value
                          ? new Date(event.target.value).toISOString()
                          : "",
                      )
                    }
                  />
                </label>
                <label className="memory-action-field">
                  <strong>过期时间（可留空）</strong>
                  <input
                    type="datetime-local"
                    value={localDateTimeValue(expiresAt)}
                    onChange={(event) =>
                      setExpiresAt(
                        event.target.value
                          ? new Date(event.target.value).toISOString()
                          : "",
                      )
                    }
                  />
                </label>
                <p className="action-explanation">
                  未生效或已过期的记忆仍可查看，但不会参与自动召回。
                </p>
              </div>
            ) : action === "governance" ? (
              <div className="memory-action-form governance-form">
                <label className="memory-action-field">
                  <strong>查找相似候选</strong>
                  <input
                    type="search"
                    value={candidateQuery}
                    placeholder="输入关键词；系统只提供候选，不自动判定冲突"
                    onChange={(event) => {
                      setCandidateQuery(event.target.value);
                      setCandidateId("");
                    }}
                  />
                </label>
                {candidates.data ? (
                  <fieldset className="candidate-list">
                    <legend>选择另一条记忆</legend>
                    {candidates.data.items.filter(
                      (item) => item.id !== selected.id,
                    ).length === 0 ? (
                      <span className="action-explanation">
                        没有其他匹配记忆，请换一个关键词。
                      </span>
                    ) : (
                      candidates.data.items
                        .filter((item) => item.id !== selected.id)
                        .map((item) => (
                          <label key={item.id}>
                            <input
                              type="radio"
                              name="candidate"
                              value={item.id}
                              checked={candidateId === item.id}
                              onChange={() => setCandidateId(item.id)}
                            />
                            <span>{item.content}</span>
                          </label>
                        ))
                    )}
                  </fieldset>
                ) : null}
                <label className="memory-action-field">
                  <strong>处理方式</strong>
                  <select
                    value={relationKind}
                    onChange={(event) =>
                      setRelationKind(
                        event.target.value as "conflicts_with" | "supersedes",
                      )
                    }
                  >
                    <option value="conflicts_with">标记为互相冲突</option>
                    <option value="supersedes">当前记忆合并并替代候选</option>
                  </select>
                </label>
                {relationKind === "supersedes" ? (
                  <label className="memory-action-field">
                    <strong>合并后的当前记忆</strong>
                    <textarea
                      rows={6}
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                    />
                  </label>
                ) : null}
                <label className="memory-action-field">
                  <strong>判断依据</strong>
                  <input
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              </div>
            ) : action === "erase" ? (
              <div className="memory-action-form erasure-form">
                <div className="erasure-heading" role="note">
                  <span>不可撤销操作</span>
                  <strong>彻底删除受控范围内的这条记忆</strong>
                  <p>
                    系统会删除可验证的来源、索引、精确派生内容、可读副本，以及下列已登记导出和备份。
                  </p>
                </div>
                {!erasurePreview ? (
                  <p className="action-explanation" role="status">
                    {isSubmitting
                      ? "正在核对删除范围…"
                      : "删除范围暂时不可用。"}
                  </p>
                ) : (
                  <>
                    <ol className="erasure-matrix" aria-label="删除范围核对表">
                      {(
                        Object.keys(erasureScopeLabels) as Array<
                          keyof PrivacyDeletionPreview["scope"]
                        >
                      ).map((key) => (
                        <li key={key}>
                          <span>{erasureScopeLabels[key]}</span>
                          <strong>{erasurePreview.scope[key]} 项</strong>
                        </li>
                      ))}
                    </ol>
                    {erasurePreview.managed_copies.length ? (
                      <div className="managed-copy-list">
                        <strong>将整件删除的已登记副本</strong>
                        {erasurePreview.managed_copies.map((copy) => (
                          <code key={copy.id}>{copy.path}</code>
                        ))}
                      </div>
                    ) : null}
                    <ul className="erasure-limitations">
                      {erasurePreview.limitations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <label className="erasure-check">
                      <input
                        type="checkbox"
                        checked={managedCopiesConfirmed}
                        onChange={(event) =>
                          setManagedCopiesConfirmed(event.target.checked)
                        }
                      />
                      <span>我确认删除上方所有已登记导出和备份。</span>
                    </label>
                    <label className="erasure-check">
                      <input
                        type="checkbox"
                        checked={unmanagedCopiesConfirmed}
                        onChange={(event) =>
                          setUnmanagedCopiesConfirmed(event.target.checked)
                        }
                      />
                      <span>
                        我已自行处理系统无法发现的复制、同步或改名文件。
                      </span>
                    </label>
                    <label className="memory-action-field">
                      <strong>
                        输入 <code>{erasurePreview.confirmation}</code> 确认
                      </strong>
                      <input
                        value={confirmation}
                        autoComplete="off"
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                      />
                    </label>
                    {erasureResult?.status === "partial" ? (
                      <div className="erasure-receipt" role="status">
                        <strong>删除尚未完成</strong>
                        <span>
                          剩余：L1 {erasureResult.verification.l1_remaining} ·
                          L0 {erasureResult.verification.l0_remaining} ·
                          派生内容{" "}
                          {erasureResult.verification.derived_occurrences} ·
                          本地可读行 {erasureResult.verification.readable_rows}{" "}
                          · 受管副本{" "}
                          {erasureResult.verification.managed_copies_remaining}
                        </span>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <div className="memory-action-form">
                <label className="memory-action-field">
                  <strong>原因</strong>
                  <input
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                {action === "delete" ? (
                  <>
                    <div className="deletion-scope" role="note">
                      <strong>这是受控删除，不是彻底删除</strong>
                      <p>
                        此操作会让这条 L1 记忆从 PersonalMemory
                        浏览和召回中消失，并尝试删除 L1
                        索引；不会删除原始对话、派生画像、导出文件或备份。如需清理受控范围，请返回并选择“彻底删除”。
                      </p>
                    </div>
                    <label className="memory-action-field">
                      <strong>
                        输入 <code>{`DELETE L1:${selected.id}`}</code> 确认
                      </strong>
                      <input
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                      />
                    </label>
                  </>
                ) : (
                  <p className="action-explanation">
                    失效后，这条记忆会从浏览和召回中隐藏；本阶段不会自动恢复。
                  </p>
                )}
              </div>
            )}
            {action !== "erase" ? (
              <aside className={`source-panel is-${selected.source.status}`}>
                <strong>{selected.source.label}</strong>
                <p>{selected.source.explanation}</p>
              </aside>
            ) : null}
            {action !== "erase" && selected.governance ? (
              <aside className="governance-panel" aria-label="冲突与有效期">
                <strong>
                  {selected.governance.recallable
                    ? "当前可参与召回"
                    : "当前不参与召回"}
                </strong>
                <p>
                  {selected.governance.validity.validFrom
                    ? `生效：${selected.governance.validity.validFrom}`
                    : "立即生效"}
                  {selected.governance.validity.expiresAt
                    ? ` · 过期：${selected.governance.validity.expiresAt}`
                    : " · 长期有效"}
                </p>
                {selected.governance.relations.map((relation) => (
                  <div className="relation-row" key={relation.id}>
                    <span>
                      {relation.kind === "conflicts_with" ? "冲突" : "替代"} ·
                      {relation.status === "active" ? "生效中" : "已撤销"} ·
                      关联记忆
                      {relation.sourceMemoryId === selected.id
                        ? relation.targetMemoryId
                        : relation.sourceMemoryId}
                      · {relation.reason}
                    </span>
                    {relation.status === "active" ? (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => {
                          setIsSubmitting(true);
                          void revokeMemoryRelation(relation)
                            .then(finishMutation)
                            .catch(() =>
                              setMutationMessage(
                                "撤销未完成，请重新加载后再试。",
                              ),
                            )
                            .finally(() => setIsSubmitting(false));
                        }}
                      >
                        撤销
                      </button>
                    ) : null}
                  </div>
                ))}
              </aside>
            ) : null}
            {action === "view" ? (
              <aside className="memory-audit-panel" aria-label="记忆时间线">
                <strong>这条记忆的时间线</strong>
                <p>事件只保留脱敏引用，不包含正文、搜索词或操作原因。</p>
                {timeline.isPending ? (
                  <span className="action-explanation">正在读取时间线…</span>
                ) : timeline.isError ? (
                  <span className="mutation-message">时间线暂时不可用。</span>
                ) : timeline.data.events.length ? (
                  <AuditTimeline events={timeline.data.events} />
                ) : (
                  <span className="action-explanation">
                    还没有可显示的事件。
                  </span>
                )}
              </aside>
            ) : null}
            {mutationMessage ? (
              <p className="mutation-message" role="alert">
                {mutationMessage}
              </p>
            ) : null}
            {selected.level === "L0" ? (
              <p className="action-explanation">
                对话原文当前只读；结构化记忆和摘要可进行纠错。
              </p>
            ) : action === "view" ? (
              <div className="memory-actions">
                <button type="button" onClick={() => setAction("edit")}>
                  修改
                </button>
                <button type="button" onClick={() => setAction("invalidate")}>
                  标记失效
                </button>
                <button type="button" onClick={() => setAction("validity")}>
                  设置有效期
                </button>
                {selected.level === "L1" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setAction("governance")}
                    >
                      治理冲突
                    </button>
                    <button
                      className="is-danger"
                      type="button"
                      onClick={() => setAction("delete")}
                    >
                      受控删除
                    </button>
                    <button
                      className="is-danger-solid"
                      type="button"
                      onClick={() => void beginErasure()}
                    >
                      彻底删除
                    </button>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="memory-actions">
                <button
                  type="button"
                  onClick={() =>
                    action === "erase"
                      ? void cancelErasure()
                      : setAction("view")
                  }
                >
                  {action === "erase" ? "取消彻底删除" : "取消"}
                </button>
                <button
                  className={
                    action === "erase"
                      ? "is-danger-solid"
                      : action === "delete"
                        ? "is-danger"
                        : "is-primary"
                  }
                  type="button"
                  disabled={
                    isSubmitting ||
                    (action === "edit" && !content.trim()) ||
                    (["invalidate", "delete", "governance"].includes(action) &&
                      !reason.trim()) ||
                    (action === "governance" && !candidateId) ||
                    (action === "governance" &&
                      relationKind === "supersedes" &&
                      !content.trim()) ||
                    (action === "delete" &&
                      confirmation !== `DELETE L1:${selected.id}`) ||
                    (action === "erase" &&
                      (!erasurePreview ||
                        !managedCopiesConfirmed ||
                        !unmanagedCopiesConfirmed ||
                        confirmation !== erasurePreview.confirmation))
                  }
                  onClick={() => void submitMutation()}
                >
                  {isSubmitting
                    ? "正在处理…"
                    : action === "edit"
                      ? "保存修改"
                      : action === "validity"
                        ? "保存有效期"
                        : action === "governance"
                          ? "确认治理关系"
                          : action === "invalidate"
                            ? "确认失效"
                            : action === "erase"
                              ? erasureResult?.status === "partial"
                                ? "重试彻底删除"
                                : "确认彻底删除"
                              : "确认受控删除"}
                </button>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
