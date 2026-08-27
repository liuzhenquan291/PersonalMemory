import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("缺少应用挂载节点");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
