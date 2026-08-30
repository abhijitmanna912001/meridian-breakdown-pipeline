import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  validateExtractionResponse,
  type ExtractionResponse,
  type ExtractionValidationResult,
} from "./schema.js";

/**
 * Thin wrapper around TWO LLM providers for exactly one job: extract
 * structured facts from one unstructured source document (interview
 * transcript excerpt, or one email thread).
 *
 * Gemini (Google AI Studio, free tier) is PRIMARY. OpenAI is
 * FALLBACK, used automatically whenever Gemini fails for any reason
 * — daily quota exhaustion (confirmed in practice: free tier allows
 * as few as 20 requests/day for some models), transient 503
 * overload, or any other error. This directly demonstrates the kind
 * of provider resilience the challenge brief calls for ("APIs that
 * rate limit, fail intermittently... any LLM").
 *
 * Both providers are isolated behind this single function — the rest
 * of the codebase calls extractFactsFromDocument() and never knows
 * or cares which provider actually served the request.
 *
 * This module NEVER decides pipeline behavior. It reads text, returns
 * candidate facts matching ExtractedFactSchema, and validation +
 * conflict resolution happen entirely outside this file.
 */

const EXTRACTION_PROMPT = `You are extracting operational facts from a document belonging to Meridian Freight, a trucking company. The document may be an interview transcript with a dispatcher, or an email thread between Meridian and a client or between internal staff.

Extract every operational RULE or FACT that could affect how the company assigns vehicles, drivers, or handles breakdowns — for example: client SLA commitments, delivery windows, vehicle requirements, seasonal restrictions, driver policies, repair/maintenance rules, or anything that contradicts what a structured database might say (e.g. a claimed vehicle year, a claimed delivery status).

Do NOT extract:
- Personal data (phone numbers, ID numbers, names of individuals) — omit these from your output entirely, do not include them even inside sourceExcerpt.
- Small talk, pleasantries, or anything with no operational meaning.

For each fact you find, return a JSON object with exactly these fields:
- "category": one of CLIENT_SLA, CLIENT_DELIVERY_WINDOW, CLIENT_ROTATION_RULE, CLIENT_VEHICLE_REQUIREMENT, SEASONAL_ROUTE_RESTRICTION, VEHICLE_ELIGIBILITY_RULE, BREAKDOWN_DISPATCH_RULE, DRIVER_RULE, REPAIR_RULE, DATA_CONFLICT, OTHER
- "ruleText": a short, plain-language statement of the rule, in your own words
- "appliesTo": either null, or an object {"type": "CLIENT"|"VEHICLE"|"DRIVER"|"GENERAL", "identifier": "<name or id, omit for GENERAL>"}
- "sourceExcerpt": a short supporting excerpt (under 300 characters), with any personal data already removed
- "possibleConflict": true if this fact appears to contradict what a structured record (fleet database, ticket status) would likely say, otherwise false

Return ONLY a JSON array of these objects, nothing else — no markdown formatting, no explanation, no code fences. If the document contains no relevant operational facts, return an empty array: []

Document:
---
{{DOCUMENT_TEXT}}
---`;

export interface ExtractFactsResult {
  validation: ExtractionValidationResult;
  sourceFile: string;
  provider?: "gemini" | "openai"; // which provider actually served this request
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

/**
 * Strips a common LLM failure mode — wrapping JSON in markdown code
 * fences despite being told not to — before attempting to parse.
 */
function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

// gemini-3.6-flash: current, less-congested than the newly launched
// 3.7-flash. gemini-3.7-flash is a Gemini-side fallback tried before
// giving up on Gemini entirely and moving to OpenAI.
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_FALLBACK_MODEL = "gemini-3.7-flash";
const OPENAI_MODEL = "gpt-4o-mini"; // cheap, capable enough for structured extraction

const MAX_RETRIES = 2; // fewer retries per provider now that a second provider exists
const BASE_DELAY_MS = 2000;

function isRetryableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Transient server-side capacity — worth a short retry.
  return message.includes('"code":503') || message.includes("UNAVAILABLE");
}

function isQuotaExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Daily/rate quota — retrying the SAME provider/model cannot
  // succeed until the quota resets, so this is checked separately
  // and short-circuits straight to the next provider.
  return (
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("GenerateRequestsPerDay") ||
    message.includes("insufficient_quota") ||
    message.includes("rate_limit_exceeded")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryGemini(prompt: string): Promise<string | null> {
  const client = getGeminiClient();
  if (!client) return null; // no key configured — skip straight to OpenAI

  for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.models.generateContent({ model, contents: prompt });
        return response.text ?? "";
      } catch (err) {
        if (isQuotaExhausted(err)) break; // move to next Gemini model, no delay
        if (attempt < MAX_RETRIES && isRetryableError(err)) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        break; // non-retryable — try next Gemini model
      }
    }
  }
  return null; // both Gemini models exhausted/failed
}

async function tryOpenAi(prompt: string): Promise<string | null> {
  const client = getOpenAiClient();
  if (!client) return null; // no key configured

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      });
      return response.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (isQuotaExhausted(err)) return null; // no point retrying
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function extractFactsFromDocument(
  documentText: string,
  sourceFile: string
): Promise<ExtractFactsResult> {
  const prompt = EXTRACTION_PROMPT.replace("{{DOCUMENT_TEXT}}", documentText);

  let rawText: string | null = null;
  let provider: "gemini" | "openai" | undefined;

  rawText = await tryGemini(prompt);
  if (rawText !== null) {
    provider = "gemini";
  } else {
    rawText = await tryOpenAi(prompt);
    if (rawText !== null) provider = "openai";
  }

  if (rawText === null) {
    // Both providers failed — never throw out of this function; the
    // caller quarantines this source the same way a broken ticket
    // record is quarantined, and the pipeline keeps going.
    return {
      sourceFile,
      validation: {
        ok: false,
        reason: "Both Gemini and OpenAI failed or are not configured (check API keys in .env).",
        rawResponse: null,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(rawText));
  } catch {
    return {
      sourceFile,
      provider,
      validation: {
        ok: false,
        reason: `LLM response (via ${provider}) was not valid JSON`,
        rawResponse: rawText,
      },
    };
  }

  return {
    sourceFile,
    provider,
    validation: validateExtractionResponse(parsed),
  };
}

/**
 * Test/offline helper: runs the same validation path as the real
 * client but against a pre-supplied response, so extraction logic
 * downstream of the LLM call can be tested without an API key or
 * network access. Mirrors extractFactsFromDocument's return shape.
 */
export function extractFactsFromMockResponse(
  mockResponse: unknown,
  sourceFile: string
): ExtractFactsResult {
  return {
    sourceFile,
    validation: validateExtractionResponse(mockResponse),
  };
}
