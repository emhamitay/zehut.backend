import type { NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import { repo as defaultRepo, type PersonWithPhones, type Repo } from "./repo";
import type { AlertKind, AlertRow, PersonAuditRow } from "../db/schema";

export type UpdatePersonInput = {
  personId: string;
  nationalId?: string | null;
  fullname?: string | null;
  phones?: { add?: string[]; remove?: string[] };
  reason?: string | null;
};

export type MismatchedField = "id" | "name" | "phone";

export type ConflictDetail = {
  kind: AlertKind;
  otherPerson: {
    id: string;
    nationalId: string | null;
    fullname: string | null;
    phones: string[];
  };
  mismatchedFields: MismatchedField[];
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

function fieldEqualsCaseInsensitive(
  a: string | null,
  b: string | null
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function describeConflict(
  other: PersonWithPhones,
  candidate: NormalizedContact,
  candidatePhoneNormalized: Set<string>,
  otherPhoneNormalized: Set<string>
): ConflictDetail {
  const idMatches =
    !!candidate.nationalId &&
    !!other.nationalId &&
    candidate.nationalId === other.nationalId;
  const nameMatches = fieldEqualsCaseInsensitive(
    candidate.fullname,
    other.fullname
  );
  const phoneMatches = [...candidatePhoneNormalized].some((n) =>
    otherPhoneNormalized.has(n)
  );

  const mismatchedFields: MismatchedField[] = [];
  if (
    candidate.nationalId &&
    other.nationalId &&
    candidate.nationalId !== other.nationalId
  ) {
    mismatchedFields.push("id");
  }
  if (
    candidate.fullname &&
    other.fullname &&
    !fieldEqualsCaseInsensitive(candidate.fullname, other.fullname)
  ) {
    mismatchedFields.push("name");
  }
  if (candidatePhoneNormalized.size > 0 && otherPhoneNormalized.size > 0) {
    const allOverlap = [...candidatePhoneNormalized].every((n) =>
      otherPhoneNormalized.has(n)
    );
    if (!allOverlap && phoneMatches === false) mismatchedFields.push("phone");
  }

  let kind: AlertKind;
  if (idMatches) {
    kind = "name_mismatch_on_id";
  } else if (phoneMatches && nameMatches) {
    kind = "id_mismatch_name_phone_match";
  } else if (phoneMatches) {
    kind = "phone_match_name_differs_no_id";
  } else if (nameMatches) {
    kind = "name_match_no_id";
  } else {
    kind = "cross_person_mismatch";
  }

  return {
    kind,
    otherPerson: summarize(other),
    mismatchedFields,
  };
}

function dedupeById(rows: PersonWithPhones[]): PersonWithPhones[] {
  const seen = new Set<string>();
  const out: PersonWithPhones[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
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

  const others = dedupeById(
    [byId, ...byPhone, ...byName].filter(
      (c): c is PersonWithPhones => c !== null && c.id !== current.id
    )
  );

  if (others.length > 0) {
    const candidatePhoneNormalized = new Set(
      candidate.phones.map((p) => p.normalized)
    );
    const conflicts = others.map((other) => {
      const otherPhoneNormalized = new Set(
        other.phones.map((raw) => normalizePhone(raw))
      );
      return describeConflict(
        other,
        candidate,
        candidatePhoneNormalized,
        otherPhoneNormalized
      );
    });
    return { ok: false, conflicts };
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
