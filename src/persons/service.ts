import type { Contact } from "../lib/types";
import { classify, type NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import {
  addPhonesToPerson,
  findById,
  findByNationalId,
  findByPhoneNumbers,
  insertPersonWithPhones,
  updatePersonAndAddPhones,
  type PersonWithPhones,
} from "./repo";

export type CommitResult = {
  inserted: PersonWithPhones[];
  merged: { person: PersonWithPhones; mergedFrom: Contact }[];
  conflicts: {
    incoming: Contact;
    matchedOn: "phone";
    candidates: PersonWithPhones[];
  }[];
};

// Normalize a contact by trimming fields and normalizing phone numbers, returning a structured NormalizedContact
// -- helper function to prepare incoming contact data for processing (Executed from commitContacts and resolveConflict)
function normalize(c: Contact): NormalizedContact {
  const phones = (c.phone ?? [])
    .map((raw) => ({ raw, normalized: normalizePhone(raw) }))
    .filter((p) => isValidPhone(p.normalized));
  return {
    raw: c,
    nationalId: c.id?.trim() || null,
    fullname: c.fullname?.trim() || null,
    phones,
  };
}

// Define the endpoint for committing contacts, including error handling and logging
export async function commitContacts(
  contacts: Contact[],
  sourceFile: string | null
): Promise<CommitResult> {
  // Initialize the result object to track inserted, merged, and conflicting contacts
  const result: CommitResult = { inserted: [], merged: [], conflicts: [] };

  // Iterate over each raw contact, normalize it, and classify it against existing records to determine if it should be inserted, merged, or flagged as a conflict
  for (const raw of contacts) {
    const c = normalize(raw);

    const byNationalId = c.nationalId
      ? await findByNationalId(c.nationalId)
      : null;
    const byPhone =
      c.phones.length > 0
        ? await findByPhoneNumbers(c.phones.map((p) => p.normalized))
        : [];

    const decision = classify(c, byNationalId, byPhone);

    if (decision.kind === "insert") {
      const person = await insertPersonWithPhones({
        nationalId: c.nationalId,
        fullname: c.fullname,
        sourceFile,
        phones: c.phones,
      });
      result.inserted.push(person);
    } else if (decision.kind === "merge") {
      const newPhones = c.phones.filter(
        (p) => !decision.target.phones.some((existing) => existing === p.raw)
      );
      const person = await addPhonesToPerson(decision.target.id, newPhones);
      result.merged.push({ person, mergedFrom: raw });
    } else {
      result.conflicts.push({
        incoming: raw,
        matchedOn: decision.matchedOn,
        candidates: decision.candidates,
      });
    }
  }

  return result;
}

export type ResolveAction =
  | { action: "merge"; targetPersonId: string; incoming: Contact }
  | { action: "new"; incoming: Contact; sourceFile?: string | null }
  | { action: "skip" };

export async function resolveConflict(
  input: ResolveAction
): Promise<PersonWithPhones | null> {
  if (input.action === "skip") return null;

  if (input.action === "new") {
    const c = normalize(input.incoming);
    return insertPersonWithPhones({
      nationalId: c.nationalId,
      fullname: c.fullname,
      sourceFile: input.sourceFile ?? null,
      phones: c.phones,
    });
  }

  const c = normalize(input.incoming);
  const target = await findById(input.targetPersonId);
  if (!target) throw new Error("target_person_not_found");

  const patch: { fullname?: string | null; nationalId?: string | null } = {};
  if (c.fullname && c.fullname !== target.fullname) patch.fullname = c.fullname;
  if (c.nationalId && !target.nationalId) patch.nationalId = c.nationalId;

  const newPhones = c.phones.filter(
    (p) => !target.phones.some((existing) => existing === p.raw)
  );
  return updatePersonAndAddPhones(input.targetPersonId, patch, newPhones);
}
