import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { extractContacts } from "./openrouter";

const PORT: number = 4000;

const app = new Elysia()
  .use(cors({ origin: "http://localhost:5173" }))
  .get("/", () => "Hello Elysia")
  .post(
    "/api/extract",
    async ({ body, set }) => {
      const count =
        body.type === "excel" ? body.rows.length : body.text.length;
      console.log(`[extract] type=${body.type}, count=${count}`);
      try {
        const contacts = await extractContacts(body);
        console.log(`[extract] returned ${contacts.length} contacts`);
        return contacts;
      } catch (e) {
        const message = (e as Error).message;
        console.error(`[extract] llm_failed: ${message}`);
        set.status = 502;
        return { error: "llm_failed", message };
      }
    },
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
    }
  )
  .listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
