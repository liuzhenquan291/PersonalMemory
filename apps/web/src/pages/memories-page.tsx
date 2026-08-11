import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchMemories,
  deleteMemory,
  GatewayRequestError,
  invalidateMemory,
  updateMemory,
  type MemoryLevel,
  type MemoryListItem,
} from "../api/gateway";

const levelLabels: Record<MemoryLevel, string> = {
  L0: "对话原文",
  L1: "结构化记忆",
  L2: "情境摘要",
  L3: "核心画像",
};

export function MemoriesPage() {
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<MemoryLevel>("L1");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemoryListItem | null>(null);
  const [action, setAction] = useState<
    "view" | "edit" | "invalidate" | "delete"
  >("view");
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mutationMessage, setMutationMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const memories = useQuery({
    queryKey: ["memories", level, query, page],
    queryFn: ({ signal }) => fetchMemories({ level, query, page }, signal),
  });

  useEffect(() => {
    if (selected) {
      setAction("view");
      setContent(selected.content);
      setReason("");
      setConfirmation("");
      setMutationMessage("");
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
      if (action === "edit") await updateMemory(selected, content.trim());
      if (action === "invalidate")
        await invalidateMemory(selected, reason.trim());
      if (action === "delete")
        await deleteMemory(selected, reason.trim(), confirmation);
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
                        索引；不会删除原始对话、派生画像、导出文件或备份。完整级联删除将在后续阶段提供。
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
            <aside className={`source-panel is-${selected.source.status}`}>
              <strong>{selected.source.label}</strong>
              <p>{selected.source.explanation}</p>
            </aside>
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
                {selected.level === "L1" ? (
                  <button
                    className="is-danger"
                    type="button"
                    onClick={() => setAction("delete")}
                  >
                    受控删除
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="memory-actions">
                <button type="button" onClick={() => setAction("view")}>
                  取消
                </button>
                <button
                  className={action === "delete" ? "is-danger" : "is-primary"}
                  type="button"
                  disabled={
                    isSubmitting ||
                    (action === "edit" && !content.trim()) ||
                    (action !== "edit" && !reason.trim()) ||
                    (action === "delete" &&
                      confirmation !== `DELETE L1:${selected.id}`)
                  }
                  onClick={() => void submitMutation()}
                >
                  {isSubmitting
                    ? "正在处理…"
                    : action === "edit"
                      ? "保存修改"
                      : action === "invalidate"
                        ? "确认失效"
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
