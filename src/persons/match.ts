import type { Contact } from "../lib/types";
import type { AlertKind } from "../db/schema";
import type { PersonWithPhones } from "./repo";

export type NormalizedContact = {
  raw: Contact;
  nationalId: string | null;
  fullname: string | null;
  phones: { raw: string; normalized: string }[];
};

export type MismatchedField = "id" | "name" | "phone";
export type MatchedOn = "id" | "name" | "phone";

export type AlertSpec = {
  kind: AlertKind;
  relatedPersonId?: string;
  details: { matchedOn: MatchedOn; mismatchedFields: MismatchedField[] };
};

export type Decision =
  | { kind: "noop"; person: PersonWithPhones }
  | {
      kind: "add_phones";
      person: PersonWithPhones;
      alerts: AlertSpec[];
    }
  | {
      kind: "backfill_id_and_add_phones";
      person: PersonWithPhones;
      nationalId: string;
      alerts: AlertSpec[];
    }
  | { kind: "insert"; alerts: AlertSpec[] };

// Tri-state field comparison: a missing value (null/empty) is "unknown",
// not a mismatch. Two non-null values are "match" or "mismatch".
type FieldCmp = "match" | "mismatch" | "unknown";

function cmpField(a: string | null, b: string | null): FieldCmp {
  if (!a || !b) return "unknown";
  return a.trim().toLowerCase() === b.trim().toLowerCase() ? "match" : "mismatch";
}

export function decide(
  incoming: NormalizedContact,
  byIds: PersonWithPhones[],
  byPhone: PersonWithPhones[],
  byName: PersonWithPhones[],
  // The repo stores `raw` on PersonWithPhones.phones; we need to compare on
  // normalized numbers. Pass a map raw -> normalized harvested from the DB.
  phoneNormalizedByRaw: Map<string, string>
): Decision {
  const incomingNormalized = incoming.phones.map((p) => p.normalized);

  // Case: id matches one or more existing persons. National ID is not
  // unique — two import rows with the same ID and different names are
  // treated as two citizens and flagged with a symmetric data-error.
  if (byIds.length > 0) {
    // Pick a merge target: an existing same-ID person whose name does NOT
    // actively conflict with the incoming row — a name match, or a row
    // where either side's name is missing (an "unknown" comparison is not
    // a conflict). Same ID + no active name conflict is the same person,
    // so we merge and add phones. Only when EVERY same-ID person's name
    // actively differs do we insert the incoming row as its own citizen.
    const target =
      byIds.find((p) => cmpField(p.fullname, incoming.fullname) === "match") ??
      byIds.find((p) => cmpField(p.fullname, incoming.fullname) === "unknown") ??
      null;

    // Every same-ID person whose name actively differs from the incoming
    // row (and isn't the merge target) is the related side of a symmetric
    // name_mismatch_on_id alert.
    const sameIdAlerts: AlertSpec[] = byIds
      .filter(
        (p) =>
          p.id !== target?.id &&
          cmpField(p.fullname, incoming.fullname) === "mismatch"
      )
      .map((p) => ({
        kind: "name_mismatch_on_id" as AlertKind,
        relatedPersonId: p.id,
        details: { matchedOn: "id" as MatchedOn, mismatchedFields: ["name"] },
      }));

    // Cross-person alert: a different person owns one of the incoming
    // phones. "Different" = not the merge target and not a same-ID person
    // (those are already covered by the id collision above).
    const crossPersonAlerts: AlertSpec[] = [];
    for (const p of byPhone) {
      if (p.id === target?.id) continue;
      if (byIds.some((b) => b.id === p.id)) continue;
      crossPersonAlerts.push({
        kind: "cross_person_mismatch",
        relatedPersonId: p.id,
        details: { matchedOn: "id", mismatchedFields: ["id"] },
      });
    }

    if (!target) {
      // No same-ID person to merge into → insert a new citizen carrying
      // every symmetric id-collision and cross-person alert.
      return {
        kind: "insert",
        alerts: [...sameIdAlerts, ...crossPersonAlerts],
      };
    }

    // We have a merge target. Add new phones, plus any symmetric alerts
    // against other same-ID rows whose names differ.
    const existingNumbers = target.phones.map(
      (raw) => phoneNormalizedByRaw.get(raw) ?? raw
    );
    const hasNewPhones = incomingNormalized.some(
      (n) => !existingNumbers.includes(n)
    );
    if (
      hasNewPhones ||
      crossPersonAlerts.length > 0 ||
      sameIdAlerts.length > 0
    ) {
      return {
        kind: "add_phones",
        person: target,
        alerts: [...sameIdAlerts, ...crossPersonAlerts],
      };
    }
    return { kind: "noop", person: target };
  }

  // No id match. Try phone next.
  if (byPhone.length > 0) {
    const phonePerson = byPhone[0];
    const nameCmp = cmpField(phonePerson.fullname, incoming.fullname);
    const idCmp = cmpField(phonePerson.nationalId, incoming.nationalId);

    // IDs both present and differ -> definitively different people.
    if (idCmp === "mismatch") {
      if (nameCmp === "match") {
        // case 1: phone+name match, id differs -> insert new + alert
        return {
          kind: "insert",
          alerts: [
            {
              kind: "id_mismatch_name_phone_match",
              relatedPersonId: phonePerson.id,
              details: { matchedOn: "phone", mismatchedFields: ["id"] },
            },
          ],
        };
      }
      // cases 2/5: phone matches, id differs, name differs or unknown
      const mismatchedFields: MismatchedField[] =
        nameCmp === "mismatch" ? ["id", "name"] : ["id"];
      return {
        kind: "insert",
        alerts: [
          {
            kind: "id_name_mismatch_on_phone",
            relatedPersonId: phonePerson.id,
            details: { matchedOn: "phone", mismatchedFields },
          },
        ],
      };
    }

    // IDs don't conflict (unknown: at least one null, or match — won't reach here on match).
    if (nameCmp === "mismatch") {
      // Phone match, names both present and differ, no id conflict.
      // Can't confirm same person -> insert separate + warning.
      return {
        kind: "insert",
        alerts: [
          {
            kind: "phone_match_name_differs_no_id",
            relatedPersonId: phonePerson.id,
            details: { matchedOn: "phone", mismatchedFields: ["name"] },
          },
        ],
      };
    }

    // Phone matches, names match or unknown, no id conflict -> merge.
    if (!phonePerson.nationalId && incoming.nationalId) {
      // Existing has no id, incoming brings one -> backfill.
      return {
        kind: "backfill_id_and_add_phones",
        person: phonePerson,
        nationalId: incoming.nationalId,
        alerts: [],
      };
    }
    return { kind: "add_phones", person: phonePerson, alerts: [] };
  }

  // No id match, no phone match. A bare name match (even if the names are
  // identical) is not a collision — homonyms are real, and there is no
  // shared unique field to act on. Insert silently.
  return { kind: "insert", alerts: [] };
}
