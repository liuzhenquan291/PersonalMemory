import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchAudit, type AuditAction } from "../api/gateway";
import { AuditTimeline } from "../components/audit-timeline";

export function AuditPage() {
  const [action, setAction] = useState<AuditAction | "">("");
  const [cursors, setCursors] = useState<Array<number | undefined>>([
    undefined,
  ]);
  const cursor = cursors.at(-1);
  const audit = useQuery({
    queryKey: ["audit", action, cursor],
    queryFn: ({ signal }) =>
      fetchAudit(
        {
          ...(action ? { action } : {}),
          ...(cursor ? { beforeSequence: cursor } : {}),
          limit: 30,
        },
        signal,
      ),
  });

  return (
    <div className="page page-audit">
      <header className="page-heading compact">
        <span className="eyebrow">本地审计</span>
        <h1>每一次改变，都留下不含正文的足迹</h1>
        <p>
          按时间查看记忆如何被观察、审核、召回和治理。这里只显示脱敏引用，不保存记忆正文、搜索词或操作原因。
        </p>
      </header>
      <label className="audit-filter">
        <span>按事件筛选</span>
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value as AuditAction | "");
            setCursors([undefined]);
          }}
        >
          <option value="">全部事件</option>
          <option value="memory.reviewed">审核</option>
          <option value="memory.recalled">召回</option>
          <option value="memory.updated">修改</option>
          <option value="memory.deleted">删除记忆</option>
          <option value="data.exported">数据导出</option>
        </select>
      </label>
      {audit.isPending ? (
        <div className="memory-state" role="status">
          正在读取本地审计记录…
        </div>
      ) : audit.isError ? (
        <div className="memory-state is-error" role="alert">
          <strong>暂时无法读取审计记录</strong>
          <span>请确认本地服务和访问会话有效。</span>
          <button type="button" onClick={() => void audit.refetch()}>
            重新加载
          </button>
        </div>
      ) : audit.data.events.length === 0 ? (
        <div className="memory-state">
          <strong>还没有匹配的审计记录</strong>
          <span>完成记忆审核、召回或治理后，事件会显示在这里。</span>
        </div>
      ) : (
        <AuditTimeline events={audit.data.events} />
      )}
      <nav className="pagination" aria-label="审计分页">
        <button
          type="button"
          disabled={cursors.length === 1 || audit.isFetching}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          上一页
        </button>
        <span>第 {cursors.length} 页</span>
        <button
          type="button"
          disabled={!audit.data?.next_before_sequence || audit.isFetching}
          onClick={() =>
            setCursors((current) => [
              ...current,
              audit.data!.next_before_sequence,
            ])
          }
        >
          下一页
        </button>
      </nav>
    </div>
  );
}
