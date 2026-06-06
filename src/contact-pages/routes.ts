import { Elysia, t } from "elysia";
import { service as defaultService, type Service } from "./service";
import type { AuthService } from "../auth/service";
import { currentUserIdFromRequest, requireAuth } from "../auth/guard";

const EntryViewSchema = t.Object({
  personId: t.String(),
  nationalId: t.Union([t.String(), t.Null()]),
  fullname: t.Union([t.String(), t.Null()]),
  phones: t.Array(t.String()),
  pairGroupId: t.Union([t.String(), t.Null()]),
  crossPageWarnings: t.Array(
    t.Object({
      otherPersonId: t.String(),
      otherNationalId: t.Union([t.String(), t.Null()]),
      otherFullname: t.Union([t.String(), t.Null()]),
      otherPageId: t.String(),
      otherPageNumber: t.Number(),
      otherCreatedByUsername: t.String(),
      alertKind: t.String(),
    })
  ),
});

const PageViewSchema = t.Object({
  id: t.String(),
  season: t.String(),
  pageNumber: t.Number(),
  createdByUserId: t.String(),
  createdAt: t.Union([t.String(), t.Date()]),
  entries: t.Array(EntryViewSchema),
});

const PageSummarySchema = t.Object({
  id: t.String(),
  season: t.String(),
  pageNumber: t.Number(),
  createdAt: t.Union([t.String(), t.Date()]),
});

export function contactPagesRoutes(
  auth: AuthService,
  service: Service = defaultService
) {
  return new Elysia({ prefix: "/api/contact-pages" })
    .onBeforeHandle(requireAuth(auth))
    .post("/", async ({ request, set }) => {
      const userId = await currentUserIdFromRequest(auth, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      try {
        return await service.generatePageForUser(userId);
      } catch (e) {
        set.status = 400;
        return { error: "generate_failed", message: (e as Error).message };
      }
    })
    .get("/", async ({ request, set }) => {
      const userId = await currentUserIdFromRequest(auth, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return service.listPagesForUser(userId);
    })
    .get("/:id", async ({ params, request, set }) => {
      const userId = await currentUserIdFromRequest(auth, request);
      if (!userId) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const page = await service.getPageForUser(params.id, userId);
      if (!page) {
        set.status = 404;
        return { error: "not_found" };
      }
      return page;
    });
}

export { PageViewSchema, PageSummarySchema, EntryViewSchema };
