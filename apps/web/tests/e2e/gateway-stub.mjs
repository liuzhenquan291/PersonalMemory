import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";

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
    const inbox = request.url.includes("review_status=pending");
    const query = new URL(request.url, "http://127.0.0.1").searchParams.get(
      "query",
    );
    const candidate = query === "候选";
    response.end(
      JSON.stringify({
        items: [
          {
            id: candidate ? "memory-2" : "memory-1",
            level: "L1",
            title: candidate ? "用户偏好详细回答" : "用户偏好简洁回答",
            content: candidate
              ? "用户希望获得详细回答。"
              : "用户希望回答清晰、简洁，并说明信息来源。",
            state: { status: "active", revision: 2 },
            ...(inbox ? { review: { status: "pending", revision: 0 } } : {}),
            source: {
              status: "unavailable",
              label: "来源未记录",
              explanation: "当前存储未保留可验证的原消息引用。",
            },
            governance: {
              recallable: true,
              validity: {
                level: "L1",
                memoryId: candidate ? "memory-2" : "memory-1",
                revision: 0,
              },
              relations: [],
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
  if (request.url?.startsWith("/api/v1/audit?")) {
    response.end(
      JSON.stringify({
        events: [
          {
            sequence: 3,
            event_id: "audit-3",
            action: "memory.updated",
            outcome: "success",
            subject: { level: "L1", reference: "56d8b6c529d97f12" },
            details: { changed_content: true },
            occurred_at: "2026-08-11T08:00:00.000Z",
          },
        ],
      }),
    );
    return;
  }
  if (request.url === "/api/v1/memory-relations") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      if (
        body.kind !== "conflicts_with" ||
        body.source_id !== "memory-1" ||
        body.target_id !== "memory-2" ||
        !body.reason
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: "INVALID_REQUEST" } }));
        return;
      }
      response.end(
        JSON.stringify({ relation: { id: "relation-1", revision: 1 } }),
      );
    });
    return;
  }
  if (request.url === "/api/v1/privacy-deletions/preview") {
    response.end(
      JSON.stringify({
        token: "plan-1",
        level: "L1",
        memory_id: "memory-1",
        expires_at: "2026-08-11T08:10:00.000Z",
        confirmation: "ERASE L1:memory-1",
        scope: {
          source_l0: 1,
          index_l1: 1,
          derived_l2: 1,
          derived_l3: 0,
          readable_l0: 1,
          readable_l1: 1,
          managed_copies: 1,
        },
        managed_copies: [
          {
            id: "artifact-1",
            kind: "readable_export",
            path: "/Users/local/PersonalMemory-export.json",
          },
        ],
        limitations: ["无法发现用户自行复制、同步或改名的文件。"],
      }),
    );
    return;
  }
  if (request.url === "/api/v1/privacy-deletions/plan-1/execute") {
    response.statusCode = 207;
    response.end(
      JSON.stringify({
        status: "partial",
        memory_id: "memory-1",
        retryable: true,
        verification: {
          l1_remaining: 1,
          l0_remaining: 0,
          derived_occurrences: 0,
          readable_rows: 0,
          managed_copies_remaining: 0,
          tombstone_present: true,
        },
        errors: [{ step: "index_l1", code: "ERASURE_STEP_FAILED" }],
      }),
    );
    return;
  }
  if (request.url === "/api/v1/privacy-deletions/plan-1/cancel") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.url === "/api/v1/memory-reviews") {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      if (
        body.items?.[0]?.id !== "memory-1" ||
        body.items?.[0]?.action !== "approve" ||
        body.items?.[0]?.expected_revision !== 0
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { code: "INVALID_REQUEST" } }));
        return;
      }
      response.end(
        JSON.stringify({
          results: [
            {
              memory_id: "memory-1",
              ok: true,
              review: { status: "approved", revision: 1 },
            },
          ],
        }),
      );
    });
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

server.listen(17175, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
