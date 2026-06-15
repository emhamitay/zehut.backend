import { Elysia, t } from "elysia";
import { extractContacts } from "../lib/openrouter";
import { ContactSchema, ExtractInputSchema } from "../lib/schemas";
import type { AuthService } from "../auth/service";
import { requireAuth } from "../auth/guard";

/**
 * Parses the required USE_AI feature flag.
 *
 * Throws (like DATABASE_URL) when the variable is unset or is not a strict
 * boolean, so a misconfigured server fails loudly on startup rather than
 * silently leaking PII (names / phones) to the LLM.
 */
export function parseUseAi(
  env: Record<string, string | undefined> = Bun.env
): boolean {
  const raw = env.USE_AI?.trim().toLowerCase();
  if (!raw) throw new Error("USE_AI is not set (must be 'true' or 'false')");
  if (raw !== "true" && raw !== "false") {
    throw new Error(`USE_AI must be 'true' or 'false', got: ${env.USE_AI}`);
  }
  return raw === "true";
}

export function extractRoutes(auth: AuthService, useAi: boolean = true) {
  return new Elysia({ prefix: "/api/extract" })
    .onBeforeHandle(requireAuth(auth))
    .post(
      "/",
      async ({ body, set }) => {
        // Hard gate: when AI is disabled we never reach OpenRouter, so no PII
        // ever leaves the server. This is the real enforcement — the frontend
        // flag is only a UX hint and can be bypassed.
        if (!useAi) {
          set.status = 503;
          return {
            error: "ai_disabled",
            message: "AI extraction is disabled on this server",
          };
        }
        const count = body.type === "excel" ? body.rows.length : body.text.length;
        console.log(`[extract] type=${body.type}, count=${count}`);
        try {
          const contacts = await extractContacts(body);
          contacts.forEach((contact, index) => {
            console.log(
              `[extract] contact_${index + 1}: ${JSON.stringify(contact)}`
            );
          });
          return contacts;
        } catch (e) {
          const message = (e as Error).message;
          console.error(`[extract] llm_failed: ${message}`);
          set.status = 502;
          return { error: "llm_failed", message };
        }
      },
      {
        body: ExtractInputSchema,
        response: {
          200: t.Array(ContactSchema),
          401: t.Object({ error: t.String() }),
          502: t.Object({ error: t.String(), message: t.String() }),
          503: t.Object({ error: t.String(), message: t.String() }),
        },
      }
    );
}
