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
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(8787, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
