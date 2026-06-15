import { Elysia, t } from "elysia";
import { commitContacts } from "./service";
import { updatePerson } from "./update";
import { mergePersons } from "./merge";
import { deletePersonAction } from "./delete";
import { searchPersons, type SearchBy } from "./search";
import { getPersonHistory } from "./history";
import { repo } from "./repo";
import { repo as contactPagesRepo } from "../contact-pages/repo";
import {
  CommitInputSchema,
  CommitResultSchema,
  DeletePersonInputSchema,
  MergePersonsInputSchema,
  PersonDetailSchema,
  PersonHistoryEntrySchema,
  SearchResultSchema,
  UpdatePersonInputSchema,
} from "../lib/schemas";
import type { AuthService } from "../auth/service";
import { currentUserIdFromRequest, requireAuth } from "../auth/guard";

const SEARCH_BY_VALUES: ReadonlyArray<SearchBy> = ["auto", "phone", "name"];

export function personsRoutes(auth: AuthService) {
  return new Elysia({ prefix: "/api/persons" })
    .onBeforeHandle(requireAuth(auth))
    .post(
      "/commit",
      async ({ body, set }) => {
        try {
          const result = await commitContacts(body.contacts, body.sourceFile ?? null);
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
          401: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String(), message: t.String() }),
        },
      }
    )
    .get(
      "/search",
      async ({ query, request, set }) => {
        const userId = await currentUserIdFromRequest(auth, request);
        if (!userId) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        const by = (query.by && SEARCH_BY_VALUES.includes(query.by as SearchBy)
          ? (query.by as SearchBy)
          : "auto");
        const myPagesOnly = query.myPagesOnly !== "false";
        const limit = query.limit ? Number(query.limit) : undefined;
        return searchPersons({
          query: query.q ?? "",
          by,
          currentUserId: userId,
          myPagesOnly,
          limit: Number.isFinite(limit) ? limit : undefined,
        });
      },
      {
        query: t.Object({
          q: t.String(),
          by: t.Optional(t.String()),
          myPagesOnly: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
        response: {
          200: SearchResultSchema,
          401: t.Object({ error: t.String() }),
        },
      }
    )
    .get(
      "/:id",
      async ({ params, set }) => {
        const person = await repo.findById(params.id);
        if (!person) {
          set.status = 404;
          return { error: "not_found" };
        }
        const [openAlerts, contactPage] = await Promise.all([
          repo.listOpenAlerts(person.id),
          contactPagesRepo.findContactPageForPerson(person.id),
        ]);
        return { person, openAlerts, contactPage: contactPage ?? null };
      },
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: PersonDetailSchema,
          401: t.Object({ error: t.String() }),
          404: t.Object({ error: t.String() }),
        },
      }
    )
    .get(
      "/:id/history",
      async ({ params }) => {
        return getPersonHistory(params.id);
      },
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: t.Array(PersonHistoryEntrySchema),
          401: t.Object({ error: t.String() }),
        },
      }
    )
    .patch(
      "/:id",
      async ({ params, body, request, set }) => {
        const userId = await currentUserIdFromRequest(auth, request);
        if (!userId) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        const result = await updatePerson(
          {
            personId: params.id,
            ...(body.fullname !== undefined ? { fullname: body.fullname } : {}),
            ...(body.phones !== undefined ? { phones: body.phones } : {}),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          },
          userId
        );
        if (!result.ok) {
          if ("notFound" in result) {
            set.status = 404;
            return { error: "not_found" };
          }
          // 422 (not 409) — the client sent a syntactically valid PATCH
          // but its semantics violate a uniqueness rule. The frontend
          // surfaces this as the save-error modal.
          set.status = 422;
          return { ok: false, conflicts: result.conflicts };
        }
        return result;
      },
      {
        params: t.Object({ id: t.String() }),
        body: UpdatePersonInputSchema,
      }
    )
    .delete(
      "/:id",
      async ({ params, body, request, set }) => {
        const userId = await currentUserIdFromRequest(auth, request);
        if (!userId) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        const result = await deletePersonAction(
          { personId: params.id, reason: body.reason },
          userId
        );
        if (!result.ok) {
          if (result.error === "not_found") {
            set.status = 404;
            return { error: "not_found" };
          }
          set.status = 400;
          return { ok: false, error: result.error };
        }
        return result;
      },
      {
        params: t.Object({ id: t.String() }),
        body: DeletePersonInputSchema,
      }
    )
    .post(
      "/merge",
      async ({ body, request, set }) => {
        const userId = await currentUserIdFromRequest(auth, request);
        if (!userId) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        const result = await mergePersons(body, userId);
        if (!result.ok) {
          if (result.error === "not_found") {
            set.status = 404;
            return { error: "not_found" };
          }
          set.status = 409;
          return result;
        }
        return result;
      },
      {
        body: MergePersonsInputSchema,
      }
    );
}
