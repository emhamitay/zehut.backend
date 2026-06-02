import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { extractContacts } from "./lib/openrouter";

const PORT: number = 4000;

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
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
