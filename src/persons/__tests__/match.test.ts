import { describe, expect, test } from "bun:test";
import { decide, type NormalizedContact } from "../match";
import type { PersonWithPhones } from "../repo";

function makePerson(over: Partial<PersonWithPhones> = {}): PersonWithPhones {
  return {
    id: over.id ?? "person-1",
    nationalId: over.nationalId ?? "111",
    fullname: over.fullname ?? "Alice",
    sourceFile: over.sourceFile ?? null,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
    phones: over.phones ?? ["0500000000"],
  };
}

function makeContact(over: Partial<NormalizedContact> = {}): NormalizedContact {
  return {
    raw: {
      id: over.nationalId ?? "111",
      fullname: over.fullname ?? "Alice",
      phone: (over.phones ?? [{ raw: "0500000000", normalized: "0500000000" }])
        .map((p) => p.raw),
    },
    nationalId: over.nationalId ?? "111",
    fullname: over.fullname ?? "Alice",
    phones: over.phones ?? [{ raw: "0500000000", normalized: "0500000000" }],
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

describe("decide", () => {
  test("clean new -> insert with no alerts", () => {
    const c = makeContact();
    const d = decide(c, null, [], [], new Map());
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("exact match (id+name+phone) -> noop", () => {
    const p = makePerson();
    const c = makeContact();
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("noop");
  });

  test("id+name match, phone differs -> add_phones (case 7)", () => {
    const p = makePerson({ phones: ["0500000000"] });
    const c = makeContact({
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") expect(d.alerts).toEqual([]);
  });

  test("id+phone match, name differs -> alert_only (case 4)", () => {
    const p = makePerson({ fullname: "Alice" });
    const c = makeContact({ fullname: "Bob" });
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("alert_only");
    if (d.kind === "alert_only") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("name_mismatch_on_id");
    }
  });

  test("id matches, name+phone differ -> add_phones + alert (case 6)", () => {
    const p = makePerson({ fullname: "Alice", phones: ["0500000000"] });
    const c = makeContact({
      fullname: "Bob",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("name_phone_mismatch_on_id");
    }
  });

  test("phone+name match, id differs -> insert + alert (case 1)", () => {
    const p = makePerson({ nationalId: "999" });
    const c = makeContact({ nationalId: "111" });
    const d = decide(c, null, [p], [p], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("id_mismatch_name_phone_match");
      expect(d.alerts[0].relatedPersonId).toBe(p.id);
    }
  });

  test("phone match, id+name differ -> insert + alert (cases 2/5)", () => {
    const p = makePerson({ nationalId: "999", fullname: "Alice" });
    const c = makeContact({ nationalId: "111", fullname: "Bob" });
    const d = decide(c, null, [p], [], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("id_name_mismatch_on_phone");
    }
  });

  test("name only match -> insert, no alert (case 3 homonyms)", () => {
    const p = makePerson({
      nationalId: "999",
      fullname: "Alice",
      phones: ["0599999999"],
    });
    const c = makeContact({
      nationalId: "111",
      fullname: "Alice",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, null, [], [p], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("null id on incoming, name+phone match by id lookup -> no name mismatch alert", () => {
    // Existing has full data; incoming is missing the name (null is not a mismatch).
    const p = makePerson({ fullname: "Alice", phones: ["0500000000"] });
    const c: NormalizedContact = {
      raw: { id: "111", fullname: null as any, phone: ["0500000000"] },
      nationalId: "111",
      fullname: null,
      phones: [{ raw: "0500000000", normalized: "0500000000" }],
    };
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("noop");
  });

  test("null name on incoming, id matches, new phone -> add_phones, no alert", () => {
    const p = makePerson({ fullname: "Alice", phones: ["0500000000"] });
    const c: NormalizedContact = {
      raw: { id: "111", fullname: null as any, phone: ["0511111111"] },
      nationalId: "111",
      fullname: null,
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    };
    const d = decide(c, p, [], [], phoneMap(p));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") expect(d.alerts).toEqual([]);
  });

  test("same name, no ids on either side, no phone overlap -> insert silently", () => {
    // Homonyms with no shared unique field are real and silent. The
    // system no longer raises an alert just because two records have
    // the same name.
    const p: PersonWithPhones = {
      ...makePerson({ fullname: "Alice", phones: ["0599999999"] }),
      nationalId: null,
    };
    const c: NormalizedContact = {
      raw: { id: null as any, fullname: "Alice", phone: ["0511111111"] },
      nationalId: null,
      fullname: "Alice",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    };
    const d = decide(c, null, [], [p], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("same name, both have IDs but they differ, no phone overlap -> insert, no alert", () => {
    // True homonyms with different IDs prove distinct people.
    const p = makePerson({
      nationalId: "999",
      fullname: "Alice",
      phones: ["0599999999"],
    });
    const c = makeContact({
      nationalId: "111",
      fullname: "Alice",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, null, [], [p], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") expect(d.alerts).toEqual([]);
  });

  test("same name + partial phone overlap, no ids -> merge, no alert", () => {
    const p: PersonWithPhones = {
      ...makePerson({ fullname: "Alice", phones: ["0500000000"] }),
      nationalId: null,
    };
    const c: NormalizedContact = {
      raw: { id: null as any, fullname: "Alice", phone: ["0500000000", "0511111111"] },
      nationalId: null,
      fullname: "Alice",
      phones: [
        { raw: "0500000000", normalized: "0500000000" },
        { raw: "0511111111", normalized: "0511111111" },
      ],
    };
    const d = decide(c, null, [p], [p], phoneMap(p));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") {
      expect(d.alerts).toEqual([]);
      expect(d.person.id).toBe(p.id);
    }
  });

  test("incoming has id, existing has null id, name+phone match -> backfill_id_and_add_phones, no alert", () => {
    const p: PersonWithPhones = {
      ...makePerson({ fullname: "Alice", phones: ["0500000000"] }),
      nationalId: null,
    };
    const c = makeContact({
      nationalId: "111",
      fullname: "Alice",
      phones: [{ raw: "0500000000", normalized: "0500000000" }],
    });
    const d = decide(c, null, [p], [p], phoneMap(p));
    expect(d.kind).toBe("backfill_id_and_add_phones");
    if (d.kind === "backfill_id_and_add_phones") {
      expect(d.nationalId).toBe("111");
      expect(d.alerts).toEqual([]);
      expect(d.person.id).toBe(p.id);
    }
  });

  test("phone match, both names present and differ, no ids -> insert + phone_match_name_differs_no_id", () => {
    const p: PersonWithPhones = {
      ...makePerson({ fullname: "Alice", phones: ["0500000000"] }),
      nationalId: null,
    };
    const c: NormalizedContact = {
      raw: { id: null as any, fullname: "Bob", phone: ["0500000000"] },
      nationalId: null,
      fullname: "Bob",
      phones: [{ raw: "0500000000", normalized: "0500000000" }],
    };
    const d = decide(c, null, [p], [], phoneMap(p));
    expect(d.kind).toBe("insert");
    if (d.kind === "insert") {
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0].kind).toBe("phone_match_name_differs_no_id");
      expect(d.alerts[0].details.mismatchedFields).toEqual(["name"]);
      expect(d.alerts[0].relatedPersonId).toBe(p.id);
    }
  });

  test("cross-person mismatch: id matches A, phone matches B", () => {
    const a = makePerson({ id: "A", nationalId: "111", phones: ["0500000000"] });
    const b = makePerson({ id: "B", nationalId: "222", phones: ["0511111111"] });
    const c = makeContact({
      nationalId: "111",
      fullname: "Alice",
      phones: [{ raw: "0511111111", normalized: "0511111111" }],
    });
    const d = decide(c, a, [b], [], phoneMap(a, b));
    expect(d.kind).toBe("add_phones");
    if (d.kind === "add_phones") {
      const kinds = d.alerts.map((a) => a.kind);
      expect(kinds).toContain("cross_person_mismatch");
    }
  });
});
