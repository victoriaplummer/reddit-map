export interface Env {
  DB: D1Database;
}

interface SubredditRow {
  name: string;
  name_lower: string;
  related: string;
  commenter_count: number;
  size_bucket: number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=86400",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/related") {
      return handleRelated(url, env);
    }
    if (path === "/api/suggestions") {
      return handleSuggestions(url, env);
    }
    if (path === "/api/size") {
      return handleSize(url, env);
    }

    return errorResponse("Not found", 404);
  },
};

async function handleRelated(url: URL, env: Env): Promise<Response> {
  const sub = url.searchParams.get("sub");
  if (!sub) return errorResponse("Missing 'sub' parameter");

  const subLower = sub.toLowerCase();

  // Fetch the queried subreddit
  const row = await env.DB.prepare(
    "SELECT name, related, size_bucket FROM subreddits WHERE name_lower = ?"
  )
    .bind(subLower)
    .first<SubredditRow>();

  if (!row) {
    return jsonResponse({ related: [], sizes: {} });
  }

  const related: string[] = JSON.parse(row.related);

  // Fetch sizes for all related subs in one query
  if (related.length === 0) {
    return jsonResponse({ related, sizes: {} });
  }

  const placeholders = related.map(() => "?").join(",");
  const lowerNames = related.map((r) => r.toLowerCase());

  const sizeRows = await env.DB.prepare(
    `SELECT name, size_bucket FROM subreddits WHERE name_lower IN (${placeholders})`
  )
    .bind(...lowerNames)
    .all<SubredditRow>();

  // Get max bucket for normalization
  const maxRow = await env.DB.prepare(
    "SELECT MAX(size_bucket) as max_bucket FROM subreddits"
  ).first<{ max_bucket: number }>();

  const maxBucket = maxRow?.max_bucket || 1;

  const sizes: Record<string, number> = {};
  for (const r of sizeRows.results) {
    sizes[r.name] = r.size_bucket / maxBucket;
  }

  return jsonResponse({ related, sizes });
}

async function handleSuggestions(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams.get("q");
  if (!q) return errorResponse("Missing 'q' parameter");

  const qLower = q.toLowerCase();

  const rows = await env.DB.prepare(
    "SELECT name FROM subreddits WHERE name_lower LIKE ? || '%' ORDER BY commenter_count DESC LIMIT 10"
  )
    .bind(qLower)
    .all<SubredditRow>();

  const suggestions = rows.results.map((r) => {
    // Highlight the matching prefix
    const matchLen = q.length;
    const html = `<b>${r.name.slice(0, matchLen)}</b>${r.name.slice(matchLen)}`;
    return { text: r.name, html };
  });

  return jsonResponse(suggestions);
}

async function handleSize(url: URL, env: Env): Promise<Response> {
  const sub = url.searchParams.get("sub");
  if (!sub) return errorResponse("Missing 'sub' parameter");

  const subLower = sub.toLowerCase();

  const row = await env.DB.prepare(
    "SELECT size_bucket FROM subreddits WHERE name_lower = ?"
  )
    .bind(subLower)
    .first<SubredditRow>();

  const maxRow = await env.DB.prepare(
    "SELECT MAX(size_bucket) as max_bucket FROM subreddits"
  ).first<{ max_bucket: number }>();

  const maxBucket = maxRow?.max_bucket || 1;

  if (!row) {
    return jsonResponse({ size: 0 });
  }

  return jsonResponse({ size: row.size_bucket / maxBucket });
}
