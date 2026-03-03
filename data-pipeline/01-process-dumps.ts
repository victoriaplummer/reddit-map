/**
 * Process Arctic Shift comment dumps (RC_*.zst files) locally.
 * Replaces the API-based 01-collect-authors and 02-collect-interactions scripts.
 *
 * Pass 1: Stream all dumps, collect authors who commented in seed subs.
 * Pass 2: Stream all dumps, for those authors collect (author, subreddit) counts.
 *
 * Usage: bun 01-process-dumps.ts /path/to/dumps/
 *
 * The dumps directory should contain RC_YYYY-MM.zst files downloaded from:
 * https://github.com/ArthurHeitmann/arctic_shift/releases
 */

import { writeFileSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createInterface } from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEED_SUBS = new Set(["airtable", "ai_agents"]);
const BOT_PATTERN = /bot$/i;
const EXCLUDED_AUTHORS = new Set(["[deleted]", "AutoModerator"]);
const CHECKPOINT_FILE = join(__dirname, "checkpoint-dumps.json");

interface Checkpoint {
  pass: number;
  completedFiles: string[];
  authors?: string[];
  interactions?: { author: string; subreddit: string; count: number }[];
}

function loadCheckpoint(): Checkpoint {
  if (existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }
  return { pass: 1, completedFiles: [] };
}

function saveCheckpoint(cp: Checkpoint) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
}

function isBot(author: string): boolean {
  return EXCLUDED_AUTHORS.has(author) || BOT_PATTERN.test(author);
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/**
 * Stream a .zst file line by line, calling handler for each parsed JSON comment.
 * Uses zstd CLI for decompression (streaming, constant memory).
 */
async function streamZstFile(
  filePath: string,
  handler: (comment: { author: string; subreddit: string }) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("zstd", ["-d", "--stdout", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    let lines = 0;
    let errors = 0;

    rl.on("line", (line) => {
      lines++;
      if (lines % 5_000_000 === 0) {
        console.log(`    ${formatCount(lines)} lines processed...`);
      }
      try {
        // Fast path: extract only author and subreddit without full JSON parse
        const authorMatch = line.match(/"author"\s*:\s*"([^"]+)"/);
        const subMatch = line.match(/"subreddit"\s*:\s*"([^"]+)"/);
        if (authorMatch && subMatch) {
          handler({ author: authorMatch[1], subreddit: subMatch[1] });
        }
      } catch {
        errors++;
      }
    });

    rl.on("close", () => {
      if (errors > 0) console.log(`    (${errors} parse errors skipped)`);
      resolve(lines);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`    zstd: ${msg}`);
    });

    proc.on("error", reject);
  });
}

async function main() {
  const dumpsDir = process.argv[2];
  if (!dumpsDir || !existsSync(dumpsDir)) {
    console.error("Usage: bun 01-process-dumps.ts /path/to/dumps/");
    console.error("  Directory should contain RC_YYYY-MM.zst files");
    process.exit(1);
  }

  // Find all RC_*.zst files
  const allFiles = readdirSync(dumpsDir)
    .filter((f) => f.startsWith("RC_") && f.endsWith(".zst"))
    .sort();

  if (allFiles.length === 0) {
    console.error(`No RC_*.zst files found in ${dumpsDir}`);
    process.exit(1);
  }

  console.log(`Found ${allFiles.length} dump files in ${dumpsDir}\n`);

  const checkpoint = loadCheckpoint();

  // Save on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n\nCaught Ctrl+C — saving checkpoint...");
    saveCheckpoint(checkpoint);
    console.log("Saved.");
    process.exit(0);
  });

  // ── PASS 1: Collect seed sub authors ──
  if (checkpoint.pass === 1) {
    const seedAuthors = new Set<string>(checkpoint.authors || []);
    const completedSet = new Set(checkpoint.completedFiles);
    const startTime = Date.now();

    console.log("═══ Pass 1: Finding authors in seed subreddits ═══\n");
    console.log(`  Seed subs: ${[...SEED_SUBS].join(", ")}`);
    console.log(`  Already found: ${seedAuthors.size} authors from ${completedSet.size} files\n`);

    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      if (completedSet.has(file)) {
        console.log(`  [${i + 1}/${allFiles.length}] ${file} — skipped (done)`);
        continue;
      }

      console.log(`  [${i + 1}/${allFiles.length}] ${file}`);
      const filePath = join(dumpsDir, file);

      const lines = await streamZstFile(filePath, (comment) => {
        if (
          SEED_SUBS.has(comment.subreddit.toLowerCase()) &&
          !isBot(comment.author)
        ) {
          seedAuthors.add(comment.author);
        }
      });

      completedSet.add(file);
      checkpoint.completedFiles.push(file);
      checkpoint.authors = [...seedAuthors];
      saveCheckpoint(checkpoint);

      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`    ${formatCount(lines)} lines | ${seedAuthors.size} authors found | ${formatTime(elapsed)} elapsed\n`);
    }

    console.log(`\nPass 1 complete: ${seedAuthors.size} unique authors\n`);

    // Save authors.json for compatibility
    writeFileSync(join(__dirname, "authors.json"), JSON.stringify([...seedAuthors], null, 2));

    // Advance to pass 2
    checkpoint.pass = 2;
    checkpoint.completedFiles = [];
    saveCheckpoint(checkpoint);
  }

  // ── PASS 2: Collect all activity for seed authors ──
  if (checkpoint.pass === 2) {
    const seedAuthors = new Set<string>(
      checkpoint.authors || JSON.parse(readFileSync(join(__dirname, "authors.json"), "utf-8"))
    );

    // Build interaction counts as a map: "author\tsubreddit" -> count
    const counts = new Map<string, number>();
    if (checkpoint.interactions) {
      for (const { author, subreddit, count } of checkpoint.interactions) {
        counts.set(`${author}\t${subreddit}`, count);
      }
    }

    const completedSet = new Set(checkpoint.completedFiles);
    const startTime = Date.now();

    console.log("═══ Pass 2: Collecting subreddit activity for seed authors ═══\n");
    console.log(`  Tracking ${seedAuthors.size} authors`);
    console.log(`  Resuming from ${completedSet.size} completed files\n`);

    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      if (completedSet.has(file)) {
        console.log(`  [${i + 1}/${allFiles.length}] ${file} — skipped (done)`);
        continue;
      }

      console.log(`  [${i + 1}/${allFiles.length}] ${file}`);
      const filePath = join(dumpsDir, file);
      let matchedComments = 0;

      const lines = await streamZstFile(filePath, (comment) => {
        if (seedAuthors.has(comment.author)) {
          const key = `${comment.author}\t${comment.subreddit}`;
          counts.set(key, (counts.get(key) || 0) + 1);
          matchedComments++;
        }
      });

      completedSet.add(file);
      checkpoint.completedFiles.push(file);

      // Convert counts map to array for checkpoint
      const interactionsArray: { author: string; subreddit: string; count: number }[] = [];
      for (const [key, count] of counts) {
        const [author, subreddit] = key.split("\t");
        interactionsArray.push({ author, subreddit, count });
      }
      checkpoint.interactions = interactionsArray;
      saveCheckpoint(checkpoint);

      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`    ${formatCount(lines)} lines | ${formatCount(matchedComments)} matched | ${formatCount(counts.size)} unique pairs | ${formatTime(elapsed)} elapsed\n`);
    }

    // Write final output
    const interactions: { author: string; subreddit: string; count: number }[] = [];
    for (const [key, count] of counts) {
      const [author, subreddit] = key.split("\t");
      interactions.push({ author, subreddit, count });
    }

    writeFileSync(join(__dirname, "interactions.json"), JSON.stringify(interactions, null, 2));
    console.log(`\nDone! ${interactions.length} interactions saved to interactions.json`);
  }
}

main().catch(console.error);
