import { and, asc, desc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "../db/client";
import {
  alerts,
  contactPageEntries,
  contactPages,
  persons,
  phones,
  users,
  type AlertRow,
  type ContactPageEntryRow,
  type ContactPageRow,
  type PersonRow,
} from "../db/schema";

export type Repo = ReturnType<typeof makeRepo>;

export type AssignmentRow = {
  personId: string;
  contactPageId: string;
  pageNumber: number;
  createdByUserId: string;
  createdByUsername: string;
};

export function makeRepo(database: Database = defaultDb) {
  async function findUnassignedPersonIds(
    season: string,
    limit: number
  ): Promise<string[]> {
    const rows = await database
      .select({ id: persons.id })
      .from(persons)
      .where(
        notExists(
          database
            .select({ one: sql<number>`1` })
            .from(contactPageEntries)
            .where(
              and(
                eq(contactPageEntries.season, season),
                eq(contactPageEntries.personId, persons.id)
              )
            )
        )
      )
      .orderBy(asc(persons.createdAt), asc(persons.nationalId))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async function findPersonsByIds(ids: string[]): Promise<PersonRow[]> {
    if (ids.length === 0) return [];
    return database.select().from(persons).where(inArray(persons.id, ids));
  }

  async function findPhonesForPersons(
    ids: string[]
  ): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const rows = await database
      .select()
      .from(phones)
      .where(inArray(phones.personId, ids));
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.personId) ?? [];
      list.push(r.raw);
      out.set(r.personId, list);
    }
    return out;
  }

  // Live alerts only — the table no longer carries a resolvedAt column,
  // an alert row exists iff the collision is still true. Symmetric on
  // either side so the sheet sees errors regardless of which side of
  // the alert this citizen is.
  async function findOpenAlertsForPersons(
    ids: string[]
  ): Promise<AlertRow[]> {
    if (ids.length === 0) return [];
    return database
      .select()
      .from(alerts)
      .where(
        or(
          inArray(alerts.personId, ids),
          inArray(alerts.relatedPersonId, ids)
        )
      );
  }

  async function findAssignmentsForPersons(
    season: string,
    ids: string[]
  ): Promise<AssignmentRow[]> {
    if (ids.length === 0) return [];
    const rows = await database
      .select({
        personId: contactPageEntries.personId,
        contactPageId: contactPages.id,
        pageNumber: contactPages.pageNumber,
        createdByUserId: contactPages.createdByUserId,
        createdByUsername: users.username,
      })
      .from(contactPageEntries)
      .innerJoin(contactPages, eq(contactPageEntries.contactPageId, contactPages.id))
      .innerJoin(users, eq(contactPages.createdByUserId, users.id))
      .where(
        and(
          eq(contactPageEntries.season, season),
          inArray(contactPageEntries.personId, ids)
        )
      );
    return rows;
  }

  async function insertPageWithEntries(input: {
    season: string;
    createdByUserId: string;
    personIds: string[];
  }): Promise<{ page: ContactPageRow; entries: ContactPageEntryRow[] }> {
    return database.transaction(async (tx) => {
      const [next] = await tx
        .select({
          max: sql<number | null>`max(${contactPages.pageNumber})`,
        })
        .from(contactPages)
        .where(eq(contactPages.season, input.season));
      const pageNumber = (next?.max ?? 0) + 1;

      const [page] = await tx
        .insert(contactPages)
        .values({
          season: input.season,
          createdByUserId: input.createdByUserId,
          pageNumber,
        })
        .returning();

      const entries =
        input.personIds.length === 0
          ? []
          : await tx
              .insert(contactPageEntries)
              .values(
                input.personIds.map((personId) => ({
                  contactPageId: page.id,
                  personId,
                  season: input.season,
                }))
              )
              .returning();
      return { page, entries };
    });
  }

  async function listPagesForUser(userId: string): Promise<ContactPageRow[]> {
    return database
      .select()
      .from(contactPages)
      .where(eq(contactPages.createdByUserId, userId))
      .orderBy(desc(contactPages.createdAt));
  }

  async function getPageForUser(
    pageId: string,
    userId: string
  ): Promise<ContactPageRow | null> {
    const [row] = await database
      .select()
      .from(contactPages)
      .where(
        and(eq(contactPages.id, pageId), eq(contactPages.createdByUserId, userId))
      )
      .limit(1);
    return row ?? null;
  }

  async function getPage(pageId: string): Promise<ContactPageRow | null> {
    const [row] = await database
      .select()
      .from(contactPages)
      .where(eq(contactPages.id, pageId))
      .limit(1);
    return row ?? null;
  }

  async function findEntriesByPage(
    pageId: string
  ): Promise<ContactPageEntryRow[]> {
    return database
      .select()
      .from(contactPageEntries)
      .where(eq(contactPageEntries.contactPageId, pageId))
      .orderBy(asc(contactPageEntries.id));
  }

  async function findContactPageForPerson(personId: string): Promise<{
    pageId: string;
    pageNumber: number;
    season: string;
    createdByUserId: string;
    createdByUsername: string;
  } | null> {
    const [row] = await database
      .select({
        pageId: contactPages.id,
        pageNumber: contactPages.pageNumber,
        season: contactPages.season,
        createdByUserId: contactPages.createdByUserId,
        createdByUsername: users.username,
      })
      .from(contactPageEntries)
      .innerJoin(contactPages, eq(contactPageEntries.contactPageId, contactPages.id))
      .innerJoin(users, eq(contactPages.createdByUserId, users.id))
      .where(eq(contactPageEntries.personId, personId))
      .orderBy(desc(contactPages.createdAt))
      .limit(1);
    return row ?? null;
  }

  return {
    findUnassignedPersonIds,
    findPersonsByIds,
    findPhonesForPersons,
    findOpenAlertsForPersons,
    findAssignmentsForPersons,
    insertPageWithEntries,
    listPagesForUser,
    getPageForUser,
    getPage,
    findEntriesByPage,
    findContactPageForPerson,
  };
}

export const repo = makeRepo();
