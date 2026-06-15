import { normalizePhone } from "./normalize";
import { repo as defaultRepo, type PersonWithPhones, type Repo } from "./repo";

export type SearchBy = "auto" | "phone" | "name";

export type SearchInput = {
  query: string;
  by?: SearchBy;
  currentUserId: string;
  myPagesOnly?: boolean;
  limit?: number;
};

export type SearchHit = {
  person: PersonWithPhones;
  openAlertCount: number;
};

export type SearchResult = {
  resolvedBy: Exclude<SearchBy, "auto">;
  hits: SearchHit[];
};

const MIN_PHONE_DIGITS = 7;

function detectBy(query: string): Exclude<SearchBy, "auto"> {
  const digitsOnly = query.replace(/\D/g, "");
  const isAllDigits = digitsOnly === query.trim().replace(/^\+/, "");
  if (digitsOnly.length >= MIN_PHONE_DIGITS && isAllDigits) return "phone";
  if (digitsOnly.length >= MIN_PHONE_DIGITS && /[+\-\s()]/.test(query))
    return "phone";
  return "name";
}

export async function searchPersons(
  input: SearchInput,
  repo: Repo = defaultRepo
): Promise<SearchResult> {
  const trimmed = input.query.trim();
  if (!trimmed) return { resolvedBy: input.by === "auto" ? "name" : (input.by ?? "name"), hits: [] };

  const resolvedBy: Exclude<SearchBy, "auto"> =
    input.by && input.by !== "auto" ? input.by : detectBy(trimmed);

  let persons: PersonWithPhones[] = [];

  if (resolvedBy === "phone") {
    const normalized = normalizePhone(trimmed);
    persons = await repo.findByPhoneNumbers([normalized]);
  } else {
    persons = await repo.searchByNameSubstring(trimmed, {
      limit: input.limit ?? 50,
      userId: input.currentUserId,
      myPagesOnly: input.myPagesOnly ?? true,
    });
  }

  const counts = await repo.countOpenAlertsForPersons(persons.map((p) => p.id));
  const hits: SearchHit[] = persons.map((person) => ({
    person,
    openAlertCount: counts.get(person.id) ?? 0,
  }));
  return { resolvedBy, hits };
}
