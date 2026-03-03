/**
 * Step 1: Collect unique authors from seed subreddits via Arctic Shift API.
 * Paginates month-by-month through comment history.
 * Output: authors.json — deduplicated author list
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEED_SUBS = ["Airtable", "AI_Agents"];
const API_BASE = "https://arctic-shift.photon-reddit.com/api";
const START_DATE = "2017-01-01";
const END_DATE = new Date().toISOString().slice(0, 10);
const BOT_PATTERN = /bot$/i;
const EXCLUDED_AUTHORS = new Set(["[deleted]", "AutoModerator"]);
const DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const CHECKPOINT_FILE = join(__dirname, "checkpoint-authors.json");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monthRange(start: string, end: string): { after: string; before: string }[] {
  const ranges: { after: string; before: string }[] = [];
  const d = new Date(start);
  const endDate = new Date(end);
  while (d < endDate) {
    const after = d.toISOString().slice(0, 10);
    d.setMonth(d.getMonth() + 1);
    const before = d < endDate ? d.toISOString().slice(0, 10) : end;
    ranges.push({ after, before });
  }
  return ranges;
}

function isBot(author: string): boolean {
  return EXCLUDED_AUTHORS.has(author) || BOT_PATTERN.test(author);
}

interface Checkpoint {
  completedMonths: Record<string, string[]>; // sub -> list of completed "after" dates
  authors: string[];
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }
  return { completedMonths: {}, authors: [] };
}

function saveCheckpoint(cp: Checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
}

async function fetchAuthors(subreddit: string, after: string, before: string): Promise<string[]> {
  const authors: string[] = [];
  // Use epoch seconds for precise cursor advancement; start from date string
  let cursorEpoch = Math.floor(new Date(after).getTime() / 1000);
  const beforeEpoch = Math.floor(new Date(before).getTime() / 1000);
  let retries = 0;
  const MAX_RETRIES = 3;

  while (true) {
    const url = `${API_BASE}/comments/search?subreddit=${subreddit}&limit=100&sort=asc&after=${cursorEpoch}&before=${beforeEpoch}&fields=author,created_utc`;
    console.log(`  Fetching: ${subreddit} ${new Date(cursorEpoch * 1000).toISOString().slice(0, 10)} -> ${before}`);

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      retries++;
      console.error(`  Timeout/network error (attempt ${retries}/${MAX_RETRIES}): ${e}`);
      if (retries >= MAX_RETRIES) {
        console.error(`  Skipping this range after ${MAX_RETRIES} failures`);
        break;
      }
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      retries++;
      console.error(`  HTTP ${res.status} (attempt ${retries}/${MAX_RETRIES})`);
      if (retries >= MAX_RETRIES) {
        console.error(`  Skipping this range after ${MAX_RETRIES} failures`);
        break;
      }
      await sleep(1000);
      continue;
    }
    retries = 0;

    const json = await res.json() as { data: { author: string; created_utc: number }[] };
    const data = json.data;

    if (!data || data.length === 0) break;

    for (const comment of data) {
      if (!isBot(comment.author)) {
        authors.push(comment.author);
      }
    }

    // If we got fewer than 100, we've exhausted this range
    if (data.length < 100) break;

    // Advance cursor past the last result using exact epoch timestamp
    const lastUtc = data[data.length - 1].created_utc;
    if (lastUtc <= cursorEpoch) {
      // Safety: if cursor didn't advance, bump by 1 second to avoid infinite loop
      cursorEpoch = cursorEpoch + 1;
    } else {
      cursorEpoch = lastUtc;
    }

    await sleep(DELAY_MS);
  }

  return authors;
}

async function main() {
  const checkpoint = loadCheckpoint();
  const allAuthors = new Set<string>(checkpoint.authors);

  for (const sub of SEED_SUBS) {
    console.log(`\nCollecting authors from r/${sub}...`);
    const months = monthRange(START_DATE, END_DATE);
    const completedForSub = new Set(checkpoint.completedMonths[sub] || []);

    for (const { after, before } of months) {
      if (completedForSub.has(after)) {
        console.log(`  Skipping ${after} (already completed)`);
        continue;
      }

      const authors = await fetchAuthors(sub, after, before);
      authors.forEach((a) => allAuthors.add(a));

      // Update checkpoint
      if (!checkpoint.completedMonths[sub]) checkpoint.completedMonths[sub] = [];
      checkpoint.completedMonths[sub].push(after);
      checkpoint.authors = [...allAuthors];
      saveCheckpoint(checkpoint);

      console.log(`  ${after}: found ${authors.length} comments, ${allAuthors.size} unique authors total`);
      await sleep(DELAY_MS);
    }
  }

  const result = [...allAuthors];
  writeFileSync(join(__dirname, "authors.json"), JSON.stringify(result, null, 2));
  console.log(`\nDone! ${result.length} unique authors saved to authors.json`);
}

main().catch(console.error);
