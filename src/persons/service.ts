import type { Contact } from "../lib/types";
import { decide, type AlertSpec, type NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import { repo as defaultRepo, type PersonWithPhones, type Repo } from "./repo";
import type { AlertRow } from "../db/schema";

export type CommitResult = {
  inserted: PersonWithPhones[];
  ignored: number;
  phoneAdded: { person: PersonWithPhones; addedPhones: string[] }[];
  alerts: AlertRow[];
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

async function persistAlerts(
  repo: Repo,
  personId: string,
  specs: AlertSpec[],
  incoming: Contact,
  sourceFile: string | null
): Promise<AlertRow[]> {
  const out: AlertRow[] = [];
  for (const spec of specs) {
    const row = await repo.insertAlert({
      kind: spec.kind,
      personId,
      relatedPersonId: spec.relatedPersonId ?? null,
      details: { ...spec.details, incoming },
      sourceFile,
    });
    out.push(row);
  }
  return out;
}

export async function commitContacts(
  contacts: Contact[],
  sourceFile: string | null,
  repo: Repo = defaultRepo
): Promise<CommitResult> {
  const result: CommitResult = {
    inserted: [],
    ignored: 0,
    phoneAdded: [],
    alerts: [],
  };

  for (const raw of contacts) {
    const c = normalize(raw);

    const byId = c.nationalId ? await repo.findByNationalId(c.nationalId) : null;
    const byPhone =
      c.phones.length > 0
        ? await repo.findByPhoneNumbers(c.phones.map((p) => p.normalized))
        : [];
    const byName = c.fullname ? await repo.findByFullname(c.fullname) : [];

    // Build a normalized lookup for each candidate's stored raw phones.
    // The repo returns phones as raw strings; we re-normalize for comparison.
    const phoneNormalizedByRaw = new Map<string, string>();
    for (const candidate of [byId, ...byPhone, ...byName]) {
      if (!candidate) continue;
      for (const rawPhone of candidate.phones) {
        phoneNormalizedByRaw.set(rawPhone, normalizePhone(rawPhone));
      }
    }

    const decision = decide(c, byId, byPhone, byName, phoneNormalizedByRaw);

    if (decision.kind === "noop") {
      result.ignored += 1;
      continue;
    }

    if (decision.kind === "insert") {
      const person = await repo.insertPersonWithPhones({
        nationalId: c.nationalId,
        fullname: c.fullname,
        sourceFile,
        phones: c.phones,
      });
      result.inserted.push(person);
      const alertRows = await persistAlerts(
        repo,
        person.id,
        decision.alerts,
        raw,
        sourceFile
      );
      result.alerts.push(...alertRows);
      continue;
    }

    if (decision.kind === "add_phones") {
      const { person, addedPhones } = await repo.addPhonesToPerson(
        decision.person.id,
        c.phones
      );
      if (addedPhones.length > 0) {
        result.phoneAdded.push({ person, addedPhones });
      } else if (decision.alerts.length === 0) {
        result.ignored += 1;
      }
      const alertRows = await persistAlerts(
        repo,
        person.id,
        decision.alerts,
        raw,
        sourceFile
      );
      result.alerts.push(...alertRows);
      continue;
    }

    // alert_only
    const alertRows = await persistAlerts(
      repo,
      decision.person.id,
      decision.alerts,
      raw,
      sourceFile
    );
    result.alerts.push(...alertRows);
    result.ignored += 1;
  }

  return result;
}
