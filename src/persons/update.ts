import type { NormalizedContact } from "./match";
import { isValidPhone, normalizePhone } from "./normalize";
import {
  repo as defaultRepo,
  type AlertWithRelated,
  type PersonWithPhones,
  type Repo,
} from "./repo";
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
  // The exact value the candidate save tried to write that already exists
  // on `otherPerson`. For an ID collision it's the shared nationalId;
  // for a phone collision it's the specific phone the two candidates
  // share (not just otherPerson.phones[0]). The frontend renders this
  // verbatim in the save-error modal so the coordinator sees which value
  // to change.
  collidingValue: string | null;
};

export type UpdateResult =
  | {
      ok: true;
      person: PersonWithPhones;
      audit: PersonAuditRow[];
      closedAlerts: AlertWithRelated[];
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

// Only ID and phone collisions block a save. A name-only collision is
// silent everywhere now — the modal that surfaces this conflict to the
// user is going to point at the field whose unique constraint is being
// violated, and that field is always nationalId or a phone.
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
  let collidingValue: string | null = null;
  if (idMatches) {
    kind = "name_mismatch_on_id";
    collidingValue = candidate.nationalId;
  } else if (phoneMatches && nameMatches) {
    kind = "id_mismatch_name_phone_match";
    collidingValue = sharedPhoneRaw(other, candidatePhoneNormalized);
  } else if (phoneMatches) {
    kind = "phone_match_name_differs_no_id";
    collidingValue = sharedPhoneRaw(other, candidatePhoneNormalized);
  } else {
    // No id match and no phone match means this candidate just shares a
    // name with `other` — not a blocking collision.
    kind = "cross_person_mismatch";
  }

  return {
    kind,
    otherPerson: summarize(other),
    mismatchedFields,
    collidingValue,
  };
}

// Find the raw phone on `other` that normalizes to one of the candidate's
// phone values. Returns the other side's raw form so the UI shows the
// value as it's stored on the existing record.
function sharedPhoneRaw(
  other: PersonWithPhones,
  candidateNormalized: Set<string>
): string | null {
  for (const raw of other.phones) {
    if (candidateNormalized.has(normalizePhone(raw))) return raw;
  }
  return other.phones[0] ?? null;
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

// After a successful PATCH we walk every alert that touches this person
// (symmetrically — either side) and ask: is the collision recorded in the
// alert still true against the current DB? If not, delete the alert and
// record an `alert_closed` audit row so there's a breadcrumb that this
// person used to have a data error.
//
// We use the live DB state (the other person's current fields) rather
// than the snapshotted `incoming` payload, because the other side may
// have been edited too. This is the "re-check against the whole DB"
// behaviour the plan specifies.
async function closeResolvedAlerts(
  repo: Repo,
  person: PersonWithPhones,
  userId: string,
  reason: string | null
): Promise<{ closed: AlertRow[]; audit: PersonAuditRow[] }> {
  const open = await repo.listOpenAlerts(person.id);
  if (open.length === 0) return { closed: [], audit: [] };
  const personNormalized = new Set(
    person.phones.map((raw) => normalizePhone(raw))
  );
  const closed: AlertRow[] = [];
  const auditPayloads: {
    personId: string;
    userId: string;
    field: "alert_closed";
    oldValue: string | null;
    newValue: string | null;
    reason: string | null;
  }[] = [];
  for (const alert of open) {
    const other = alert.relatedPerson;
    // Every live collision alert has both sides as live persons. If the
    // other side is gone the alert is stale — close it.
    let stillColliding = false;
    if (other) {
      const otherPhonesNormalized = new Set(
        other.phones.map((raw) => normalizePhone(raw))
      );
      const idMatches =
        !!person.nationalId &&
        !!other.nationalId &&
        person.nationalId === other.nationalId;
      const phoneOverlap = [...personNormalized].some((n) =>
        otherPhonesNormalized.has(n)
      );
      stillColliding = idMatches || phoneOverlap;
    }

    if (!stillColliding) {
      const r = await repo.deleteAlert(alert.id);
      if (r) {
        closed.push(r);
        auditPayloads.push({
          personId: person.id,
          userId,
          field: "alert_closed",
          oldValue: null,
          newValue: JSON.stringify({
            alertId: r.id,
            kind: r.kind,
            otherPersonId:
              r.personId === person.id ? r.relatedPersonId : r.personId,
          }),
          reason,
        });
      }
    }
  }
  const audit = await repo.insertAuditRows(auditPayloads);
  return { closed, audit };
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

  // Re-check against the whole DB on every save: any other person who
  // shares the candidate's nationalId or any candidate phone is a blocker.
  // Names are NOT a uniqueness-bearing field — a coordinator may share a
  // name with another citizen and that's fine.
  const byId = candidate.nationalId
    ? await repo.findOtherByNationalId(candidate.nationalId, current.id)
    : [];
  const byPhone =
    candidate.phones.length > 0
      ? await repo.findOtherByPhoneNumbers(
          candidate.phones.map((p) => p.normalized),
          current.id
        )
      : [];

  const others = dedupeById(
    [...byId, ...byPhone].filter((c) => c.id !== current.id)
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
    field:
      | "nationalId"
      | "fullname"
      | "phone_added"
      | "phone_removed"
      | "merged_from"
      | "alert_closed";
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
  const { closed, audit: closeAudit } = await closeResolvedAlerts(
    repo,
    refreshed,
    userId,
    reason
  );
  // Enrich for the API: each closed alert ships with its relatedPerson
  // (still in the DB at this point) and its derived errorType, matching
  // the shape of openAlerts. Pass the refreshed person.id as viewer so
  // `relatedPerson` is the *other* side of the closed alert, not the
  // viewer themselves.
  const closedAlerts = await repo.attachRelatedPersons(closed, refreshed.id);

  return {
    ok: true,
    person: refreshed,
    audit: [...audit, ...closeAudit],
    closedAlerts,
  };
}
