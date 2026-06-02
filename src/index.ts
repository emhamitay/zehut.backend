import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";

const PORT: number = 4000;

const app = new Elysia()
  .use(cors({ origin: "http://localhost:5173" }))
  .get("/", () => "Hello Elysia")
  .post(
    "/api/extract",
    ({ body }) => {
      const count =
        body.type === "excel" ? body.rows.length : body.text.length;
      console.log(`[extract] type=${body.type}, count=${count}`);
      return { status: "received", type: body.type, count };
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
