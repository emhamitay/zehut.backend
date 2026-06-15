import { isValidPhone, normalizePhone } from "./normalize";
import { repo as defaultRepo, type PersonWithPhones, type Repo } from "./repo";
import type { PersonAuditRow } from "../db/schema";

export type MergePersonsInput = {
  survivorId: string;
  victimId: string;
  resolved: {
    fullname: string | null;
  };
  phonesToKeep: string[];
  reason: string;
};

export type MergeResult =
  | {
      ok: true;
      person: PersonWithPhones;
      audit: PersonAuditRow[];
    }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "missing_reason" }
  | { ok: false; error: "same_person" };

function trimOrNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

export async function mergePersons(
  input: MergePersonsInput,
  userId: string,
  repo: Repo = defaultRepo
): Promise<MergeResult> {
  if (input.survivorId === input.victimId) {
    return { ok: false, error: "same_person" };
  }
  const reason = trimOrNull(input.reason);
  if (!reason) return { ok: false, error: "missing_reason" };

  const survivor = await repo.findById(input.survivorId);
  const victim = await repo.findById(input.victimId);
  if (!survivor || !victim) return { ok: false, error: "not_found" };

  const resolvedFullname = trimOrNull(input.resolved.fullname);

  const auditRows: {
    personId: string;
    userId: string;
    field: "fullname" | "phone_added" | "phone_removed" | "merged_from";
    oldValue: string | null;
    newValue: string | null;
    reason: string | null;
  }[] = [];

  if ((survivor.fullname ?? null) !== resolvedFullname) {
    auditRows.push({
      personId: survivor.id,
      userId,
      field: "fullname",
      oldValue: survivor.fullname,
      newValue: resolvedFullname,
      reason,
    });
  }
  await repo.updatePersonFields(survivor.id, { fullname: resolvedFullname });

  const survivorPhonesNormalized = new Set(
    survivor.phones.map((raw) => normalizePhone(raw))
  );
  const victimPhonesNormalizedByRaw = new Map<string, string>();
  for (const raw of victim.phones) {
    victimPhonesNormalizedByRaw.set(raw, normalizePhone(raw));
  }
  const keep = new Set(
    input.phonesToKeep.map((n) => normalizePhone(n)).filter(isValidPhone)
  );

  const phonesToAdd: { raw: string; normalized: string }[] = [];
  for (const [raw, normalized] of victimPhonesNormalizedByRaw) {
    if (!keep.has(normalized)) continue;
    if (survivorPhonesNormalized.has(normalized)) continue;
    phonesToAdd.push({ raw, normalized });
  }

  const phonesToRemoveFromSurvivor: string[] = [];
  for (const raw of survivor.phones) {
    const normalized = normalizePhone(raw);
    if (!keep.has(normalized)) phonesToRemoveFromSurvivor.push(normalized);
  }

  if (phonesToAdd.length > 0) {
    await repo.addPhonesToPerson(survivor.id, phonesToAdd);
    for (const p of phonesToAdd) {
      auditRows.push({
        personId: survivor.id,
        userId,
        field: "phone_added",
        oldValue: null,
        newValue: p.normalized,
        reason,
      });
    }
  }
  if (phonesToRemoveFromSurvivor.length > 0) {
    await repo.removePhones(survivor.id, phonesToRemoveFromSurvivor);
    for (const n of phonesToRemoveFromSurvivor) {
      auditRows.push({
        personId: survivor.id,
        userId,
        field: "phone_removed",
        oldValue: n,
        newValue: null,
        reason,
      });
    }
  }

  await repo.reassignAlertsPerson(victim.id, survivor.id);
  await repo.reassignContactPageEntriesPerson(victim.id, survivor.id);
  await repo.reassignAuditPerson(victim.id, survivor.id);

  auditRows.push({
    personId: survivor.id,
    userId,
    field: "merged_from",
    oldValue: victim.id,
    newValue: JSON.stringify({
      fullname: victim.fullname,
      phones: victim.phones,
    }),
    reason,
  });

  const audit = await repo.insertAuditRows(auditRows);
  await repo.deletePerson(victim.id);

  const refreshed = (await repo.findById(survivor.id))!;
  return { ok: true, person: refreshed, audit };
}
