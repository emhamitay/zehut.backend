import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "../db/client";
import {
  alerts,
  contactPageEntries,
  contactPages,
  personAudit,
  persons,
  phones,
  users,
  type AlertKind,
  type AlertRow,
  type PersonAuditField,
  type PersonAuditRow,
  type PersonRow,
} from "../db/schema";

export type PersonWithPhones = PersonRow & { phones: string[] };

export type InsertPersonInput = {
  nationalId: string | null;
  fullname: string | null;
  sourceFile?: string | null;
  phones: { raw: string; normalized: string }[];
};

import type { AlertDetails } from "../db/schema";

export type InsertAlertInput = {
  kind: AlertKind;
  personId: string;
  relatedPersonId?: string | null;
  details: AlertDetails;
  sourceFile?: string | null;
};

export type Repo = ReturnType<typeof makeRepo>;

export function makeRepo(database: Database = defaultDb) {
  async function attachPhones(rows: PersonRow[]): Promise<PersonWithPhones[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const phoneRows = await database
      .select()
      .from(phones)
      .where(inArray(phones.personId, ids));
    const byPerson = new Map<string, string[]>();
    for (const p of phoneRows) {
      const list = byPerson.get(p.personId) ?? [];
      list.push(p.raw);
      byPerson.set(p.personId, list);
    }
    return rows.map((r) => ({ ...r, phones: byPerson.get(r.id) ?? [] }));
  }

  async function findByNationalId(
    nationalId: string
  ): Promise<PersonWithPhones | null> {
    const rows = await database
      .select()
      .from(persons)
      .where(eq(persons.nationalId, nationalId))
      .limit(1);
    const withPhones = await attachPhones(rows);
    return withPhones[0] ?? null;
  }

  async function findByPhoneNumbers(
    normalized: string[]
  ): Promise<PersonWithPhones[]> {
    if (normalized.length === 0) return [];
    const matches = await database
      .selectDistinct({ personId: phones.personId })
      .from(phones)
      .where(inArray(phones.number, normalized));
    if (matches.length === 0) return [];
    const ids = matches.map((m) => m.personId);
    const rows = await database
      .select()
      .from(persons)
      .where(inArray(persons.id, ids));
    return attachPhones(rows);
  }

  async function findByFullname(name: string): Promise<PersonWithPhones[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const rows = await database
      .select()
      .from(persons)
      .where(sql`lower(${persons.fullname}) = lower(${trimmed})`);
    return attachPhones(rows);
  }

  async function findById(id: string): Promise<PersonWithPhones | null> {
    const rows = await database
      .select()
      .from(persons)
      .where(eq(persons.id, id))
      .limit(1);
    const withPhones = await attachPhones(rows);
    return withPhones[0] ?? null;
  }

  async function insertPersonWithPhones(
    input: InsertPersonInput
  ): Promise<PersonWithPhones> {
    return database.transaction(async (tx) => {
      const [person] = await tx
        .insert(persons)
        .values({
          nationalId: input.nationalId,
          fullname: input.fullname,
          sourceFile: input.sourceFile ?? null,
        })
        .returning();
      if (input.phones.length > 0) {
        await tx
          .insert(phones)
          .values(
            input.phones.map((p) => ({
              personId: person.id,
              number: p.normalized,
              raw: p.raw,
            }))
          )
          .onConflictDoNothing();
      }
      return { ...person, phones: input.phones.map((p) => p.raw) };
    });
  }

  async function addPhonesToPerson(
    personId: string,
    newPhones: { raw: string; normalized: string }[]
  ): Promise<{ person: PersonWithPhones; addedPhones: string[] }> {
    return database.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(phones)
        .where(eq(phones.personId, personId));
      const existingNumbers = new Set(existing.map((p) => p.number));
      const toInsert = newPhones.filter(
        (p) => !existingNumbers.has(p.normalized)
      );
      if (toInsert.length > 0) {
        await tx
          .insert(phones)
          .values(
            toInsert.map((p) => ({
              personId,
              number: p.normalized,
              raw: p.raw,
            }))
          )
          .onConflictDoNothing();
      }
      await tx
        .update(persons)
        .set({ updatedAt: new Date() })
        .where(eq(persons.id, personId));
      const [person] = await tx
        .select()
        .from(persons)
        .where(eq(persons.id, personId));
      const phoneRows = await tx
        .select()
        .from(phones)
        .where(eq(phones.personId, personId));
      return {
        person: { ...person, phones: phoneRows.map((p) => p.raw) },
        addedPhones: toInsert.map((p) => p.raw),
      };
    });
  }

  async function updatePersonNationalId(
    personId: string,
    nationalId: string
  ): Promise<PersonWithPhones> {
    return database.transaction(async (tx) => {
      await tx
        .update(persons)
        .set({ nationalId, updatedAt: new Date() })
        .where(eq(persons.id, personId));
      const [person] = await tx
        .select()
        .from(persons)
        .where(eq(persons.id, personId));
      const phoneRows = await tx
        .select()
        .from(phones)
        .where(eq(phones.personId, personId));
      return { ...person, phones: phoneRows.map((p) => p.raw) };
    });
  }

  async function insertAlert(input: InsertAlertInput): Promise<AlertRow> {
    const [row] = await database
      .insert(alerts)
      .values({
        kind: input.kind,
        personId: input.personId,
        relatedPersonId: input.relatedPersonId ?? null,
        details: input.details,
        sourceFile: input.sourceFile ?? null,
      })
      .returning();
    return row;
  }

  async function updatePersonFields(
    personId: string,
    fields: { nationalId?: string | null; fullname?: string | null }
  ): Promise<void> {
    const patch: { nationalId?: string | null; fullname?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (Object.prototype.hasOwnProperty.call(fields, "nationalId")) {
      patch.nationalId = fields.nationalId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "fullname")) {
      patch.fullname = fields.fullname ?? null;
    }
    await database.update(persons).set(patch).where(eq(persons.id, personId));
  }

  async function removePhones(
    personId: string,
    normalized: string[]
  ): Promise<string[]> {
    if (normalized.length === 0) return [];
    const removed = await database
      .delete(phones)
      .where(
        and(eq(phones.personId, personId), inArray(phones.number, normalized))
      )
      .returning({ raw: phones.raw });
    return removed.map((r) => r.raw);
  }

  async function searchByNameSubstring(
    query: string,
    opts: { limit?: number; userId?: string; myPagesOnly?: boolean } = {}
  ): Promise<PersonWithPhones[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = opts.limit ?? 50;
    const pattern = `%${trimmed.toLowerCase()}%`;

    if (opts.myPagesOnly && opts.userId) {
      const rows = await database
        .selectDistinct({
          id: persons.id,
          nationalId: persons.nationalId,
          fullname: persons.fullname,
          sourceFile: persons.sourceFile,
          createdAt: persons.createdAt,
          updatedAt: persons.updatedAt,
        })
        .from(persons)
        .innerJoin(
          contactPageEntries,
          eq(contactPageEntries.personId, persons.id)
        )
        .innerJoin(
          contactPages,
          eq(contactPages.id, contactPageEntries.contactPageId)
        )
        .where(
          and(
            eq(contactPages.createdByUserId, opts.userId),
            sql`lower(${persons.fullname}) like ${pattern}`
          )
        )
        .limit(limit);
      return attachPhones(rows as PersonRow[]);
    }

    const rows = await database
      .select()
      .from(persons)
      .where(sql`lower(${persons.fullname}) like ${pattern}`)
      .limit(limit);
    return attachPhones(rows);
  }

  async function listOpenAlerts(personId: string): Promise<AlertRow[]> {
    return database
      .select()
      .from(alerts)
      .where(and(eq(alerts.personId, personId), isNull(alerts.resolvedAt)));
  }

  async function resolveAlert(
    alertId: string,
    userId: string
  ): Promise<AlertRow | null> {
    const [row] = await database
      .update(alerts)
      .set({ resolvedAt: new Date(), resolvedByUserId: userId })
      .where(eq(alerts.id, alertId))
      .returning();
    return row ?? null;
  }

  async function insertAuditRows(
    rows: {
      personId: string;
      userId: string;
      field: PersonAuditField;
      oldValue?: string | null;
      newValue?: string | null;
      reason?: string | null;
    }[]
  ): Promise<PersonAuditRow[]> {
    if (rows.length === 0) return [];
    return database
      .insert(personAudit)
      .values(
        rows.map((r) => ({
          personId: r.personId,
          userId: r.userId,
          field: r.field,
          oldValue: r.oldValue ?? null,
          newValue: r.newValue ?? null,
          reason: r.reason ?? null,
        }))
      )
      .returning();
  }

  async function listAudit(
    personId: string
  ): Promise<
    {
      id: string;
      field: PersonAuditField;
      oldValue: string | null;
      newValue: string | null;
      reason: string | null;
      createdAt: Date;
      user: { id: string; username: string } | null;
    }[]
  > {
    const rows = await database
      .select({
        id: personAudit.id,
        field: personAudit.field,
        oldValue: personAudit.oldValue,
        newValue: personAudit.newValue,
        reason: personAudit.reason,
        createdAt: personAudit.createdAt,
        userId: users.id,
        username: users.username,
      })
      .from(personAudit)
      .leftJoin(users, eq(users.id, personAudit.userId))
      .where(eq(personAudit.personId, personId))
      .orderBy(desc(personAudit.createdAt));
    return rows.map((r) => ({
      id: r.id,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      reason: r.reason,
      createdAt: r.createdAt,
      user:
        r.userId && r.username ? { id: r.userId, username: r.username } : null,
    }));
  }

  async function reassignAlertsPerson(
    fromPersonId: string,
    toPersonId: string
  ): Promise<void> {
    await database
      .update(alerts)
      .set({ personId: toPersonId })
      .where(eq(alerts.personId, fromPersonId));
    await database
      .update(alerts)
      .set({ relatedPersonId: toPersonId })
      .where(eq(alerts.relatedPersonId, fromPersonId));
  }

  async function reassignContactPageEntriesPerson(
    fromPersonId: string,
    toPersonId: string
  ): Promise<void> {
    const fromEntries = await database
      .select()
      .from(contactPageEntries)
      .where(eq(contactPageEntries.personId, fromPersonId));
    if (fromEntries.length === 0) return;
    const toEntries = await database
      .select()
      .from(contactPageEntries)
      .where(eq(contactPageEntries.personId, toPersonId));
    const toSeasons = new Set(toEntries.map((e) => e.season));
    const collisions = fromEntries
      .filter((e) => toSeasons.has(e.season))
      .map((e) => e.id);
    if (collisions.length > 0) {
      await database
        .delete(contactPageEntries)
        .where(inArray(contactPageEntries.id, collisions));
    }
    await database
      .update(contactPageEntries)
      .set({ personId: toPersonId })
      .where(eq(contactPageEntries.personId, fromPersonId));
  }

  async function reassignAuditPerson(
    fromPersonId: string,
    toPersonId: string
  ): Promise<void> {
    await database
      .update(personAudit)
      .set({ personId: toPersonId })
      .where(eq(personAudit.personId, fromPersonId));
  }

  async function deletePerson(personId: string): Promise<void> {
    await database.delete(persons).where(eq(persons.id, personId));
  }

  async function findOtherByNationalId(
    nationalId: string,
    excludePersonId: string
  ): Promise<PersonWithPhones | null> {
    const rows = await database
      .select()
      .from(persons)
      .where(
        and(
          eq(persons.nationalId, nationalId),
          ne(persons.id, excludePersonId)
        )
      )
      .limit(1);
    const withPhones = await attachPhones(rows);
    return withPhones[0] ?? null;
  }

  async function findOtherByPhoneNumbers(
    normalized: string[],
    excludePersonId: string
  ): Promise<PersonWithPhones[]> {
    if (normalized.length === 0) return [];
    const matches = await database
      .selectDistinct({ personId: phones.personId })
      .from(phones)
      .where(
        and(
          inArray(phones.number, normalized),
          ne(phones.personId, excludePersonId)
        )
      );
    if (matches.length === 0) return [];
    const ids = matches.map((m) => m.personId);
    const rows = await database
      .select()
      .from(persons)
      .where(inArray(persons.id, ids));
    return attachPhones(rows);
  }

  async function findOtherByFullname(
    name: string,
    excludePersonId: string
  ): Promise<PersonWithPhones[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const rows = await database
      .select()
      .from(persons)
      .where(
        and(
          sql`lower(${persons.fullname}) = lower(${trimmed})`,
          ne(persons.id, excludePersonId)
        )
      );
    return attachPhones(rows);
  }

  async function countOpenAlertsForPersons(
    personIds: string[]
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (personIds.length === 0) return out;
    const rows = await database
      .select({
        personId: alerts.personId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(alerts)
      .where(
        and(inArray(alerts.personId, personIds), isNull(alerts.resolvedAt))
      )
      .groupBy(alerts.personId);
    for (const r of rows) out.set(r.personId, Number(r.count));
    for (const id of personIds) if (!out.has(id)) out.set(id, 0);
    return out;
  }

  return {
    findByNationalId,
    findByPhoneNumbers,
    findByFullname,
    findById,
    insertPersonWithPhones,
    addPhonesToPerson,
    updatePersonNationalId,
    insertAlert,
    updatePersonFields,
    removePhones,
    searchByNameSubstring,
    listOpenAlerts,
    resolveAlert,
    insertAuditRows,
    listAudit,
    reassignAlertsPerson,
    reassignContactPageEntriesPerson,
    reassignAuditPerson,
    deletePerson,
    findOtherByNationalId,
    findOtherByPhoneNumbers,
    findOtherByFullname,
    countOpenAlertsForPersons,
  };
}

export const repo = makeRepo();
