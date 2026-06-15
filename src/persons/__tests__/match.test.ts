import { describe, expect, test } from "bun:test";
import { decide, type NormalizedContact } from "../match";
import type { PersonWithPhones } from "../repo";

function makePerson(over: Partial<PersonWithPhones> = {}): PersonWithPhones {
  return {
    id: over.id ?? "person-1",
    fullname: over.fullname ?? "Alice",
    sourceFile: over.sourceFile ?? null,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
    phones: over.phones ?? ["0500000000"],
  };
}

function makeContact(over: Partial<NormalizedContact> = {}): NormalizedContact {
  const phones = over.phones ?? [{ raw: "0500000000", normalized: "0500000000" }];
  return {
    raw: {
      fullname: over.fullname ?? "Alice",
      phone: phones.map((p) => p.raw),
    },
    fullname: over.fullname ?? "Alice",
    phones,
  };
}

function phoneMap(...persons: PersonWithPhones[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of persons) {
    for (const raw of p.phones) {
      // raw == normalized in these unit tests for simplicity
      m.set(raw, raw);
    }
  }
  return m;
}

describe("decide (phone-only matching)", () => {
  test("no phone match -> insert with no alerts", () => {
    const c = makeContact();
    const d = decide(c, [], new Map());
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("name-only match (no shared phone) -> insert silently (homonyms)", () => {
    // Two people called Alice with different phones are different people.
    // Name is not an identifier, so there is no collision.
    const c = makeContact({
      fullname: "Alice",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, [], new Map());
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("exact match (name + phone) -> noop", () => {
    const p = makePerson();
    const c = makeContact();
    const d = decide(c, [p], phoneMap(p));
    expect(d.kind).toBe("noop");
  });

  test("phone match, name matches, new phone -> add_phones, no alert", () => {
    const p = makePerson({ phones: ["0500000000"] });
    const c = makeContact({
      phones: [
        { raw: "0500000000", normalized: "0500000000" },
        { raw: "0511111111", normalized: "0511111111" },
      ],
    });
    const d = decide(c, [p], phoneMap(p));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") {
      expect(d.alerts).toEqual([]);
      expect(d.person.id).toBe(p.id);
    }
  });

  test("phone match, incoming name missing (unknown) -> merge, no alert", () => {
    // A null name is "unknown", not a mismatch — phone proves it's the same
    // person.
    const p = makePerson({ fullname: "Alice", phones: ["0500000000"] });
    const c = makeContact({ fullname: null });
    const d = decide(c, [p], phoneMap(p));
    expect(d.kind).toBe("noop");
  });

  test("phone match, names differ -> insert + symmetric phone_match_name_differs", () => {
    const p = makePerson({ id: "person-A", fullname: "Alice", phones: ["0500000000"] });
    const c = makeContact({ fullname: "Bob" });
    const d = decide(c, [p], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("phone_match_name_differs");
      expect(d.alerts[0].relatedPersonId).toBe("person-A");
      expect(d.alerts[0].details.matchedOn).toBe("phone");
      expect(d.alerts[0].details.mismatchedFields).toEqual(["name"]);
    }
  });

  test("incoming phones span two existing people -> add_phones to first + cross_person alert for the second", () => {
    const a = makePerson({ id: "A", fullname: "Alice", phones: ["0500000000"] });
    const b = makePerson({ id: "B", fullname: "Barbara", phones: ["0511111111"] });
    const c = makeContact({
      fullname: "Alice",
      phones: [
        { raw: "0500000000", normalized: "0500000000" },
        { raw: "0511111111", normalized: "0511111111" },
      ],
    });
    const d = decide(c, [a, b], phoneMap(a, b));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") {
      expect(d.person.id).toBe("A");
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("cross_person_mismatch");
      expect(d.alerts[0].relatedPersonId).toBe("B");
    }
  });

  test("name differs AND a second person owns another incoming phone -> insert + both alerts", () => {
    const a = makePerson({ id: "A", fullname: "Alice", phones: ["0500000000"] });
    const b = makePerson({ id: "B", fullname: "Barbara", phones: ["0511111111"] });
    const c = makeContact({
      fullname: "Bob",
      phones: [
        { raw: "0500000000", normalized: "0500000000" },
        { raw: "0511111111", normalized: "0511111111" },
      ],
    });
    const d = decide(c, [a, b], phoneMap(a, b));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") {
      const kinds = d.alerts.map((al) => al.kind);
      expect(kinds).toContain("phone_match_name_differs");
      expect(kinds).toContain("cross_person_mismatch");
    }
  });
});
