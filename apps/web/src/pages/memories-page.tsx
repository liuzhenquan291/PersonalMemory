import { EmptyState } from "../components/empty-state";

export function MemoriesPage() {
  return (
    <div className="page page-memories">
      <header className="page-heading">
        <span className="eyebrow">你的记忆</span>
        <h1>把散落的上下文，变成可掌控的线索</h1>
        <p>在这里审阅、纠正和追溯由对话沉淀的个人记忆。</p>
      </header>

      <div className="memory-toolbar" aria-label="记忆工具栏">
        <label className="search-field">
          <span className="sr-only">搜索记忆</span>
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="搜索记忆或来源" disabled />
        </label>
        <span className="count-label">0 条记忆</span>
      </div>

      <EmptyState />
    </div>
  );
}
