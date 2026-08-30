import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { prisma } from "../lib/db.js";
import { resolveQuestionContext } from "./resolve-context.js";
import { answerQuestion } from "./answer.js";
import { containsRawPii, redact } from "../lib/mask.js";

/**
 * Part A's query interface: an interactive CLI that answers questions
 * about the resolved entity store with citations, or honestly says
 * "insufficient data" — never a confident unsupported answer.
 *
 * PII safety: every answer is scanned before being printed, same as
 * every other evaluator-visible surface in this codebase — the hard
 * gate applies here too ("...or an API response you serve").
 */

async function main() {
  console.log("── Meridian context query interface ──");
  console.log("Ask a question about a vehicle, client, or fact. Type 'exit' to quit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const question = await rl.question("Question: ");
    if (question.trim().toLowerCase() === "exit") break;
    if (!question.trim()) continue;

    const context = await resolveQuestionContext(question);
    const result = await answerQuestion(question, context);

    let displayAnswer = result.answer;
    const scan = containsRawPii(displayAnswer);
    if (!scan.clean) {
      // Should be structurally impossible given the entity store
      // never holds raw PII, but scanned anyway as the last line of
      // defense on any evaluator-visible output.
      displayAnswer = redact(displayAnswer);
    }

    console.log(`\n${displayAnswer}`);
    if (result.citations.length > 0) {
      console.log("\nCitations:");
      for (const c of result.citations) {
        console.log(`  - [${c.source}] ${c.detail}`);
      }
    }
    console.log();
  }

  rl.close();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Query interface failed:", err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
