import { and, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type Database } from "../db/client";
import {
  alerts,
  persons,
  phones,
  type AlertKind,
  type AlertRow,
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

  return {
    findByNationalId,
    findByPhoneNumbers,
    findByFullname,
    findById,
    insertPersonWithPhones,
    addPhonesToPerson,
    insertAlert,
  };
}

export const repo = makeRepo();
