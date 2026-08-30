import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractFactsFromDocument } from "./extract.js";
import { persistExtractedFacts } from "./persist.js";

/**
 * Runs the LLM-assisted extraction pass over the interview transcript
 * and every email thread in the candidate bundle, persisting the
 * results as ResolvedFact rows.
 *
 * Requires GEMINI_API_KEY to be set. If it isn't, this script exits
 * with a clear message rather than a stack trace — the structured
 * CSV ingestion (npm run ingest) already works independently of this.
 */
async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is not set in .env — get a free key at https://aistudio.google.com/ " +
        "and add it to .env before running this script."
    );
    process.exitCode = 1;
    return;
  }

  const bundlePath = process.env.CANDIDATE_BUNDLE_PATH ?? "../candidate_bundle";
  let totalStored = 0;
  let totalConflicts = 0;
  let totalFailed = 0;

  console.log("── Knowledge extraction: interview transcript + email threads ──\n");

  // Interview transcript first — it's the single richest source.
  const transcriptPath = join(bundlePath, "dispatcher_interview.txt");
  const transcriptText = readFileSync(transcriptPath, "utf-8");
  const transcriptResult = await extractFactsFromDocument(
    transcriptText,
    "dispatcher_interview.txt"
  );

  if (transcriptResult.validation.ok) {
    const { stored, conflictsDetected } = await persistExtractedFacts(
      transcriptResult.validation.facts,
      "dispatcher_interview.txt"
    );
    totalStored += stored;
    totalConflicts += conflictsDetected;
    console.log(`dispatcher_interview.txt: ${stored} facts extracted`);
  } else {
    totalFailed += 1;
    console.log(`dispatcher_interview.txt: extraction failed — ${transcriptResult.validation.reason}`);
  }

  // Email threads
  const emailsDir = join(bundlePath, "emails");
  const emailFiles = readdirSync(emailsDir).filter((f) => f.endsWith(".txt"));

  for (const file of emailFiles) {
    const text = readFileSync(join(emailsDir, file), "utf-8");
    const result = await extractFactsFromDocument(text, `emails/${file}`);

    if (result.validation.ok) {
      const { stored, conflictsDetected } = await persistExtractedFacts(
        result.validation.facts,
        `emails/${file}`
      );
      totalStored += stored;
      totalConflicts += conflictsDetected;
      if (stored > 0) {
        console.log(`emails/${file}: ${stored} fact(s) extracted${conflictsDetected > 0 ? " (conflict detected)" : ""}`);
      }
    } else {
      totalFailed += 1;
      console.log(`emails/${file}: extraction failed — ${result.validation.reason}`);
    }
  }

  console.log(
    `\nDone. ${totalStored} facts stored, ${totalConflicts} conflicts detected, ${totalFailed} sources failed extraction.`
  );
}

main()
  .catch((err) => {
    console.error("Knowledge extraction failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../lib/db.js");
    await prisma.$disconnect();
  });
