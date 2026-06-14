import type { Contact } from "../lib/types";
import { decide, type NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import {
  repo as defaultRepo,
  type AlertWithRelated,
  type PersonWithPhones,
  type Repo,
} from "./repo";
import type { AlertDetails, AlertKind, AlertRow } from "../db/schema";

export type CommitResult = {
  inserted: PersonWithPhones[];
  ignored: number;
  phoneAdded: { person: PersonWithPhones; addedPhones: string[] }[];
  alerts: AlertWithRelated[];
};

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

// Returns the phones from `incoming` not already on `person`, accounting for
// phones queued earlier in the same batch (not yet written to DB).
function newPhonesForPerson(
  person: PersonWithPhones,
  incoming: { raw: string; normalized: string }[],
  pendingByPersonId: Map<string, Set<string>>
): { raw: string; normalized: string }[] {
  const existingNorm = new Set(person.phones.map(normalizePhone));
  pendingByPersonId.get(person.id)?.forEach((n) => existingNorm.add(n));
  return incoming.filter((p) => !existingNorm.has(p.normalized));
}

// Updates the working phone index to reflect `newPhones` being added to
// `person`, and records them in the per-person pending tracker.
function applyPhonesInMemory(
  person: PersonWithPhones,
  newPhones: { raw: string; normalized: string }[],
  pendingByPersonId: Map<string, Set<string>>,
  workingByPhone: Map<string, PersonWithPhones>,
  phoneNormalizedByRaw: Map<string, string>
): PersonWithPhones {
  const updated: PersonWithPhones = {
    ...person,
    phones: [...person.phones, ...newPhones.map((p) => p.raw)],
  };
  const pending = pendingByPersonId.get(person.id) ?? new Set<string>();
  for (const p of newPhones) {
    phoneNormalizedByRaw.set(p.raw, p.normalized);
    workingByPhone.set(p.normalized, updated);
    pending.add(p.normalized);
  }
  pendingByPersonId.set(person.id, pending);
  return updated;
}

export async function commitContacts(
  contacts: Contact[],
  sourceFile: string | null,
  repo: Repo = defaultRepo
): Promise<CommitResult> {
  const normalized = contacts.map(normalize);

  // Collect every unique nationalId and phone across the whole batch so we
  // can fetch all relevant DB persons in two queries instead of N×2.
  const nationalIdSet = new Set<string>();
  const phoneSet = new Set<string>();
  for (const c of normalized) {
    if (c.nationalId) nationalIdSet.add(c.nationalId);
    for (const p of c.phones) phoneSet.add(p.normalized);
  }

  const [dbByIds, dbByPhone] = await Promise.all([
    nationalIdSet.size > 0
      ? repo.findAllByNationalIds([...nationalIdSet])
      : Promise.resolve([] as PersonWithPhones[]),
    phoneSet.size > 0
      ? repo.findByPhoneNumbers([...phoneSet])
      : Promise.resolve([] as PersonWithPhones[]),
  ]);

  // Working indexes: seeded from DB, updated after each row so that row N
  // sees what earlier rows in the same file inserted/modified.
  const workingByNationalId = new Map<string, PersonWithPhones[]>();
  const workingByPhone = new Map<string, PersonWithPhones>();
  const phoneNormalizedByRaw = new Map<string, string>();
  // Tracks phones queued for an existing person within this batch (not yet in DB).
  const pendingPhonesByPersonId = new Map<string, Set<string>>();

  function indexPerson(p: PersonWithPhones): void {
    if (p.nationalId) {
      const list = workingByNationalId.get(p.nationalId) ?? [];
      if (!list.some((e) => e.id === p.id)) {
        list.push(p);
        workingByNationalId.set(p.nationalId, list);
      }
    }
    for (const raw of p.phones) {
      const norm = normalizePhone(raw);
      phoneNormalizedByRaw.set(raw, norm);
      workingByPhone.set(norm, p);
    }
  }

  const seenIds = new Set<string>();
  for (const p of [...dbByIds, ...dbByPhone]) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      indexPerson(p);
    }
  }

  // Accumulated write operations, flushed in a single transaction after the loop.
  const personInserts: {
    id: string;
    nationalId: string | null;
    fullname: string | null;
    phones: { raw: string; normalized: string }[];
  }[] = [];
  const phoneAdds: { personId: string; phones: { raw: string; normalized: string }[] }[] = [];
  const nationalIdUpdates: { personId: string; nationalId: string }[] = [];
  const alertInserts: {
    kind: AlertKind;
    personId: string;
    relatedPersonId: string | null;
    details: AlertDetails;
  }[] = [];

  const result = {
    inserted: [] as PersonWithPhones[],
    ignored: 0,
    phoneAdded: [] as { person: PersonWithPhones; addedPhones: string[] }[],
    alerts: [] as AlertRow[],
  };

  for (const c of normalized) {
    if (c.phones.length === 0) {
      result.ignored += 1;
      continue;
    }

    const byIds = c.nationalId
      ? (workingByNationalId.get(c.nationalId) ?? [])
      : [];

    const byPhoneMap = new Map<string, PersonWithPhones>();
    for (const p of c.phones) {
      const match = workingByPhone.get(p.normalized);
      if (match) byPhoneMap.set(match.id, match);
    }
    const byPhone = [...byPhoneMap.values()];

    // byName is unused inside decide() (name-only is not a collision), pass [].
    const decision = decide(c, byIds, byPhone, [], phoneNormalizedByRaw);

    if (decision.kind === "noop") {
      result.ignored += 1;
      continue;
    }

    if (decision.kind === "insert") {
      const id = globalThis.crypto.randomUUID();
      const now = new Date();
      const person: PersonWithPhones = {
        id,
        nationalId: c.nationalId,
        fullname: c.fullname,
        sourceFile,
        createdAt: now,
        updatedAt: now,
        phones: c.phones.map((p) => p.raw),
      };
      personInserts.push({ id, nationalId: c.nationalId, fullname: c.fullname, phones: c.phones });
      result.inserted.push(person);
      indexPerson(person);

      for (const spec of decision.alerts) {
        alertInserts.push({
          kind: spec.kind,
          personId: id,
          relatedPersonId: spec.relatedPersonId ?? null,
          details: { ...spec.details, incoming: c.raw },
        });
      }
      continue;
    }

    if (decision.kind === "add_phones") {
      const person = decision.person;
      const newPhones = newPhonesForPerson(person, c.phones, pendingPhonesByPersonId);

      if (newPhones.length > 0) {
        const updated = applyPhonesInMemory(
          person,
          newPhones,
          pendingPhonesByPersonId,
          workingByPhone,
          phoneNormalizedByRaw
        );
        result.phoneAdded.push({ person: updated, addedPhones: newPhones.map((p) => p.raw) });
        phoneAdds.push({ personId: person.id, phones: newPhones });
      } else if (decision.alerts.length === 0) {
        result.ignored += 1;
      }

      for (const spec of decision.alerts) {
        alertInserts.push({
          kind: spec.kind,
          personId: person.id,
          relatedPersonId: spec.relatedPersonId ?? null,
          details: { ...spec.details, incoming: c.raw },
        });
      }
      continue;
    }

    if (decision.kind === "backfill_id_and_add_phones") {
      const person = decision.person;
      nationalIdUpdates.push({ personId: person.id, nationalId: decision.nationalId });

      // Update working nationalId index immediately so later rows see the backfill.
      const updatedPerson: PersonWithPhones = { ...person, nationalId: decision.nationalId };
      const list = workingByNationalId.get(decision.nationalId) ?? [];
      if (!list.some((e) => e.id === updatedPerson.id)) {
        list.push(updatedPerson);
        workingByNationalId.set(decision.nationalId, list);
      }

      const newPhones = newPhonesForPerson(person, c.phones, pendingPhonesByPersonId);
      if (newPhones.length > 0) {
        const updated = applyPhonesInMemory(
          updatedPerson,
          newPhones,
          pendingPhonesByPersonId,
          workingByPhone,
          phoneNormalizedByRaw
        );
        result.phoneAdded.push({ person: updated, addedPhones: newPhones.map((p) => p.raw) });
        phoneAdds.push({ personId: person.id, phones: newPhones });
      } else if (decision.alerts.length === 0) {
        result.ignored += 1;
      }
      continue;
    }
  }

  // Flush all accumulated operations in a single transaction.
  result.alerts = await repo.batchCommit({
    personInserts,
    phoneAdds,
    nationalIdUpdates,
    alertInserts,
    sourceFile,
  });

  const enrichedAlerts = await repo.attachRelatedPersons(result.alerts);
  return {
    inserted: result.inserted,
    ignored: result.ignored,
    phoneAdded: result.phoneAdded,
    alerts: enrichedAlerts,
  };
}
