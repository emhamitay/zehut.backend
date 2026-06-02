import { Elysia } from "elysia";

const PORT : number = 4000;

const app = new Elysia().get("/", () => "Hello Elysia").listen(PORT);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
