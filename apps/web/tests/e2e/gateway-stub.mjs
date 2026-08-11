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
            state: { status: "active", revision: 2 },
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
  if (request.url === "/api/v1/memories/L1/memory-1/update") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      if (
        body.content !== "用户偏好结构清晰的简洁回答" ||
        body.expected_revision !== 2
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: "INVALID_REQUEST" } }));
        return;
      }
      response.end(
        JSON.stringify({ state: { status: "active", revision: 3 } }),
      );
    });
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
