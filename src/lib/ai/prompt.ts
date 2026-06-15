import type { ExtractInput } from "../types";

const DEFAULT_SYSTEM_PROMPT = 
`You extract contact records from messy spreadsheet rows or raw document text.

Output MUST be a single JSON object of shape {"contacts": Contact[]}, where each Contact is:
  { "fullname": string | null, "phone": string[] }

No prose. No markdown code fences. JSON only.

Rules per contact:
- fullname:
    * If a full-name field exists (e.g. "שם מלא", "fullname", "name"), use it as-is.
    * If only a first name OR only a last name is present, put that single value as-is.
    * If both first and last are present, join them as "First Last".
    * Otherwise null.
- phone: array of strings. Preserve "+", leading "0", dashes, spaces. If a person has multiple phones, include them all as multiple strings in the same array. Empty array if none.

Other rules:
- One object per person.
- A row containing ONLY a phone number is still a valid contact: {"fullname": null, "phone": ["..."]}.
- Do NOT invent or guess data. If a field is missing, use null (or [] for phone).
- Skip header rows and non-contact prose.
- If nothing is found, return {"contacts": []}.`;

export const SYSTEM_PROMPT: string =
  Bun.env.OPENROUTER_SYSTEM_PROMPT && Bun.env.OPENROUTER_SYSTEM_PROMPT.length > 0
    ? Bun.env.OPENROUTER_SYSTEM_PROMPT
    : DEFAULT_SYSTEM_PROMPT;

export function buildUserMessage(input: ExtractInput): string {
  return input.type === "excel" ? JSON.stringify(input.rows) : input.text;
}
