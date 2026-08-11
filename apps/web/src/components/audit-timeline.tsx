import type { AuditEvent } from "../api/gateway";

const actionLabels: Record<AuditEvent["action"], string> = {
  "memory.generated": "首次观察到记忆",
  "memory.reviewed": "完成审核",
  "memory.recalled": "参与召回",
  "memory.updated": "修改记忆",
  "memory.invalidated": "标记失效",
  "memory.deleted": "执行受控删除",
  "memory.relation_created": "建立治理关系",
  "memory.relation_revoked": "撤销治理关系",
  "memory.validity_updated": "调整有效期",
  "data.exported": "导出可读数据",
};

export function AuditTimeline({ events }: { readonly events: AuditEvent[] }) {
  return (
    <ol className="audit-timeline">
      {events.map((event) => (
        <li key={event.event_id}>
          <span className="audit-node" aria-hidden="true" />
          <div className="audit-entry">
            <span className="audit-entry-meta">
              <time dateTime={event.occurred_at}>
                {new Date(event.occurred_at).toLocaleString("zh-CN")}
              </time>
              {event.subject ? (
                <code>
                  {event.subject.level} · {event.subject.reference}
                </code>
              ) : null}
            </span>
            <strong>{actionLabels[event.action]}</strong>
            <span className={`audit-outcome is-${event.outcome}`}>
              {event.outcome === "success" ? "已记录" : "未完成"}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
