import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  return join(root, safe);
}

createServer((request, response) => {
  let filePath = resolveRequestPath(request.url || "/");
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, "index.html");
  }

  response.setHeader("Content-Type", mimeTypes[extname(filePath)] || "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Origin-Agent-Cluster", "?1");
  response.setHeader("Permissions-Policy", "tools=(self)");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  createReadStream(filePath)
    .on("error", () => {
      response.statusCode = 500;
      response.end("Unable to read file");
    })
    .pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log(`CashLatch is running at http://localhost:${port}`);
});
