import { Elysia, t } from "elysia";
import { extractContacts } from "../lib/openrouter";
import { ContactSchema, ExtractInputSchema } from "../lib/schemas";
import type { AuthService } from "../auth/service";
import { requireAuth } from "../auth/guard";

export function extractRoutes(auth: AuthService) {
  return new Elysia({ prefix: "/api/extract" })
    .onBeforeHandle(requireAuth(auth))
    .post(
      "/",
      async ({ body, set }) => {
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
        },
      }
    );
}
