/**
 * Step 2: For each author, collect their subreddit activity via Arctic Shift API.
 * Adapts speed based on X-RateLimit-Remaining / X-RateLimit-Reset headers.
 * Output: interactions.json — array of { author, subreddit, count } tuples
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_BASE = "https://arctic-shift.photon-reddit.com/api";
const REQUEST_TIMEOUT_MS = 30_000;
const CHECKPOINT_FILE = join(__dirname, "checkpoint-interactions.json");

// Rate limit state — updated from response headers
let rateLimitRemaining = 100;
let rateLimitReset = 0; // epoch seconds

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read rate limit headers and decide how long to wait */
function updateRateLimit(res: Response): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining != null) rateLimitRemaining = parseInt(remaining, 10);
  if (reset != null) rateLimitReset = parseInt(reset, 10);
}

function getAdaptiveDelay(): number {
  if (rateLimitRemaining <= 0) {
    // Out of budget — wait until reset
    const waitMs = Math.max(0, (rateLimitReset - Date.now() / 1000)) * 1000 + 500;
    return waitMs;
  }
  if (rateLimitRemaining < 10) return 2000;
  if (rateLimitRemaining < 30) return 500;
  if (rateLimitRemaining < 60) return 100;
  return 20; // Plenty of budget, go fast
}

interface Interaction {
  author: string;
  subreddit: string;
  count: number;
}

interface Checkpoint {
  completedAuthors: string[];
  interactions: Interaction[];
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }
  return { completedAuthors: [], interactions: [] };
}

function saveCheckpoint(cp: Checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
}

async function fetchAuthorActivity(author: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let cursorEpoch = Math.floor(new Date("2005-01-01").getTime() / 1000);
  let retries = 0;
  const MAX_RETRIES = 3;

  while (true) {
    const url = `${API_BASE}/comments/search?author=${encodeURIComponent(author)}&limit=100&sort=asc&after=${cursorEpoch}&fields=subreddit,created_utc`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      retries++;
      console.log(`    timeout (attempt ${retries}/${MAX_RETRIES})`);
      if (retries >= MAX_RETRIES) break;
      await sleep(2000);
      continue;
    }

    updateRateLimit(res);

    if (!res.ok) {
      if (res.status === 429) {
        const waitMs = Math.max(0, (rateLimitReset - Date.now() / 1000)) * 1000 + 500;
        console.log(`    rate limited, waiting ${Math.round(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }
      break; // 422s, 404s, etc — skip this author silently
    }
    retries = 0;

    const json = await res.json() as { data: { subreddit: string; created_utc: number }[] };
    const data = json.data;

    if (!data || data.length === 0) break;

    for (const comment of data) {
      counts.set(comment.subreddit, (counts.get(comment.subreddit) || 0) + 1);
    }

    if (data.length < 100) break;

    const lastUtc = data[data.length - 1].created_utc;
    if (lastUtc <= cursorEpoch) {
      cursorEpoch = cursorEpoch + 1;
    } else {
      cursorEpoch = lastUtc;
    }

    await sleep(getAdaptiveDelay());
  }

  return counts;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function main() {
  const authorsPath = join(__dirname, "authors.json");
  if (!existsSync(authorsPath)) {
    console.error("authors.json not found. Run 01-collect-authors.ts first.");
    process.exit(1);
  }

  const authors: string[] = JSON.parse(readFileSync(authorsPath, "utf-8"));
  const checkpoint = loadCheckpoint();
  const completedSet = new Set(checkpoint.completedAuthors);
  const interactions = checkpoint.interactions;

  // Save checkpoint on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n\nCaught Ctrl+C — saving checkpoint...");
    saveCheckpoint(checkpoint);
    console.log(`Saved. ${completedSet.size} authors checkpointed.`);
    process.exit(0);
  });

  const remaining = authors.length - completedSet.size;
  console.log(`\n${authors.length} total authors | ${completedSet.size} already done | ${remaining} remaining\n`);

  const SAVE_EVERY = 50;
  let processed = 0;
  let skipped = 0;
  const startTime = Date.now();

  for (const author of authors) {
    if (completedSet.has(author)) continue;

    const pct = ((processed / remaining) * 100).toFixed(1);
    console.log(`  [${pct}%] ${processed + 1}/${remaining} - ${author}  (rate budget: ${rateLimitRemaining})`);
    const activity = await fetchAuthorActivity(author);

    if (activity.size === 0) {
      skipped++;
    } else {
      console.log(`    -> ${activity.size} subs`);
    }

    for (const [subreddit, count] of activity) {
      interactions.push({ author, subreddit, count });
    }

    completedSet.add(author);
    checkpoint.completedAuthors.push(author);
    processed++;

    if (processed % SAVE_EVERY === 0) {
      saveCheckpoint(checkpoint);
    }

    // Summary every 100 authors
    if (processed % 100 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const etaSeconds = (remaining - processed) / rate;
      console.log(`\n  --- ${((processed / remaining) * 100).toFixed(1)}% (${processed}/${remaining}) | ${rate.toFixed(1)} authors/s | ETA: ${formatTime(etaSeconds)} | skipped: ${skipped} ---\n`);
    }

    await sleep(getAdaptiveDelay());
  }

  console.log("");

  // Final save
  saveCheckpoint(checkpoint);
  writeFileSync(join(__dirname, "interactions.json"), JSON.stringify(interactions, null, 2));
  console.log(`\nDone! ${interactions.length} interactions from ${processed} authors (${skipped} had no data)`);
}

main().catch(console.error);
