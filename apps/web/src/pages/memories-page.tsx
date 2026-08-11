import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchMemories,
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
  const [level, setLevel] = useState<MemoryLevel>("L1");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemoryListItem | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const memories = useQuery({
    queryKey: ["memories", level, query, page],
    queryFn: ({ signal }) => fetchMemories({ level, query, page }, signal),
  });

  useEffect(() => {
    if (selected) closeButtonRef.current?.focus();
    else previousFocusRef.current?.focus();
  }, [selected]);

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
              if (event.key === "Tab") {
                event.preventDefault();
                closeButtonRef.current?.focus();
              }
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
            <div className="memory-detail-content">{selected.content}</div>
            <aside className={`source-panel is-${selected.source.status}`}>
              <strong>{selected.source.label}</strong>
              <p>{selected.source.explanation}</p>
            </aside>
          </section>
        </div>
      ) : null}
    </div>
  );
}
