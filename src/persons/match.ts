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
  | { kind: "insert"; alerts: AlertSpec[] }
  | {
      kind: "alert_only";
      person: PersonWithPhones;
      alerts: AlertSpec[];
    };

function sameName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
    const nameM = sameName(byId.fullname, incoming.fullname);
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

    if (nameM && phoneM) {
      // Exact match — but incoming might still bring NEW phones
      const hasNewPhones = incomingNormalized.some(
        (n) =>
          !byId.phones
            .map((raw) => phoneNormalizedByRaw.get(raw) ?? raw)
            .includes(n)
      );
      if (hasNewPhones || crossPersonAlerts.length > 0) {
        return {
          kind: "add_phones",
          person: byId,
          alerts: crossPersonAlerts,
        };
      }
      return { kind: "noop", person: byId };
    }

    if (nameM && !phoneM) {
      // case 7: id+name match, phone differs -> add the new phone
      return {
        kind: "add_phones",
        person: byId,
        alerts: crossPersonAlerts,
      };
    }

    if (!nameM && phoneM) {
      // case 4: id+phone match, name differs -> alert, no insert
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

    // case 6: id matches, name AND phone differ -> add phones to existing + alert
    return {
      kind: "add_phones",
      person: byId,
      alerts: [
        {
          kind: "name_phone_mismatch_on_id",
          details: {
            matchedOn: "id",
            mismatchedFields: ["name", "phone"],
          },
        },
        ...crossPersonAlerts,
      ],
    };
  }

  // No id match. Try phone next.
  if (byPhone.length > 0) {
    const phonePerson = byPhone[0];
    const nameM = sameName(phonePerson.fullname, incoming.fullname);

    if (nameM) {
      // case 1: phone+name match, id differs -> insert new person + alert
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

    // cases 2/5: phone matches, id AND name differ -> insert new + alert
    return {
      kind: "insert",
      alerts: [
        {
          kind: "id_name_mismatch_on_phone",
          relatedPersonId: phonePerson.id,
          details: { matchedOn: "phone", mismatchedFields: ["id", "name"] },
        },
      ],
    };
  }

  // No id, no phone match. Name match alone means two homonyms — insert, no alert.
  if (byName.length > 0) {
    return { kind: "insert", alerts: [] };
  }

  // Clean new contact
  return { kind: "insert", alerts: [] };
}
