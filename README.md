# Zehut — Backend

Elysia + Bun API with PostgreSQL (via Drizzle) for the Zehut contact-management app — a system for ingesting, matching, and de-duplicating contact records collected from messy real-world spreadsheets and documents. This repository is the **API server**: a layered, feature-based architecture with JWT authentication, an LLM-assisted extraction pipeline, and a deterministic record-matching engine that never silently merges two people who might be different.

> The companion React client lives in the [Zehut frontend repo](#). *(add link)*

---

## The problem it solves

Organizations frequently collect the same people across many inconsistent sources — Excel exports with different column names, Word documents, and partial records missing an ID, a name, or a phone. Importing those naively produces duplicates and conflicting records.

Zehut handles the full lifecycle:

- **Extract** structured contacts (`{ id, fullname, phone[] }`) from raw Excel rows or document text.
- **Match** each incoming contact against the existing database by national ID, phone, and name.
- **Decide** automatically whether to *insert*, *enrich* (add phones / backfill a missing ID), or *flag for human review* — using conservative rules that never merge two records unless it can prove they are the same person.
- **Track** every change in an audit trail, support reviewed manual merges, and generate printable contact pages per season while warning about suspected cross-page duplicates.

---

## Architecture

The code is organized **package-by-feature** rather than layer-by-type. Each feature folder owns its routes, service, and (where relevant) repository:

```
src/
├── app.ts              # Elysia app assembly + dependency wiring
├── index.ts            # Entry point: build services, bootstrap admin, listen
├── auth/               # JWT issuing/verification, route guards, login/setup
├── users/              # User CRUD + password hashing
├── persons/            # Contact ingest, the matching engine, update/merge/search
├── contact-pages/      # Per-season page generation + duplicate warnings
├── extract/            # LLM extraction endpoint
├── lib/                # OpenRouter client, prompts, shared schemas & types
└── db/                 # Drizzle schema + client
```

Three layers, strictly separated:

| Layer | Responsibility | Knows about |
|-------|----------------|-------------|
| **Routes** (Elysia) | HTTP, request/response validation, auth guards. Thin. | HTTP + services |
| **Service** | Domain logic. Framework-agnostic. | Repositories only |
| **Repository** | All database access via Drizzle. The only layer that touches SQL. | The database |

**Dependency injection via factory functions** — `makeAuthService({ secret })`, `makeUserService(repo)`, `makeRepo(db)`. Nothing reaches for a global; collaborators are passed in. This makes the system trivially testable: the suite injects a throwaway test database and exercises the *real* logic with no mocks.

---

## The matching engine

The heart of the system is [`persons/match.ts`](src/persons/match.ts). Given an incoming contact and the candidate records that match it by ID, phone, or name, `decide()` returns one of: `insert`, `noop`, `add_phones`, `backfill_id_and_add_phones`, or `alert_only`.

The central design decision is **tri-state field comparison** — each field compares as `match`, `mismatch`, or `unknown`. A missing value is *unknown*, never a *mismatch*, so absent data can never fabricate a conflict. Two records are only ruled "definitely different people" when **both** carry an ID and those IDs differ.

When a conflict can't be auto-resolved, the engine raises a typed alert for human review instead of guessing:

| Alert | Meaning |
|-------|---------|
| `name_mismatch_on_id` | Same ID, different name |
| `name_phone_mismatch_on_id` | Same ID, different name and phone |
| `id_mismatch_name_phone_match` | Same name + phone, different ID |
| `id_name_mismatch_on_phone` | Same phone, different ID and name |
| `cross_person_mismatch` | An incoming phone already belongs to a different person |
| `name_match_no_id` | Same name, but no ID on either side to confirm |
| `phone_match_name_differs_no_id` | Same phone, different names, no IDs |

Updates and merges re-evaluate open alerts and **auto-resolve** any whose underlying cause has been fixed, recording who resolved them and when.

---

## Features

- **Authentication** — JWT (HS256 via `jose`), hashed credentials (`Bun.password`), route guards, a first-run setup flow, and optional admin bootstrap from environment variables.
- **Ingestion pipeline** — `POST /api/persons/commit` runs each contact through the matching engine and returns a structured summary of what was inserted, enriched, ignored, and flagged.
- **LLM extraction** — `POST /api/extract` turns messy Excel rows or document text into structured contacts via OpenRouter, with strict shape validation on the model's JSON response.
- **Reviewed merges** — conflicting records can be merged deliberately, consolidating phones, reassigning alerts/audit/page-entries, and requiring confirmation when national IDs differ.
- **Audit & history** — every field change is recorded with old/new values, a reason, and the acting user.
- **Contact pages** — generates per-season pages with a row budget, groups suspected duplicate pairs together (union-find), and surfaces cross-page warnings when a likely duplicate was already assigned to someone else's page. A unique `(season, person)` constraint prevents double-assignment.

---

## Tech stack

**Runtime:** Bun · **Framework:** Elysia · **DB:** PostgreSQL + Drizzle ORM (`node-postgres`) · **Auth:** `jose` (JWT), `Bun.password` · **AI:** OpenRouter (OpenAI-compatible) · **Validation:** Elysia TypeBox schemas · **Tests:** `bun:test` · **Language:** TypeScript

---

## Prerequisites

- [Bun](https://bun.sh)
- [Docker](https://www.docker.com/) (for local Postgres)

## Environment

Create a `.env` file (never commit it):

```env
# LLM extraction (required for /api/extract)
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1   # optional
# OPENROUTER_SYSTEM_PROMPT=...                        # optional override

# Database — optional; defaults to the local docker Postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zehut

# Auth
JWT_SECRET=replace-with-a-long-random-string
# Optional: seed the first admin user on startup
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=choose-a-strong-password

# Contact pages (CURRENT_SEASON is required to generate pages)
CURRENT_SEASON=2026
CONTACT_PAGE_ROWS=25
CONTACT_PAGE_PAIR_ROWS=3
```

## Scripts

| Command | What it does |
| --- | --- |
| `bun run db` | Start the local Postgres container (`docker compose up -d --wait`). Idempotent — safe to run repeatedly. |
| `bun run db:down` | Stop the Postgres container. Data persists in the named volume. |
| `bun run db:push` | Apply the current Drizzle schema directly to the DB. Use this in dev after editing `src/db/schema.ts`. |
| `bun run db:generate` | Generate a new SQL migration file from the current schema. Use when you want a tracked migration. |
| `bun run db:migrate` | Apply pending migrations to the DB. |
| `bun run db:clear` | Clear the database and reapply the schema (when using Docker). |
| `bun run db:studio` | Open Drizzle Studio to browse the tables. |
| `bun run dev` | Start the API (`http://localhost:4000`) with file watching. |
| `bun test` | Run the test suite. |

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

Set `DATABASE_URL` to the hosted connection string. No schema changes required — skip `bun run db` and `bun run db:down` since you no longer need the local container.

---

## API overview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/auth/setup-required` | Whether a first user must be created |
| `POST` | `/api/auth/setup` | Create the first user (one-time) |
| `POST` | `/api/auth/login` | Obtain a JWT |
| `GET` | `/api/auth/me` | Current user |
| `GET` `POST` `DELETE` | `/api/users[/:id]` | Manage users |
| `POST` | `/api/extract` | Extract structured contacts from a file payload |
| `POST` | `/api/persons/commit` | Run contacts through the matching engine |
| `GET` | `/api/persons/search` | Search by ID / phone / name |
| `GET` `PATCH` `DELETE` | `/api/persons/:id` | Read, edit, delete a person |
| `GET` | `/api/persons/:id/history` | Audit trail |
| `POST` | `/api/persons/merge` | Reviewed merge of two records |
| `GET` `POST` | `/api/contact-pages[/:id]` | Generate and read contact pages |

All routes except auth setup/login are protected by a bearer-token guard.

---

## Data & privacy

This repository contains **no personal data**. Real contact records exist only in a database that is never committed; the development database is seeded with synthetic data, and all tests use fabricated records. Secrets are read from environment variables and excluded from version control.

---

## Why this project

I built Zehut to practice production-grade backend engineering end to end: clean layering, dependency injection, conservative domain logic that fails toward human review rather than silent data corruption, and a test suite that covers the matching rules case by case. The matching engine in particular was an exercise in encoding fuzzy, real-world "is this the same person?" judgment as explicit, testable rules.
