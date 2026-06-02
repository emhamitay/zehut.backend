import type { Contact } from "../lib/types";
import type { PersonWithPhones } from "./repo";

export type Classification =
  | { kind: "insert" }
  | { kind: "merge"; target: PersonWithPhones; reason: "national_id" }
  | { kind: "conflict"; candidates: PersonWithPhones[]; matchedOn: "phone" };

export function classify(
  incoming: { nationalId: string | null },
  byNationalId: PersonWithPhones | null,
  byPhone: PersonWithPhones[]
): Classification {
  if (incoming.nationalId && byNationalId) {
    return { kind: "merge", target: byNationalId, reason: "national_id" };
  }
  const phoneCandidates = byNationalId
    ? byPhone.filter((p) => p.id !== byNationalId.id)
    : byPhone;
  if (phoneCandidates.length > 0) {
    return {
      kind: "conflict",
      candidates: phoneCandidates,
      matchedOn: "phone",
    };
  }
  return { kind: "insert" };
}

export type NormalizedContact = {
  raw: Contact;
  nationalId: string | null;
  fullname: string | null;
  phones: { raw: string; normalized: string }[];
};
