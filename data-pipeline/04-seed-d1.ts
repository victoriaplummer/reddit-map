/**
 * Step 4: Seed D1 database with computed similarity results.
 * Generates SQL insert statements and executes them via wrangler d1 execute.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Result {
  name: string;
  related: string[];
  commenterCount: number;
  sizeBucket: number;
}

const BATCH_SIZE = 100;
const DB_NAME = "sayit";

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

function main() {
  const resultsPath = join(__dirname, "results.json");
  if (!existsSync(resultsPath)) {
    console.error("results.json not found. Run 03-compute-similarity.ts first.");
    process.exit(1);
  }

  const results: Result[] = JSON.parse(readFileSync(resultsPath, "utf-8"));
  console.log(`Loaded ${results.length} subreddit results`);

  // Generate SQL batches
  const batches: string[] = [];
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((r) => {
        const name = escapeSql(r.name);
        const nameLower = escapeSql(r.name.toLowerCase());
        const related = escapeSql(JSON.stringify(r.related));
        return `('${name}', '${nameLower}', '${related}', ${r.commenterCount}, ${r.sizeBucket})`;
      })
      .join(",\n  ");

    const sql = `INSERT OR REPLACE INTO subreddits (name, name_lower, related, commenter_count, size_bucket) VALUES\n  ${values};`;
    batches.push(sql);
  }

  console.log(`Generated ${batches.length} batches`);

  // Write each batch to a temp file and execute
  for (let i = 0; i < batches.length; i++) {
    const sqlFile = join(__dirname, `_batch_${i}.sql`);
    writeFileSync(sqlFile, batches[i]);

    console.log(`Executing batch ${i + 1}/${batches.length}...`);
    try {
      execSync(`wrangler d1 execute ${DB_NAME} --file=${sqlFile} --remote`, {
        cwd: "../worker",
        stdio: "inherit",
      });
    } catch (e) {
      console.error(`Batch ${i + 1} failed:`, e);
      // Clean up temp file even on error
      try { unlinkSync(sqlFile); } catch { /* ignore */ }
      process.exit(1);
    }

    // Clean up temp file
    unlinkSync(sqlFile);
  }

  console.log("\nDone! All data seeded to D1.");
}

main();
