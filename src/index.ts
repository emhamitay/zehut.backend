import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { extractContacts } from "./lib/openrouter";
import { commitContacts, resolveConflict } from "./persons/service";

const PORT: number = 4000;

const ContactSchema = t.Object({
  id: t.Union([t.String(), t.Null()]),
  fullname: t.Union([t.String(), t.Null()]),
  phone: t.Array(t.String()),
});

const app = new Elysia()
  .use(cors({ origin: "http://localhost:5173" }))
  .get("/", () => "Hello Zehut Yehudit Server!")
  .post(
    "/api/extract",
    async ({ body, set }) => {
      // Log the type and count of items being processed
      const count = body.type === "excel" ? body.rows.length : body.text.length;
      console.log(`[extract] type=${body.type}, count=${count}`);

      // Call the contact extraction function and handle potential errors
      try {
        // Extract contacts using the provided body and log the number of contacts found
        const contacts = await extractContacts(body);
        
        // Log the Contacts found for debugging purposes
        contacts.forEach((contact, index) => {
          console.log(`[extract] contact_${index + 1}: ${JSON.stringify(contact)}`);
        });

        return contacts;
      } catch (e) {
        // Log the error message for debugging purposes
        const message = (e as Error).message;
        console.error(`[extract] llm_failed: ${message}`);
        set.status = 502;
        return { error: "llm_failed", message };
      }
    },
    // Define the expected body schema for validation
    {
      body: t.Union([
        t.Object({
          type: t.Literal("excel"),
          rows: t.Array(t.Record(t.String(), t.Unknown())),
        }),
        t.Object({
          type: t.Literal("docx"),
          text: t.String(),
        }),
      ]),
    },
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
          `[commit] inserted=${result.inserted.length} merged=${result.merged.length} conflicts=${result.conflicts.length}`
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
      body: t.Object({
        contacts: t.Array(ContactSchema),
        sourceFile: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .post(
    "/api/persons/resolve",
    async ({ body, set }) => {
      try {
        const person = await resolveConflict(body);
        return { person };
      } catch (e) {
        const message = (e as Error).message;
        console.error(`[resolve] failed: ${message}`);
        set.status = 500;
        return { error: "resolve_failed", message };
      }
    },
    {
      body: t.Union([
        t.Object({
          action: t.Literal("merge"),
          targetPersonId: t.String(),
          incoming: ContactSchema,
        }),
        t.Object({
          action: t.Literal("new"),
          incoming: ContactSchema,
          sourceFile: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        t.Object({
          action: t.Literal("skip"),
        }),
      ]),
    }
  )
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
