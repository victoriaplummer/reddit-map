/**
 * Step 3: Compute Jaccard similarity between subreddits.
 * Ports the algorithm from scripts/index.js.
 * Output: results.json — array of { name, related: RelatedSub[], commenterCount, sizeBucket }
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Interaction {
  author: string;
  subreddit: string;
  count: number;
}

interface RelatedSub {
  sub: string;
  score: number;   // Jaccard similarity (0–1)
  shared: number;  // # of shared commenters
}

interface SimilarityResult {
  name: string;
  related: RelatedSub[];
  commenterCount: number;
  sizeBucket: number;
}

function main() {
  const interactionsPath = join(__dirname, "interactions.json");
  if (!existsSync(interactionsPath)) {
    console.error("interactions.json not found. Run 02-collect-interactions.ts first.");
    process.exit(1);
  }

  const interactions: Interaction[] = JSON.parse(readFileSync(interactionsPath, "utf-8"));
  console.log(`Loaded ${interactions.length} interactions`);

  // Group interactions by author
  const authorSubs = new Map<string, Map<string, number>>();
  for (const { author, subreddit, count } of interactions) {
    if (!authorSubs.has(author)) authorSubs.set(author, new Map());
    const subs = authorSubs.get(author)!;
    subs.set(subreddit, (subs.get(subreddit) || 0) + count);
  }

  console.log(`${authorSubs.size} unique authors`);

  // Count unique commenters per subreddit
  const commentersCount = new Map<string, number>();
  for (const [, subs] of authorSubs) {
    for (const sub of subs.keys()) {
      commentersCount.set(sub, (commentersCount.get(sub) || 0) + 1);
    }
  }

  console.log(`${commentersCount.size} unique subreddits`);

  // Build co-occurrence counts (shared commenters between each pair of subreddits)
  const coOccurrence = new Map<string, Map<string, number>>();

  function getOrCreate(sub: string): Map<string, number> {
    let m = coOccurrence.get(sub);
    if (!m) {
      m = new Map();
      coOccurrence.set(sub, m);
    }
    return m;
  }

  let authorIdx = 0;
  for (const [, subs] of authorSubs) {
    authorIdx++;
    if (authorIdx % 1000 === 0) {
      console.log(`Processing author ${authorIdx}/${authorSubs.size}`);
    }

    // Skip authors active in too many subs (likely bots or power users that add noise)
    if (subs.size > 200) continue;
    // Skip authors in only 1 sub (no co-occurrence to record)
    if (subs.size < 2) continue;

    const subList = [...subs.keys()];
    for (let i = 0; i < subList.length - 1; i++) {
      for (let j = i + 1; j < subList.length; j++) {
        const a = subList[i];
        const b = subList[j];

        const mapA = getOrCreate(a);
        mapA.set(b, (mapA.get(b) || 0) + 1);

        const mapB = getOrCreate(b);
        mapB.set(a, (mapB.get(a) || 0) + 1);
      }
    }
  }

  console.log(`Co-occurrence computed for ${coOccurrence.size} subreddits`);

  // Compute Jaccard similarity and filter
  const results: SimilarityResult[] = [];

  for (const [subA, neighbors] of coOccurrence) {
    const countA = commentersCount.get(subA) || 0;
    if (countA < 3) continue; // Skip tiny subs

    const similarities: { sub: string; score: number; shared: number }[] = [];

    for (const [subB, sharedCount] of neighbors) {
      const countB = commentersCount.get(subB) || 0;
      if (countB < 3) continue;

      // Jaccard similarity: |A ∩ B| / |A ∪ B|
      const jaccard = sharedCount / (countA + countB - sharedCount);
      similarities.push({ sub: subB, score: jaccard, shared: sharedCount });
    }

    // Sort by score descending, take top 100
    similarities.sort((a, b) => b.score - a.score);
    const top100 = similarities.slice(0, 100);

    if (top100.length === 0) continue;

    // Apply median + stdDev threshold (from original scripts/index.js)
    let mean = 0;
    for (const x of top100) mean += x.score;
    mean /= top100.length;

    let variance = 0;
    for (const x of top100) variance += (x.score - mean) ** 2;
    variance /= top100.length;
    const stdDev = Math.sqrt(variance);

    const medianIndex = Math.floor(top100.length / 2);
    const median = top100[medianIndex].score;

    const filtered: RelatedSub[] = [];
    for (const sim of top100) {
      if (sim.score - median > stdDev) {
        filtered.push({ sub: sim.sub, score: sim.score, shared: sim.shared });
      } else {
        break; // Array is sorted, nothing interesting left
      }
    }

    if (filtered.length === 0) continue;

    // Size bucket: log scale (matches original)
    const sizeBucket = Math.max(0, Math.round(Math.log(countA)) - 2);

    // Index 0 = self (parent), rest = related subs sorted by similarity
    results.push({
      name: subA,
      related: [{ sub: subA, score: 1, shared: countA }, ...filtered],
      commenterCount: countA,
      sizeBucket,
    });
  }

  console.log(`${results.length} subreddits with related subs`);

  // Find max size bucket for normalization info
  const maxBucket = Math.max(...results.map((r) => r.sizeBucket));
  console.log(`Max size bucket: ${maxBucket}`);

  writeFileSync(join(__dirname, "results.json"), JSON.stringify(results, null, 2));
  console.log("Saved results.json");

  // Print some stats
  const airtable = results.find((r) => r.name === "Airtable");
  if (airtable) {
    console.log(`\nAirtable related (${airtable.related.length}):`);
    airtable.related.slice(0, 6).forEach((r) =>
      console.log(`  ${r.sub}: ${(r.score * 100).toFixed(1)}% similar, ${r.shared} shared`)
    );
  }
  const aiAgents = results.find((r) => r.name === "AI_Agents");
  if (aiAgents) {
    console.log(`AI_Agents related (${aiAgents.related.length}):`);
    aiAgents.related.slice(0, 6).forEach((r) =>
      console.log(`  ${r.sub}: ${(r.score * 100).toFixed(1)}% similar, ${r.shared} shared`)
    );
  }
}

main();
