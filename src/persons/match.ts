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
  | { kind: "insert"; alerts: AlertSpec[] }
  | {
      kind: "alert_only";
      person: PersonWithPhones;
      alerts: AlertSpec[];
    };

// Tri-state field comparison: a missing value (null/empty) is "unknown",
// not a mismatch. Two non-null values are "match" or "mismatch".
type FieldCmp = "match" | "mismatch" | "unknown";

function cmpField(a: string | null, b: string | null): FieldCmp {
  if (!a || !b) return "unknown";
  return a.trim().toLowerCase() === b.trim().toLowerCase() ? "match" : "mismatch";
}

function phoneOverlap(
  person: PersonWithPhones,
  normalized: string[],
  rawPhonesNormalized: Map<string, string>
): boolean {
  if (normalized.length === 0) return false;
  const personNumbers = new Set(
    person.phones.map((raw) => rawPhonesNormalized.get(raw) ?? raw)
  );
  return normalized.some((n) => personNumbers.has(n));
}

export function decide(
  incoming: NormalizedContact,
  byId: PersonWithPhones | null,
  byPhone: PersonWithPhones[],
  byName: PersonWithPhones[],
  // The repo stores `raw` on PersonWithPhones.phones; we need to compare on
  // normalized numbers. Pass a map raw -> normalized harvested from the DB.
  phoneNormalizedByRaw: Map<string, string>
): Decision {
  const incomingNormalized = incoming.phones.map((p) => p.normalized);

  // Case: id matches an existing person
  if (byId) {
    const nameCmp = cmpField(byId.fullname, incoming.fullname);
    const phoneM = phoneOverlap(byId, incomingNormalized, phoneNormalizedByRaw);

    // Cross-person alert: a different person owns one of the incoming phones
    const crossPersonAlerts: AlertSpec[] = [];
    for (const p of byPhone) {
      if (p.id !== byId.id) {
        crossPersonAlerts.push({
          kind: "cross_person_mismatch",
          relatedPersonId: p.id,
          details: { matchedOn: "id", mismatchedFields: ["id"] },
        });
      }
    }

    const existingNumbers = byId.phones.map(
      (raw) => phoneNormalizedByRaw.get(raw) ?? raw
    );
    const hasNewPhones = incomingNormalized.some(
      (n) => !existingNumbers.includes(n)
    );

    // Only a populated-on-both-sides difference counts as a name conflict.
    if (nameCmp === "mismatch") {
      if (phoneM && !hasNewPhones) {
        // id+phone match, name differs, no new phones -> alert_only
        return {
          kind: "alert_only",
          person: byId,
          alerts: [
            {
              kind: "name_mismatch_on_id",
              details: { matchedOn: "id", mismatchedFields: ["name"] },
            },
            ...crossPersonAlerts,
          ],
        };
      }
      // name conflict + (phone overlaps with new phones OR no phone overlap)
      const kind: AlertKind = phoneM
        ? "name_mismatch_on_id"
        : "name_phone_mismatch_on_id";
      const mismatchedFields: MismatchedField[] = phoneM
        ? ["name"]
        : ["name", "phone"];
      return {
        kind: "add_phones",
        person: byId,
        alerts: [
          { kind, details: { matchedOn: "id", mismatchedFields } },
          ...crossPersonAlerts,
        ],
      };
    }

    // No name conflict (match or unknown). Merge: add new phones if any.
    if (hasNewPhones || crossPersonAlerts.length > 0) {
      return {
        kind: "add_phones",
        person: byId,
        alerts: crossPersonAlerts,
      };
    }
    return { kind: "noop", person: byId };
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

  // No id match, no phone match. Name-only match means we can't confirm
  // whether this is the same person or a homonym -- unless both sides have
  // IDs that differ, which proves they are distinct.
  if (byName.length > 0) {
    const namePerson = byName[0];
    const idCmp = cmpField(namePerson.nationalId, incoming.nationalId);
    if (idCmp === "mismatch") {
      // Both have IDs and they differ -> definitively two different people.
      return { kind: "insert", alerts: [] };
    }
    // At least one side has no ID -> warn for human review.
    return {
      kind: "insert",
      alerts: [
        {
          kind: "name_match_no_id",
          relatedPersonId: namePerson.id,
          details: { matchedOn: "name", mismatchedFields: [] },
        },
      ],
    };
  }

  // Clean new contact
  return { kind: "insert", alerts: [] };
}
