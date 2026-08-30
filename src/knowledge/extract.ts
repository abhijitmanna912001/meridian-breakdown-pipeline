import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  validateExtractionResponse,
  type ExtractionResponse,
  type ExtractionValidationResult,
} from "./schema.js";

/**
 * Thin wrapper around the Gemini free-tier API for exactly one job:
 * extract structured facts from one unstructured source document
 * (interview transcript excerpt, or one email thread).
 *
 * Deliberately isolated behind this single function — swapping the
 * LLM provider later (e.g. to a paid Anthropic/OpenAI key for harder
 * cases) means changing this file only, nothing that calls it.
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
}

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Copy .env.example to .env and add a free-tier key from https://aistudio.google.com/"
      );
    }
    client = new GoogleGenerativeAI(apiKey);
  }
  return client;
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

export async function extractFactsFromDocument(
  documentText: string,
  sourceFile: string
): Promise<ExtractFactsResult> {
  const model = getClient().getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = EXTRACTION_PROMPT.replace("{{DOCUMENT_TEXT}}", documentText);

  let rawText: string;
  try {
    const response = await model.generateContent(prompt);
    rawText = response.response.text();
  } catch (err) {
    // Network/API failure — never throw out of this function; the
    // caller quarantines this source the same way a broken ticket
    // record is quarantined, and the pipeline keeps going.
    return {
      sourceFile,
      validation: {
        ok: false,
        reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
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
      validation: {
        ok: false,
        reason: "LLM response was not valid JSON",
        rawResponse: rawText,
      },
    };
  }

  return {
    sourceFile,
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
