import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { persons, phones, type PersonRow } from "../db/schema";

export type PersonWithPhones = PersonRow & { phones: string[] };

async function attachPhones(rows: PersonRow[]): Promise<PersonWithPhones[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const phoneRows = await db
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

export async function findByNationalId(
  nationalId: string
): Promise<PersonWithPhones | null> {
  const rows = await db
    .select()
    .from(persons)
    .where(eq(persons.nationalId, nationalId))
    .limit(1);
  const withPhones = await attachPhones(rows);
  return withPhones[0] ?? null;
}

export async function findByPhoneNumbers(
  normalized: string[]
): Promise<PersonWithPhones[]> {
  if (normalized.length === 0) return [];
  const matches = await db
    .selectDistinct({ personId: phones.personId })
    .from(phones)
    .where(inArray(phones.number, normalized));
  if (matches.length === 0) return [];
  const ids = matches.map((m) => m.personId);
  const rows = await db.select().from(persons).where(inArray(persons.id, ids));
  return attachPhones(rows);
}

export async function findById(
  id: string
): Promise<PersonWithPhones | null> {
  const rows = await db
    .select()
    .from(persons)
    .where(eq(persons.id, id))
    .limit(1);
  const withPhones = await attachPhones(rows);
  return withPhones[0] ?? null;
}

export type InsertPersonInput = {
  nationalId: string | null;
  fullname: string | null;
  sourceFile?: string | null;
  phones: { raw: string; normalized: string }[];
};

export async function insertPersonWithPhones(
  input: InsertPersonInput
): Promise<PersonWithPhones> {
  return db.transaction(async (tx) => {
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

export async function addPhonesToPerson(
  personId: string,
  newPhones: { raw: string; normalized: string }[]
): Promise<PersonWithPhones> {
  return db.transaction(async (tx) => {
    if (newPhones.length > 0) {
      await tx
        .insert(phones)
        .values(
          newPhones.map((p) => ({
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
    return { ...person, phones: phoneRows.map((p) => p.raw) };
  });
}

export async function updatePersonAndAddPhones(
  personId: string,
  patch: { nationalId?: string | null; fullname?: string | null },
  newPhones: { raw: string; normalized: string }[]
): Promise<PersonWithPhones> {
  return db.transaction(async (tx) => {
    await tx
      .update(persons)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(persons.id, personId));
    if (newPhones.length > 0) {
      await tx
        .insert(phones)
        .values(
          newPhones.map((p) => ({
            personId,
            number: p.normalized,
            raw: p.raw,
          }))
        )
        .onConflictDoNothing();
    }
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
