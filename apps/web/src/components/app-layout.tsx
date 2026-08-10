import { NavLink, Outlet, useLocation } from "react-router-dom";

const navigation = [
  { to: "/memories", label: "记忆", glyph: "记" },
  { to: "/settings", label: "设置", glyph: "设" },
] as const;

export function AppLayout() {
  const location = useLocation();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand" aria-label="PersonalMemory">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>PersonalMemory</strong>
            <small>个人 AI 记忆工作台</small>
          </span>
        </div>

        <nav>
          {navigation.map((item) => (
            <NavLink key={item.to} className="nav-link" to={item.to}>
              <span className="nav-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="local-note">
          <span className="status-dot" aria-hidden="true" />
          <span>
            <strong>本地空间</strong>
            <small>数据默认留在此设备</small>
          </span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="memory-trace" aria-hidden="true">
            <span className="trace-node is-origin" />
            <span className="trace-line" />
            <span className="trace-node is-current" />
          </div>
          <span className="route-label">
            {location.pathname === "/settings" ? "偏好与连接" : "记忆索引"}
          </span>
          <span className="privacy-label">仅自己可见</span>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
