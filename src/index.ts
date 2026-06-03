import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { extractContacts } from "./lib/openrouter";
import { commitContacts } from "./persons/service";
import {
  CommitInputSchema,
  CommitResultSchema,
  ContactSchema,
  ExtractInputSchema,
} from "./lib/schemas";

const PORT: number = 4000;

const app = new Elysia()
  .use(cors({ origin: /^http:\/\/localhost(?::\d+)?$/ }))
  .get("/", () => "Hello Zehut Yehudit Server!")
  .post(
    "/api/extract",
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
        502: t.Object({ error: t.String(), message: t.String() }),
      },
    }
  )
  .post(
    "/api/persons/commit",
    async ({ body, set }) => {
      try {
        const result = await commitContacts(
          body.contacts,
          body.sourceFile ?? null
        );
        console.log(
          `[commit] inserted=${result.inserted.length} ignored=${result.ignored} phoneAdded=${result.phoneAdded.length} alerts=${result.alerts.length}`
        );
        return result;
      } catch (e) {
        const message = (e as Error).message;
        console.error(`[commit] failed: ${message}`);
        set.status = 500;
        return { error: "commit_failed", message };
      }
    },
    {
      body: CommitInputSchema,
      response: {
        200: CommitResultSchema,
        500: t.Object({ error: t.String(), message: t.String() }),
      },
    }
  )
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
