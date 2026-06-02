# zehut.backend

Elysia + Bun API with Postgres (via Drizzle) for the Zehut contact-management app.

## Prerequisites

- [Bun](https://bun.sh)
- [Docker](https://www.docker.com/) (for local Postgres)

## Environment

Create a `.env` file (or export in your shell):

```
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
# optional — defaults to the local docker postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zehut
```

## Scripts

| Command | What it does |
| --- | --- |
| `bun run db` | Start the local Postgres container (`docker compose up -d --wait`). Idempotent — safe to run repeatedly. |
| `bun run db:down` | Stop the Postgres container. Data persists in the named volume. |
| `bun run db:push` | Apply the current Drizzle schema directly to the DB. Use this in dev after editing `src/db/schema.ts`. |
| `bun run db:generate` | Generate a new SQL migration file from the current schema. Use when you want a tracked migration. |
| `bun run db:migrate` | Apply pending migrations to the DB. |
| `bun run db:studio` | Open Drizzle Studio to browse the tables. |
| `bun run dev` | Start the API (`http://localhost:4000`) with file watching. |

## First-time setup

```bash
bun install
bun run db          # boots Postgres
bun run db:push     # applies the schema
bun run dev         # starts the API
```

After that, day-to-day you typically only need:

```bash
bun run db          # if the container isn't already up
bun run dev
```

Re-run `bun run db:push` whenever you change `src/db/schema.ts`.

## Switching to a hosted Postgres (Neon, Supabase, etc.)

Set `DATABASE_URL` to the hosted connection string. No schema changes required —
skip `bun run db` and `bun run db:down` since you no longer need the local container.

## Endpoints

- `POST /api/extract` — parse uploaded file content via LLM, returns `Contact[]`.
- `POST /api/persons/commit` — persist contacts; auto-merges by national ID, returns phone conflicts to the client.
- `POST /api/persons/resolve` — apply a client decision (`merge` / `new` / `skip`) for a phone conflict.
