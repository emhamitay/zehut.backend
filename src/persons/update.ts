import { decide, type AlertSpec, type NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import { repo as defaultRepo, type PersonWithPhones, type Repo } from "./repo";
import type { AlertRow, PersonAuditRow } from "../db/schema";

export type UpdatePersonInput = {
  personId: string;
  nationalId?: string | null;
  fullname?: string | null;
  phones?: { add?: string[]; remove?: string[] };
  reason?: string | null;
};

export type ConflictDetail = {
  kind: AlertSpec["kind"];
  otherPerson: {
    id: string;
    nationalId: string | null;
    fullname: string | null;
    phones: string[];
  };
  mismatchedFields: AlertSpec["details"]["mismatchedFields"];
};

export type UpdateResult =
  | {
      ok: true;
      person: PersonWithPhones;
      audit: PersonAuditRow[];
      resolvedAlerts: AlertRow[];
    }
  | { ok: false; conflicts: ConflictDetail[] }
  | { ok: false; notFound: true };

function trimOrNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function normalizeIncomingPhones(
  rawPhones: string[]
): { raw: string; normalized: string }[] {
  return rawPhones
    .map((raw) => ({ raw, normalized: normalizePhone(raw) }))
    .filter((p) => isValidPhone(p.normalized));
}

function buildCandidate(
  current: PersonWithPhones,
  input: UpdatePersonInput,
  currentPhonesNormalizedByRaw: Map<string, string>,
  addPhones: { raw: string; normalized: string }[],
  removeNormalized: Set<string>
): NormalizedContact {
  const nationalId =
    input.nationalId !== undefined
      ? trimOrNull(input.nationalId)
      : current.nationalId;
  const fullname =
    input.fullname !== undefined ? trimOrNull(input.fullname) : current.fullname;
  const phones: { raw: string; normalized: string }[] = [];
  for (const raw of current.phones) {
    const normalized = currentPhonesNormalizedByRaw.get(raw) ?? normalizePhone(raw);
    if (removeNormalized.has(normalized)) continue;
    phones.push({ raw, normalized });
  }
  const existingNormalized = new Set(phones.map((p) => p.normalized));
  for (const p of addPhones) {
    if (!existingNormalized.has(p.normalized)) {
      phones.push(p);
      existingNormalized.add(p.normalized);
    }
  }
  return {
    raw: {
      id: nationalId,
      fullname,
      phone: phones.map((p) => p.raw),
    },
    nationalId,
    fullname,
    phones,
  };
}

function summarize(p: PersonWithPhones) {
  return {
    id: p.id,
    nationalId: p.nationalId,
    fullname: p.fullname,
    phones: p.phones,
  };
}

function decisionConflicts(
  decisionAlerts: AlertSpec[],
  candidates: PersonWithPhones[]
): ConflictDetail[] {
  const out: ConflictDetail[] = [];
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const seen = new Set<string>();

  for (const a of decisionAlerts) {
    const related = a.relatedPersonId ? byId.get(a.relatedPersonId) : null;
    if (related) {
      seen.add(related.id);
      out.push({
        kind: a.kind,
        otherPerson: summarize(related),
        mismatchedFields: a.details.mismatchedFields,
      });
    }
  }
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    out.push({
      kind: decisionAlerts[0]?.kind ?? "cross_person_mismatch",
      otherPerson: summarize(c),
      mismatchedFields: decisionAlerts[0]?.details.mismatchedFields ?? [],
    });
  }
  return out;
}

function fieldStillMismatched(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

async function reEvaluateOpenAlerts(
  repo: Repo,
  person: PersonWithPhones,
  userId: string
): Promise<AlertRow[]> {
  const open = await repo.listOpenAlerts(person.id);
  if (open.length === 0) return [];
  const personNormalized = new Set(
    person.phones.map((raw) => normalizePhone(raw))
  );
  const resolved: AlertRow[] = [];
  for (const alert of open) {
    const incoming = alert.details.incoming;
    const fields = alert.details.mismatchedFields;
    let anyStillMismatched = false;
    if (fields.includes("name")) {
      if (fieldStillMismatched(person.fullname, incoming.fullname)) {
        anyStillMismatched = true;
      }
    }
    if (fields.includes("id")) {
      if (fieldStillMismatched(person.nationalId, incoming.id)) {
        anyStillMismatched = true;
      }
    }
    if (fields.includes("phone")) {
      const incomingNormalized = (incoming.phone ?? []).map(normalizePhone);
      const stillOverlapsNone =
        incomingNormalized.length > 0 &&
        !incomingNormalized.some((n) => personNormalized.has(n));
      if (stillOverlapsNone) anyStillMismatched = true;
    }
    if (!anyStillMismatched) {
      const r = await repo.resolveAlert(alert.id, userId);
      if (r) resolved.push(r);
    }
  }
  return resolved;
}

export async function updatePerson(
  input: UpdatePersonInput,
  userId: string,
  repo: Repo = defaultRepo
): Promise<UpdateResult> {
  const current = await repo.findById(input.personId);
  if (!current) return { ok: false, notFound: true };

  const currentNormalizedByRaw = new Map<string, string>();
  for (const raw of current.phones) {
    currentNormalizedByRaw.set(raw, normalizePhone(raw));
  }

  const addPhones = normalizeIncomingPhones(input.phones?.add ?? []);
  const removeNormalized = new Set(
    (input.phones?.remove ?? []).map(normalizePhone)
  );

  const candidate = buildCandidate(
    current,
    input,
    currentNormalizedByRaw,
    addPhones,
    removeNormalized
  );

  const byId = candidate.nationalId
    ? await repo.findOtherByNationalId(candidate.nationalId, current.id)
    : null;
  const byPhone =
    candidate.phones.length > 0
      ? await repo.findOtherByPhoneNumbers(
          candidate.phones.map((p) => p.normalized),
          current.id
        )
      : [];
  const byName = candidate.fullname
    ? await repo.findOtherByFullname(candidate.fullname, current.id)
    : [];

  const phoneNormalizedByRaw = new Map<string, string>();
  for (const cand of [byId, ...byPhone, ...byName]) {
    if (!cand) continue;
    for (const raw of cand.phones) {
      phoneNormalizedByRaw.set(raw, normalizePhone(raw));
    }
  }

  const decision = decide(candidate, byId, byPhone, byName, phoneNormalizedByRaw);

  const candidatesForConflicts = [byId, ...byPhone, ...byName].filter(
    (c): c is PersonWithPhones => c !== null
  );

  if (decision.kind !== "insert") {
    const alerts = "alerts" in decision ? decision.alerts : [];
    return {
      ok: false,
      conflicts: decisionConflicts(alerts, candidatesForConflicts),
    };
  }

  if (decision.alerts.length > 0) {
    return {
      ok: false,
      conflicts: decisionConflicts(decision.alerts, candidatesForConflicts),
    };
  }

  const reason = trimOrNull(input.reason ?? null);
  const auditRows: {
    personId: string;
    userId: string;
    field: "nationalId" | "fullname" | "phone_added" | "phone_removed" | "merged_from";
    oldValue: string | null;
    newValue: string | null;
    reason: string | null;
  }[] = [];

  if (
    input.nationalId !== undefined &&
    (current.nationalId ?? null) !== candidate.nationalId
  ) {
    auditRows.push({
      personId: current.id,
      userId,
      field: "nationalId",
      oldValue: current.nationalId,
      newValue: candidate.nationalId,
      reason,
    });
  }
  if (
    input.fullname !== undefined &&
    (current.fullname ?? null) !== candidate.fullname
  ) {
    auditRows.push({
      personId: current.id,
      userId,
      field: "fullname",
      oldValue: current.fullname,
      newValue: candidate.fullname,
      reason,
    });
  }

  if (input.nationalId !== undefined || input.fullname !== undefined) {
    await repo.updatePersonFields(current.id, {
      ...(input.nationalId !== undefined
        ? { nationalId: candidate.nationalId }
        : {}),
      ...(input.fullname !== undefined ? { fullname: candidate.fullname } : {}),
    });
  }

  const currentNormalizedSet = new Set(currentNormalizedByRaw.values());
  const phonesToReallyAdd = addPhones.filter(
    (p) => !currentNormalizedSet.has(p.normalized)
  );
  if (phonesToReallyAdd.length > 0) {
    await repo.addPhonesToPerson(current.id, phonesToReallyAdd);
    for (const p of phonesToReallyAdd) {
      auditRows.push({
        personId: current.id,
        userId,
        field: "phone_added",
        oldValue: null,
        newValue: p.normalized,
        reason,
      });
    }
  }

  const phonesToActuallyRemove = Array.from(removeNormalized).filter((n) =>
    currentNormalizedSet.has(n)
  );
  if (phonesToActuallyRemove.length > 0) {
    await repo.removePhones(current.id, phonesToActuallyRemove);
    for (const n of phonesToActuallyRemove) {
      auditRows.push({
        personId: current.id,
        userId,
        field: "phone_removed",
        oldValue: n,
        newValue: null,
        reason,
      });
    }
  }

  const audit = await repo.insertAuditRows(auditRows);

  const refreshed = (await repo.findById(current.id))!;
  const resolvedAlerts = await reEvaluateOpenAlerts(repo, refreshed, userId);

  return { ok: true, person: refreshed, audit, resolvedAlerts };
}
