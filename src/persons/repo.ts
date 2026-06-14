import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "../db/client";
import { normalizePhone } from "./normalize";
import {
  alerts,
  contactPageEntries,
  contactPages,
  dataErrorTypeFromAlertKind,
  personAudit,
  persons,
  phones,
  users,
  type AlertDetails,
  type AlertKind,
  type AlertRow,
  type DataErrorType,
  type PersonAuditField,
  type PersonAuditRow,
  type PersonRow,
} from "../db/schema";

export type PersonWithPhones = PersonRow & { phones: string[] };

// `relatedPerson` is always "the other side" of the alert — when a
// viewerId is provided to attachRelatedPersons (e.g. from listOpenAlerts),
// it returns the side that *isn't* the viewer, not necessarily the
// alert's relatedPersonId. This is what every consumer actually wants:
// the citizen on the other side of the collision.
//
// `collidingValue` is the value that triggered the alert: the shared
// nationalId for id_data_error, or one of the shared phone numbers for
// phone_data_error. The frontend uses this to write copy like
// "מספר הטלפון 050-1234567 מופיע גם אצל יוסי כהן" without having to
// re-derive which phone collided.
export type AlertWithRelated = AlertRow & {
  errorType: DataErrorType;
  relatedPerson: PersonWithPhones | null;
  collidingValue: string | null;
};

// The colliding (shared) value: the nationalId both citizens carry for
// an id_data_error, or the specific phone they share for a
// phone_data_error. Both sides of a collision are always live persons
// now, so we always have an `other` to read from.
function computeCollidingValue(
  row: AlertRow,
  viewer: PersonWithPhones | null,
  other: PersonWithPhones | null
): string | null {
  const errorType = dataErrorTypeFromAlertKind(row.kind);

  if (errorType === "id_data_error") {
    return other?.nationalId ?? viewer?.nationalId ?? null;
  }

  if (!other) return null;
  if (viewer) {
    const viewerNormalized = new Set(
      viewer.phones.map((raw) => normalizePhone(raw))
    );
    for (const raw of other.phones) {
      if (viewerNormalized.has(normalizePhone(raw))) return raw;
    }
  }
  return other.phones[0] ?? null;
}

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

  // national_id is NOT unique. Same-ID collisions surface as symmetric
  // alerts (see persons/match.ts), so every code path that needs to
  // reason about the full set of citizens carrying an ID — ingest, search
  // by ID, the PATCH collision check — uses this.
  async function findAllByNationalId(
    nationalId: string
  ): Promise<PersonWithPhones[]> {
    const rows = await database
      .select()
      .from(persons)
      .where(eq(persons.nationalId, nationalId));
    return attachPhones(rows);
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

  // Symmetric: returns every open alert that touches this person, whether
  // they are on the person side or the related-person side. The same alert
  // row is therefore visible on both citizens' detail pages, and from
  // each one's perspective `relatedPerson` is the *other* citizen.
  async function listOpenAlerts(
    personId: string
  ): Promise<AlertWithRelated[]> {
    const rows = await database
      .select()
      .from(alerts)
      .where(
        or(
          eq(alerts.personId, personId),
          eq(alerts.relatedPersonId, personId)
        )
      );
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return attachRelatedPersons(deduped, personId);
  }

  // When `viewerId` is supplied, `relatedPerson` is the side of the alert
  // that isn't the viewer (so it's symmetric: visiting either citizen
  // shows the other). Without a viewer we fall back to the alert's
  // relatedPersonId side — used by code paths that don't have a single
  // "self" perspective (e.g. the post-commit batch enrichment).
  async function attachRelatedPersons(
    rows: AlertRow[],
    viewerId?: string
  ): Promise<AlertWithRelated[]> {
    if (rows.length === 0) return [];
    const otherIdFor = (r: AlertRow): string | null =>
      viewerId
        ? r.personId === viewerId
          ? r.relatedPersonId
          : r.personId
        : r.relatedPersonId;

    const idsToFetch = new Set<string>();
    for (const r of rows) {
      const otherId = otherIdFor(r);
      if (otherId) idsToFetch.add(otherId);
    }
    if (viewerId) idsToFetch.add(viewerId);

    const byId = new Map<string, PersonWithPhones>();
    if (idsToFetch.size > 0) {
      const personRows = await database
        .select()
        .from(persons)
        .where(inArray(persons.id, Array.from(idsToFetch)));
      const withPhones = await attachPhones(personRows);
      for (const p of withPhones) byId.set(p.id, p);
    }
    const viewer = viewerId ? byId.get(viewerId) ?? null : null;

    return rows.map((r) => {
      const otherId = otherIdFor(r);
      const other = otherId ? byId.get(otherId) ?? null : null;
      return {
        ...r,
        errorType: dataErrorTypeFromAlertKind(r.kind),
        relatedPerson: other,
        collidingValue: computeCollidingValue(r, viewer, other),
      };
    });
  }

  // Alerts have a binary lifecycle: they exist while the collision is live
  // and are deleted (not marked resolved) the moment it's no longer true.
  // Callers that need a breadcrumb should write a `person_audit` row with
  // field = 'alert_closed' before calling this.
  async function deleteAlert(alertId: string): Promise<AlertRow | null> {
    const [row] = await database
      .delete(alerts)
      .where(eq(alerts.id, alertId))
      .returning();
    return row ?? null;
  }

  // Used when a person is deleted: removes any alert this person was part
  // of, regardless of whether they were the person or the related-person.
  // The personId FK already cascades on person delete, but the symmetric
  // side would otherwise survive with a nulled relatedPersonId.
  async function deleteAlertsTouchingPerson(
    personId: string
  ): Promise<AlertRow[]> {
    return database
      .delete(alerts)
      .where(
        or(
          eq(alerts.personId, personId),
          eq(alerts.relatedPersonId, personId)
        )
      )
      .returning();
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
      .orderBy(desc(personAudit.createdAt), desc(personAudit.id));
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
    // A merge can collapse the two sides of a symmetric alert into the
    // same person — e.g. the same-ID typo flagged at ingest and then
    // explicitly merged by a coordinator. Drop those rows up-front; the
    // collision they describe is no longer real.
    await database
      .delete(alerts)
      .where(
        or(
          and(
            eq(alerts.personId, fromPersonId),
            eq(alerts.relatedPersonId, toPersonId)
          ),
          and(
            eq(alerts.personId, toPersonId),
            eq(alerts.relatedPersonId, fromPersonId)
          )
        )
      );
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
  ): Promise<PersonWithPhones[]> {
    const rows = await database
      .select()
      .from(persons)
      .where(
        and(
          eq(persons.nationalId, nationalId),
          ne(persons.id, excludePersonId)
        )
      );
    return attachPhones(rows);
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

  // Batch version of findAllByNationalId — one query for multiple IDs.
  async function findAllByNationalIds(ids: string[]): Promise<PersonWithPhones[]> {
    if (ids.length === 0) return [];
    const rows = await database
      .select()
      .from(persons)
      .where(inArray(persons.nationalId, ids));
    return attachPhones(rows);
  }

  // Executes all accumulated write operations from a commitContacts batch in a
  // single transaction: person inserts, phone inserts/adds, nationalId backfills,
  // and alert inserts.
  async function batchCommit(input: {
    personInserts: Array<{
      id: string;
      nationalId: string | null;
      fullname: string | null;
      phones: Array<{ raw: string; normalized: string }>;
    }>;
    phoneAdds: Array<{
      personId: string;
      phones: Array<{ raw: string; normalized: string }>;
    }>;
    nationalIdUpdates: Array<{ personId: string; nationalId: string }>;
    alertInserts: Array<{
      kind: AlertKind;
      personId: string;
      relatedPersonId: string | null;
      details: AlertDetails;
    }>;
    sourceFile: string | null;
  }): Promise<AlertRow[]> {
    const hasWork =
      input.personInserts.length > 0 ||
      input.phoneAdds.length > 0 ||
      input.nationalIdUpdates.length > 0 ||
      input.alertInserts.length > 0;

    if (!hasWork) return [];

    return database.transaction(async (tx) => {
      const now = new Date();

      // 1. Batch-insert new persons.
      if (input.personInserts.length > 0) {
        await tx.insert(persons).values(
          input.personInserts.map((p) => ({
            id: p.id,
            nationalId: p.nationalId,
            fullname: p.fullname,
            sourceFile: input.sourceFile ?? null,
          }))
        );

        // 2. Batch-insert phones for new persons.
        const newPersonPhones = input.personInserts.flatMap((p) =>
          p.phones.map((ph) => ({
            personId: p.id,
            number: ph.normalized,
            raw: ph.raw,
          }))
        );
        if (newPersonPhones.length > 0) {
          await tx.insert(phones).values(newPersonPhones).onConflictDoNothing();
        }
      }

      // 3. Backfill nationalIds on existing persons.
      for (const u of input.nationalIdUpdates) {
        await tx
          .update(persons)
          .set({ nationalId: u.nationalId, updatedAt: now })
          .where(eq(persons.id, u.personId));
      }

      // 4. Batch-insert added phones for existing persons.
      if (input.phoneAdds.length > 0) {
        const addedPhoneRows = input.phoneAdds.flatMap((pa) =>
          pa.phones.map((p) => ({
            personId: pa.personId,
            number: p.normalized,
            raw: p.raw,
          }))
        );
        if (addedPhoneRows.length > 0) {
          await tx.insert(phones).values(addedPhoneRows).onConflictDoNothing();
          const affectedIds = [...new Set(input.phoneAdds.map((pa) => pa.personId))];
          await tx
            .update(persons)
            .set({ updatedAt: now })
            .where(inArray(persons.id, affectedIds));
        }
      }

      // 5. Batch-insert alerts.
      if (input.alertInserts.length === 0) return [];
      return tx
        .insert(alerts)
        .values(
          input.alertInserts.map((a) => ({
            kind: a.kind,
            personId: a.personId,
            relatedPersonId: a.relatedPersonId,
            details: a.details,
            sourceFile: input.sourceFile ?? null,
          }))
        )
        .returning();
    });
  }

  // Counts every alert that touches each person, symmetrically. An alert
  // where personId=A and relatedPersonId=B contributes one to A and one
  // to B, so a citizen showing "2 שגיאות" on search means two distinct
  // collisions, not one collision counted twice.
  async function countOpenAlertsForPersons(
    personIds: string[]
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (personIds.length === 0) return out;
    const rows = await database
      .select({
        id: alerts.id,
        personId: alerts.personId,
        relatedPersonId: alerts.relatedPersonId,
      })
      .from(alerts)
      .where(
        or(
          inArray(alerts.personId, personIds),
          inArray(alerts.relatedPersonId, personIds)
        )
      );
    const wanted = new Set(personIds);
    for (const id of personIds) out.set(id, 0);
    for (const r of rows) {
      if (wanted.has(r.personId)) {
        out.set(r.personId, (out.get(r.personId) ?? 0) + 1);
      }
      if (r.relatedPersonId && wanted.has(r.relatedPersonId)) {
        out.set(
          r.relatedPersonId,
          (out.get(r.relatedPersonId) ?? 0) + 1
        );
      }
    }
    return out;
  }

  return {
    findByNationalId,
    findAllByNationalId,
    findAllByNationalIds,
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
    attachRelatedPersons,
    deleteAlert,
    deleteAlertsTouchingPerson,
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
    batchCommit,
  };
}

export const repo = makeRepo();
