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

  // Collect every unique phone across the whole batch so we can fetch all
  // relevant DB persons in one query instead of N.
  const phoneSet = new Set<string>();
  for (const c of normalized) {
    for (const p of c.phones) phoneSet.add(p.normalized);
  }

  const dbByPhone =
    phoneSet.size > 0
      ? await repo.findByPhoneNumbers([...phoneSet])
      : ([] as PersonWithPhones[]);

  // Working index: seeded from DB, updated after each row so that row N
  // sees what earlier rows in the same file inserted/modified.
  const workingByPhone = new Map<string, PersonWithPhones>();
  const phoneNormalizedByRaw = new Map<string, string>();
  // Tracks phones queued for an existing person within this batch (not yet in DB).
  const pendingPhonesByPersonId = new Map<string, Set<string>>();

  function indexPerson(p: PersonWithPhones): void {
    for (const raw of p.phones) {
      const norm = normalizePhone(raw);
      phoneNormalizedByRaw.set(raw, norm);
      workingByPhone.set(norm, p);
    }
  }

  const seenIds = new Set<string>();
  for (const p of dbByPhone) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      indexPerson(p);
    }
  }

  // Accumulated write operations, flushed in a single transaction after the loop.
  const personInserts: {
    id: string;
    fullname: string | null;
    phones: { raw: string; normalized: string }[];
  }[] = [];
  const phoneAdds: { personId: string; phones: { raw: string; normalized: string }[] }[] = [];
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

    const byPhoneMap = new Map<string, PersonWithPhones>();
    for (const p of c.phones) {
      const match = workingByPhone.get(p.normalized);
      if (match) byPhoneMap.set(match.id, match);
    }
    const byPhone = [...byPhoneMap.values()];

    const decision = decide(c, byPhone, phoneNormalizedByRaw);

    if (decision.kind === "noop") {
      result.ignored += 1;
      continue;
    }

    if (decision.kind === "insert") {
      const id = globalThis.crypto.randomUUID();
      const now = new Date();
      const person: PersonWithPhones = {
        id,
        fullname: c.fullname,
        sourceFile,
        createdAt: now,
        updatedAt: now,
        phones: c.phones.map((p) => p.raw),
      };
      personInserts.push({ id, fullname: c.fullname, phones: c.phones });
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
  }

  // Flush all accumulated operations in a single transaction.
  result.alerts = await repo.batchCommit({
    personInserts,
    phoneAdds,
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
