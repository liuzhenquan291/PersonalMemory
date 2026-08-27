import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

export function AppErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "页面暂时无法显示。你的记忆数据没有受到影响。";

  return (
    <main className="fatal-state" role="alert">
      <span className="eyebrow">页面中断</span>
      <h1>这条线索暂时走不通</h1>
      <p>{detail}</p>
      <Link className="primary-action" to="/memories">
        返回记忆
      </Link>
    </main>
  );
}
