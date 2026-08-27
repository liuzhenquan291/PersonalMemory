import { Link } from "react-router-dom";

export function EmptyState() {
  return (
    <section className="empty-state" aria-labelledby="empty-title">
      <div className="empty-orbit" aria-hidden="true">
        <span />
      </div>
      <span className="eyebrow">尚未收录</span>
      <h2 id="empty-title">第一条记忆，会从一次真实对话开始</h2>
      <p>
        连接你常用的 Agent 后，PersonalMemory
        会把可审阅的线索收进这里。你始终可以查看来源、纠正内容或彻底删除。
      </p>
      <Link className="primary-action" to="/settings">
        查看连接设置
      </Link>
    </section>
  );
}
