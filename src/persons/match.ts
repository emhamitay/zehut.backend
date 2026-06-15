import type { Contact } from "../lib/types";
import type { AlertKind } from "../db/schema";
import type { PersonWithPhones } from "./repo";

export type NormalizedContact = {
  raw: Contact;
  fullname: string | null;
  phones: { raw: string; normalized: string }[];
};

export type MismatchedField = "name" | "phone";
export type MatchedOn = "name" | "phone";

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
  // Every existing person who already owns one of the incoming phones.
  byPhone: PersonWithPhones[],
  // The repo stores `raw` on PersonWithPhones.phones; we need to compare on
  // normalized numbers. Pass a map raw -> normalized harvested from the DB.
  phoneNormalizedByRaw: Map<string, string>
): Decision {
  const incomingNormalized = incoming.phones.map((p) => p.normalized);

  // No phone matches an existing citizen. A bare name match (even if the
  // names are identical) is not a collision — homonyms are real, and phone
  // is the only identifier — so insert silently.
  if (byPhone.length === 0) {
    return { kind: "insert", alerts: [] };
  }

  // Phone is the identifier: the first existing owner of a shared phone is
  // the candidate this row belongs to. Any *other* existing owner of an
  // incoming phone is a different citizen holding the same number — a
  // cross-person collision surfaced as a symmetric alert.
  const target = byPhone[0];
  const crossPersonAlerts: AlertSpec[] = byPhone.slice(1).map((p) => ({
    kind: "cross_person_mismatch" as AlertKind,
    relatedPersonId: p.id,
    details: { matchedOn: "phone" as MatchedOn, mismatchedFields: ["phone"] },
  }));

  // Phone matches the target but the names actively differ. We can't
  // confirm it's the same person, so insert a separate citizen and flag a
  // symmetric "same phone, different name" alert for a coordinator.
  if (cmpField(target.fullname, incoming.fullname) === "mismatch") {
    return {
      kind: "insert",
      alerts: [
        {
          kind: "phone_match_name_differs",
          relatedPersonId: target.id,
          details: { matchedOn: "phone", mismatchedFields: ["name"] },
        },
        ...crossPersonAlerts,
      ],
    };
  }

  // Phone matches, names match or unknown -> same person. Add any phones
  // the target doesn't have yet.
  const existingNumbers = target.phones.map(
    (raw) => phoneNormalizedByRaw.get(raw) ?? raw
  );
  const hasNewPhones = incomingNormalized.some(
    (n) => !existingNumbers.includes(n)
  );
  if (hasNewPhones || crossPersonAlerts.length > 0) {
    return { kind: "add_phones", person: target, alerts: crossPersonAlerts };
  }
  return { kind: "noop", person: target };
}
