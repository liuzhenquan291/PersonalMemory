import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  fetchMemories,
  reviewMemories,
  type MemoryListItem,
} from "../api/gateway";

export function InboxPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inbox = useQuery({
    queryKey: ["inbox", "pending"],
    queryFn: ({ signal }) =>
      fetchMemories(
        { level: "L1", query: "", page: 1, reviewStatus: "pending" },
        signal,
      ),
  });
  const chosen = useMemo(
    () => inbox.data?.items.filter((item) => selected.has(item.id)) ?? [],
    [inbox.data, selected],
  );

  const submit = async (action: "approve" | "reject") => {
    if (chosen.length === 0) return;
    setSubmitting(true);
    setMessage("");
    try {
      await reviewMemories(
        chosen.map((item) => {
          const draft = (drafts[item.id] ?? item.content).trim();
          return {
            id: item.id,
            action,
            expected_revision: item.review?.revision ?? 0,
            ...(action === "approve" && draft !== item.content
              ? { content: draft }
              : {}),
            ...(action === "reject" ? { reason: reason.trim() } : {}),
          };
        }),
      );
      setSelected(new Set());
      setReason("");
      setMessage(
        action === "approve" ? "已接受所选记忆。" : "已拒绝所选记忆。",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["memories"] }),
      ]);
    } catch {
      setMessage(
        "部分记忆未处理，请重新加载后重试。已成功的项目不会重复执行。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page page-inbox">
      <header className="page-heading">
        <span className="eyebrow">记忆收件箱</span>
        <h1>先确认，再让记忆参与回答</h1>
        <p>新提炼的结构化记忆默认留在这里，只有接受后才会进入自动召回。</p>
      </header>

      {inbox.isPending ? (
        <div className="memory-state" role="status">
          正在整理待审核记忆…
        </div>
      ) : inbox.isError ? (
        <div className="memory-state is-error" role="alert">
          <strong>暂时无法读取收件箱</strong>
          <button type="button" onClick={() => void inbox.refetch()}>
            重新加载
          </button>
        </div>
      ) : inbox.data.items.length === 0 ? (
        <div className="memory-state">
          <strong>收件箱已清空</strong>
          <span>新提炼的记忆会先出现在这里。</span>
        </div>
      ) : (
        <section className="inbox-stack" aria-label="待审核记忆">
          {inbox.data.items.map((item: MemoryListItem) => {
            const checked = selected.has(item.id);
            return (
              <article className="inbox-item" key={item.id}>
                <label className="inbox-select">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  />
                  <span className="review-tab">待确认</span>
                  <strong>{item.title}</strong>
                </label>
                <textarea
                  aria-label={`修改 ${item.title}`}
                  rows={3}
                  value={drafts[item.id] ?? item.content}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))
                  }
                />
                <small>
                  {item.source.label} · 修改文本后接受，将先写回本地记忆。
                </small>
              </article>
            );
          })}
        </section>
      )}

      <section className="inbox-actions" aria-label="批量审核操作">
        <span>已选择 {chosen.length} 条</span>
        <label>
          <span className="sr-only">拒绝原因</span>
          <input
            placeholder="拒绝原因（拒绝时必填）"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={submitting || chosen.length === 0}
          onClick={() => void submit("approve")}
        >
          接受
        </button>
        <button
          className="is-reject"
          type="button"
          disabled={submitting || chosen.length === 0 || !reason.trim()}
          onClick={() => void submit("reject")}
        >
          拒绝
        </button>
      </section>
      {message ? (
        <p className="mutation-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
