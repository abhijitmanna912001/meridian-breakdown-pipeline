import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractFactsFromDocument } from "./extract.js";
import { persistExtractedFacts } from "./persist.js";
import { prisma } from "../lib/db.js";

/**
 * Runs the LLM-assisted extraction pass over the interview transcript
 * and every email thread in the candidate bundle, persisting the
 * results as ResolvedFact rows.
 *
 * Requires at least one of GEMINI_API_KEY / OPENAI_API_KEY to be set.
 *
 * Idempotent per source document via IngestionRun (sourceFile "know:<path>",
 * a fixed fileHash since content doesn't change): a document is marked
 * processed as soon as extraction SUCCEEDS, even if it yields zero
 * facts — a zero-fact result is a legitimate outcome (not every email
 * contains an operational rule) and must not be indistinguishable from
 * "not yet attempted," or the pipeline would silently re-process it
 * forever without ever showing progress. Only extraction FAILURES
 * (LLM error, invalid JSON, schema validation failure) are left
 * unmarked, so a genuinely broken source is retried on the next run.
 */

const KNOWLEDGE_RUN_HASH = "v1"; // bump this to force full re-extraction after a prompt/schema change

async function alreadyExtracted(sourceFile: string): Promise<boolean> {
  const existing = await prisma.ingestionRun.findUnique({
    where: { sourceFile_fileHash: { sourceFile: `knowledge:${sourceFile}`, fileHash: KNOWLEDGE_RUN_HASH } },
  });
  return existing !== null;
}

async function markExtracted(sourceFile: string, factCount: number): Promise<void> {
  await prisma.ingestionRun.create({
    data: {
      sourceFile: `knowledge:${sourceFile}`,
      fileHash: KNOWLEDGE_RUN_HASH,
      ticketCount: factCount,
      duplicateCount: 0,
      quarantineCount: 0,
      completedAt: new Date(),
    },
  });
}

interface ProcessOutcome {
  status: "skipped" | "stored" | "failed";
  stored: number;
  conflicts: number;
  reason?: string;
}

async function processSource(text: string, sourceFile: string): Promise<ProcessOutcome> {
  if (await alreadyExtracted(sourceFile)) {
    return { status: "skipped", stored: 0, conflicts: 0 };
  }

  const result = await extractFactsFromDocument(text, sourceFile);

  if (!result.validation.ok) {
    // Left unmarked deliberately — a genuine failure should be
    // retried on the next run, not treated as permanently done.
    return { status: "failed", stored: 0, conflicts: 0, reason: result.validation.reason };
  }

  const { stored, conflictsDetected } = await persistExtractedFacts(
    result.validation.facts,
    sourceFile
  );
  await markExtracted(sourceFile, stored);

  return { status: "stored", stored, conflicts: conflictsDetected };
}

async function main() {
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      "Neither GEMINI_API_KEY nor OPENAI_API_KEY is set in .env — at least one is required. " +
        "Get a free Gemini key at https://aistudio.google.com/, or an OpenAI key at https://platform.openai.com/."
    );
    process.exitCode = 1;
    return;
  }

  const bundlePath = process.env.CANDIDATE_BUNDLE_PATH ?? "../candidate_bundle";
  let totalStored = 0;
  let totalConflicts = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalZeroFact = 0;

  console.log("── Knowledge extraction: interview transcript + email threads ──\n");

  // Interview transcript first — it's the single richest source.
  const transcriptSourceFile = "dispatcher_interview.txt";
  const transcriptText = readFileSync(join(bundlePath, transcriptSourceFile), "utf-8");
  const transcriptOutcome = await processSource(transcriptText, transcriptSourceFile);

  if (transcriptOutcome.status === "skipped") {
    totalSkipped += 1;
    console.log(`${transcriptSourceFile}: already extracted, skipped (idempotent)`);
  } else if (transcriptOutcome.status === "stored") {
    totalStored += transcriptOutcome.stored;
    totalConflicts += transcriptOutcome.conflicts;
    if (transcriptOutcome.stored === 0) totalZeroFact += 1;
    console.log(`${transcriptSourceFile}: ${transcriptOutcome.stored} facts extracted`);
  } else {
    totalFailed += 1;
    console.log(`${transcriptSourceFile}: extraction failed — ${transcriptOutcome.reason}`);
  }

  // Email threads
  const emailsDir = join(bundlePath, "emails");
  const emailFiles = readdirSync(emailsDir).filter((f) => f.endsWith(".txt"));

  for (const file of emailFiles) {
    const sourceFile = `emails/${file}`;
    const text = readFileSync(join(emailsDir, file), "utf-8");
    const outcome = await processSource(text, sourceFile);

    if (outcome.status === "skipped") {
      totalSkipped += 1;
      // quiet — printing all previously-done files every run is noisy;
      // summarized in the final count instead
    } else if (outcome.status === "stored") {
      totalStored += outcome.stored;
      totalConflicts += outcome.conflicts;
      if (outcome.stored === 0) {
        totalZeroFact += 1;
        console.log(`${sourceFile}: 0 facts (processed, no operational rule found)`);
      } else {
        console.log(`${sourceFile}: ${outcome.stored} fact(s) extracted${outcome.conflicts > 0 ? " (conflict detected)" : ""}`);
      }
    } else {
      totalFailed += 1;
      console.log(`${sourceFile}: extraction failed — ${outcome.reason}`);
    }
  }

  console.log(
    `\nDone. ${totalStored} facts stored (${totalZeroFact} sources yielded zero, which is a valid outcome), ` +
      `${totalConflicts} conflicts detected, ${totalFailed} sources failed extraction (will retry next run), ` +
      `${totalSkipped} already-processed sources skipped.`
  );
}

main()
  .catch((err) => {
    console.error("Knowledge extraction failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
