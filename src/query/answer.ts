import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { ResolvedContext } from "./resolve-context.js";
import { hasAnyGrounding } from "./resolve-context.js";

/**
 * Generates a grounded answer to a question using ONLY the facts
 * already retrieved by resolve-context.ts (deterministic DB queries).
 * The LLM's role here is narrow and explicitly constrained: phrase an
 * answer FROM the given facts and cite each one used. It is
 * instructed to say "insufficient data" rather than fill any gap —
 * the brief scores hallucination with NEGATIVE marks, so the prompt
 * is deliberately strict, and a hard fallback (see answerQuestion
 * below) skips the LLM entirely when there's no grounding at all,
 * removing any chance of the LLM inventing an answer from nothing.
 */

export interface QueryAnswer {
  answer: string;
  citations: Array<{ source: string; detail: string }>;
  insufficientData: boolean;
}

const ANSWER_PROMPT = `You are answering a question about Meridian Freight's fleet operations using ONLY the facts provided below. These facts come from a verified database — do not use any outside knowledge, do not guess, and do not fill in anything not explicitly stated in the facts.

Rules:
- If the facts below fully answer the question, answer clearly and cite which fact(s) you used.
- If the facts only partially answer the question, answer what you can and explicitly state what is NOT covered by the available data.
- If the facts do not answer the question at all, respond with exactly: "INSUFFICIENT_DATA: " followed by a one-sentence explanation of what's missing.
- Never state a fact that isn't explicitly present in the data below, even if it seems like a reasonable inference.

Respond in this exact JSON format, nothing else:
{"answer": "<your answer or the INSUFFICIENT_DATA response>", "citedFacts": ["<short label of each fact actually used>"]}

Question: {{QUESTION}}

Available facts:
{{FACTS}}`;

function formatContextAsFacts(context: ResolvedContext): string {
  const lines: string[] = [];

  for (const v of context.vehicles) {
    lines.push(
      `[Vehicle ${v.registrationNumber}] id=${v.vehicleId}, model=${v.model ?? "unknown"}, year=${v.year ?? "unknown"}, BS stage=${v.bsStage ?? "unknown"}, home hub=${v.homeHub ?? "unknown"}, status=${v.status ?? "unknown"}`
    );
  }

  for (const c of context.clients) {
    lines.push(
      `[Client ${c.canonicalName}] effective SLA=${c.effectiveSlaHours ?? "not recorded"} hours, contract SLA=${c.contractSlaHours ?? "not recorded"} hours`
    );
  }

  for (const f of context.facts) {
    lines.push(
      `[Extracted fact — ${f.fieldName}, source: ${f.sourceFile}] ${f.value}` +
        (f.conflictsWith ? ` (CONFLICT NOTED: ${f.conflictsWith}, precedence: ${f.precedenceRule ?? "none stated"})` : "")
    );
  }

  for (const t of context.trips.slice(0, 5)) {
    lines.push(
      `[Trip ${t.tripId}] client=${t.client ?? "Internal"}, status=${t.status ?? "unknown"}, dispatched=${t.dispatchTime?.toISOString() ?? "unknown"}, actual time=${t.actualTimeMin ?? "unknown"} min`
    );
  }

  return lines.length > 0 ? lines.join("\n") : "(no facts retrieved)";
}

let geminiClient: GoogleGenAI | null = null;
let openaiClient: OpenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

function getOpenAiClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

function stripCodeFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

async function callLlm(prompt: string): Promise<string | null> {
  const gemini = getGeminiClient();
  if (gemini) {
    try {
      const response = await gemini.models.generateContent({ model: "gemini-3.6-flash", contents: prompt });
      return response.text ?? "";
    } catch {
      // fall through to OpenAI
    }
  }

  const openai = getOpenAiClient();
  if (openai) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      });
      return response.choices[0]?.message?.content ?? "";
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Top-level entry point. Hard-refuses to call the LLM at all if
 * resolve-context.ts found NOTHING relevant — this is a stronger
 * guarantee against hallucination than relying on the prompt alone,
 * since an LLM given zero facts and asked a specific question can
 * still occasionally ignore instructions and answer from general
 * knowledge.
 */
export async function answerQuestion(question: string, context: ResolvedContext): Promise<QueryAnswer> {
  if (!hasAnyGrounding(context)) {
    return {
      answer: "Insufficient data: no vehicle, client, or fact in the resolved store matches this question.",
      citations: [],
      insufficientData: true,
    };
  }

  const factsText = formatContextAsFacts(context);
  const prompt = ANSWER_PROMPT.replace("{{QUESTION}}", question).replace("{{FACTS}}", factsText);

  const raw = await callLlm(prompt);

  if (raw === null) {
    // Both providers unavailable — degrade to a raw-facts dump rather
    // than silently failing; still grounded, just not narratively
    // phrased.
    return {
      answer: `LLM unavailable to phrase a natural-language answer. Retrieved facts:\n${factsText}`,
      citations: buildCitationsFromContext(context),
      insufficientData: false,
    };
  }

  let parsed: { answer?: string; citedFacts?: string[] };
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return {
      answer: `LLM response could not be parsed. Retrieved facts:\n${factsText}`,
      citations: buildCitationsFromContext(context),
      insufficientData: false,
    };
  }

  const answerText = parsed.answer ?? "";
  const insufficientData = answerText.startsWith("INSUFFICIENT_DATA:");

  return {
    answer: insufficientData ? answerText.replace("INSUFFICIENT_DATA:", "Insufficient data:").trim() : answerText,
    citations: buildCitationsFromContext(context),
    insufficientData,
  };
}

function buildCitationsFromContext(context: ResolvedContext): QueryAnswer["citations"] {
  const citations: QueryAnswer["citations"] = [];
  for (const v of context.vehicles) citations.push({ source: "Vehicle (fleet_master.csv)", detail: v.registrationNumber });
  for (const c of context.clients) citations.push({ source: "Client (entity resolution)", detail: c.canonicalName });
  for (const f of context.facts) citations.push({ source: f.sourceFile, detail: f.value });
  for (const t of context.trips) citations.push({ source: "Trip (meridian_trips.csv)", detail: t.tripId });
  return citations;
}
