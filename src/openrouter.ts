import type { Contact, ExtractInput } from "./types";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

const API_KEY = Bun.env.OPENROUTER_API_KEY;
const MODEL = Bun.env.OPENROUTER_MODEL;
const BASE_URL = Bun.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
if (!MODEL) throw new Error("OPENROUTER_MODEL is not set");

function isContactArray(x: unknown): x is Contact[] {
  if (!Array.isArray(x)) return false;
  for (const item of x) {
    if (!item || typeof item !== "object") return false;
    const c = item as Record<string, unknown>;
    if (!(c.id === null || typeof c.id === "string")) return false;
    if (!(c.fullname === null || typeof c.fullname === "string")) return false;
    if (!Array.isArray(c.phone)) return false;
    if (!c.phone.every((p) => typeof p === "string")) return false;
  }
  return true;
}

export async function extractContacts(input: ExtractInput): Promise<Contact[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:4000",
        "X-Title": "zehut.backend",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
      }),
    });
  } catch (e) {
    throw new Error(`openrouter_network: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`openrouter_http_${res.status}: ${body}`);
  }

  const envelope = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = envelope.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("openrouter_no_content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("llm_bad_json");
  }

  const contacts = (parsed as { contacts?: unknown })?.contacts;
  if (!isContactArray(contacts)) throw new Error("llm_bad_shape");

  return contacts;
}
