import { createServer } from "node:http";
import process from "node:process";

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/api/v1/config/status") {
    response.end(
      JSON.stringify({
        authenticationConfigured: true,
        modelConfigured: false,
      }),
    );
    return;
  }
  if (request.url?.startsWith("/api/v1/memories?")) {
    response.end(
      JSON.stringify({
        items: [
          {
            id: "memory-1",
            level: "L1",
            title: "用户偏好简洁回答",
            content: "用户希望回答清晰、简洁，并说明信息来源。",
            source: {
              status: "unavailable",
              label: "来源未记录",
              explanation: "当前存储未保留可验证的原消息引用。",
            },
          },
        ],
        page: 1,
        page_size: 12,
        total: 1,
        has_previous: false,
        has_next: false,
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(8787, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
