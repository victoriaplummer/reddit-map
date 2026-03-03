/**
 * Local dev server that serves the Worker API endpoints from results.json.
 * No D1 or Cloudflare needed — just run: bun dev-server.ts
 * Then start the frontend with: bun run start
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SubResult {
  name: string;
  related: string[];
  commenterCount: number;
  sizeBucket: number;
}

const results: SubResult[] = JSON.parse(
  readFileSync(join(__dirname, "results.json"), "utf-8")
);

// Build lookup maps
const byNameLower = new Map<string, SubResult>();
const maxBucket = Math.max(...results.map((r) => r.sizeBucket));

for (const r of results) {
  byNameLower.set(r.name.toLowerCase(), r);
}

console.log(`Loaded ${results.length} subreddits (max bucket: ${maxBucket})`);

const server = createServer((req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/api/related") {
    const sub = url.searchParams.get("sub");
    if (!sub) return send(res, 400, { error: "Missing 'sub' parameter" });

    const row = byNameLower.get(sub.toLowerCase());
    if (!row) return send(res, 200, { related: [], sizes: {} });

    const sizes: Record<string, number> = {};
    for (const name of row.related) {
      const r = byNameLower.get(name.toLowerCase());
      sizes[name] = r ? r.sizeBucket / maxBucket : 0.5;
    }

    return send(res, 200, { related: row.related, sizes });
  }

  if (path === "/api/suggestions") {
    const q = url.searchParams.get("q");
    if (!q) return send(res, 400, { error: "Missing 'q' parameter" });

    const qLower = q.toLowerCase();
    const matches = results
      .filter((r) => r.name.toLowerCase().startsWith(qLower))
      .sort((a, b) => b.commenterCount - a.commenterCount)
      .slice(0, 10)
      .map((r) => ({
        text: r.name,
        html: `<b>${r.name.slice(0, q.length)}</b>${r.name.slice(q.length)}`,
      }));

    return send(res, 200, matches);
  }

  if (path === "/api/size") {
    const sub = url.searchParams.get("sub");
    if (!sub) return send(res, 400, { error: "Missing 'sub' parameter" });

    const row = byNameLower.get(sub.toLowerCase());
    return send(res, 200, { size: row ? row.sizeBucket / maxBucket : 0 });
  }

  send(res, 404, { error: "Not found" });
});

function send(res: any, status: number, data: unknown) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

const PORT = 8787;
server.listen(PORT, () => {
  console.log(`Dev server running on http://localhost:${PORT}`);
});
