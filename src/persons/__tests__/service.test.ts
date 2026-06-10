import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { commitContacts } from "../service";
import type { Contact } from "../../lib/types";
import { alerts, persons } from "../../db/schema";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: over.id ?? "111",
    fullname: over.fullname ?? "Alice",
    phone: over.phone ?? ["0500000000"],
  };
}

async function seed(c: Contact) {
  const repo = makeRepo(tdb.db);
  await commitContacts([c], "seed.xlsx", repo);
}

describe("commitContacts", () => {
  test("inserts a clean new contact", async () => {
    const repo = makeRepo(tdb.db);
    const result = await commitContacts([contact()], "file.xlsx", repo);
    expect(result.inserted).toHaveLength(1);
    expect(result.ignored).toBe(0);
    expect(result.phoneAdded).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(1);
  });

  test("exact duplicate -> ignored", async () => {
    await seed(contact());
    const repo = makeRepo(tdb.db);
    const result = await commitContacts([contact()], "file.xlsx", repo);
    expect(result.inserted).toHaveLength(0);
    expect(result.ignored).toBe(1);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(1);
  });

  test("case 7: id+name match, new phone -> phoneAdded, no alert", async () => {
    await seed(contact({ phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ phone: ["0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(1);
    expect(result.phoneAdded[0].addedPhones).toEqual(["0511111111"]);
    expect(result.alerts).toHaveLength(0);

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(1);
  });

  test("case 4: same id, name differs -> insert second person + symmetric alert", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Bob", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    // National ID is no longer unique: the conflicting row becomes its
    // own citizen, and the collision is a symmetric data-error alert.
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("name_mismatch_on_id");
    expect(result.alerts[0].relatedPersonId).not.toBeNull();

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(2);
  });

  test("case 6: same id, name+phone differ -> insert second person + symmetric alert", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Bob", phone: ["0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("name_mismatch_on_id");
    expect(result.alerts[0].relatedPersonId).not.toBeNull();

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(2);
  });

  test("case 1: id mismatch, name+phone match -> insert + alert", async () => {
    await seed(contact({ id: "999", fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ id: "111", fullname: "Alice", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("id_mismatch_name_phone_match");
    expect(result.alerts[0].relatedPersonId).not.toBeNull();

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(2);
  });

  test("cases 2/5: phone matches, id+name differ -> insert + alert", async () => {
    await seed(contact({ id: "999", fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ id: "111", fullname: "Bob", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("id_name_mismatch_on_phone");
  });

  test("case 3: name match only -> insert, no alert", async () => {
    await seed(contact({ id: "999", fullname: "Alice", phone: ["0599999999"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ id: "111", fullname: "Alice", phone: ["0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("null id on incoming, name+phone match an existing person -> noop, no alert", async () => {
    await seed(contact({ id: "111", fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [{ id: null as any, fullname: "Alice", phone: ["0500000000"] }],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(0);
    expect(result.ignored).toBe(1);
    expect(result.alerts).toHaveLength(0);
  });

  test("homonyms with no ids -> insert silently, no alert (homonyms are real)", async () => {
    await seed({ id: null as any, fullname: "Alice", phone: ["0500000000"] });
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [{ id: null as any, fullname: "Alice", phone: ["0511111111"] }],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("homonyms with no ids, partial phone overlap -> merge, no alert", async () => {
    await seed({ id: null as any, fullname: "Alice", phone: ["0500000000"] });
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [
        {
          id: null as any,
          fullname: "Alice",
          phone: ["0500000000", "0511111111"],
        },
      ],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(1);
    expect(result.phoneAdded[0].addedPhones).toEqual(["0511111111"]);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(1);
  });

  test("incoming has id, existing has null id, name+phone match -> backfill id", async () => {
    await seed({ id: null as any, fullname: "Alice", phone: ["0500000000"] });
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ id: "111", fullname: "Alice", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);
    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(1);
    expect(allPersons[0].nationalId).toBe("111");
  });

  test("phone-only match, both names present and differ, no ids -> insert + phone_match_name_differs_no_id", async () => {
    await seed({ id: null as any, fullname: "Alice", phone: ["0500000000"] });
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [{ id: null as any, fullname: "Bob", phone: ["0500000000"] }],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("phone_match_name_differs_no_id");
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("intra-batch: two rows same name, no ids, different phones -> 2 persons, no alert", async () => {
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [
        { id: null as any, fullname: "Alice", phone: ["0500000000"] },
        { id: null as any, fullname: "Alice", phone: ["0511111111"] },
      ],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(2);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("alerts row written to alerts table", async () => {
    await seed(contact({ id: "999", fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [contact({ id: "111", fullname: "Alice", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    const rows = await tdb.db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("id_mismatch_name_phone_match");
    expect(rows[0].sourceFile).toBe("file.xlsx");
  });

  test("same ID, different name: two citizens + symmetric alert visible from both sides", async () => {
    // National ID is no longer unique. The two import rows are two
    // separate citizens; the collision is a symmetric data-error alert
    // that each citizen sees with the *other* as relatedPerson.
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "333444555", fullname: "רבקה הרצוג", phone: ["0533334445"] },
        { id: "333444555", fullname: "דבורה הרצוג", phone: ["0533334446"] },
      ],
      "file.xlsx",
      repo
    );

    const both = await repo.findAllByNationalId("333444555");
    expect(both).toHaveLength(2);
    const rivka = both.find((p) => p.fullname === "רבקה הרצוג")!;
    const dvora = both.find((p) => p.fullname === "דבורה הרצוג")!;
    expect(rivka).toBeDefined();
    expect(dvora).toBeDefined();

    // From רבקה's side: the other person is דבורה.
    const rivkaAlerts = await repo.listOpenAlerts(rivka.id);
    expect(rivkaAlerts).toHaveLength(1);
    expect(rivkaAlerts[0].errorType).toBe("id_data_error");
    expect(rivkaAlerts[0].collidingValue).toBe("333444555");
    expect(rivkaAlerts[0].relatedPerson?.id).toBe(dvora.id);

    // From דבורה's side: the same alert, mirrored.
    const dvoraAlerts = await repo.listOpenAlerts(dvora.id);
    expect(dvoraAlerts).toHaveLength(1);
    expect(dvoraAlerts[0].id).toBe(rivkaAlerts[0].id);
    expect(dvoraAlerts[0].relatedPerson?.id).toBe(rivka.id);
  });

  test("full upload with two same-ID pairs -> 2 extra citizens, 2 symmetric id alerts", async () => {
    // Reproduces the user's file: ten clean rows plus two same-ID pairs.
    const repo = makeRepo(tdb.db);
    const rows: Contact[] = [
      { id: "100000001", fullname: "אבי כהן", phone: ["0501000001"] },
      { id: "100000002", fullname: "בני לוי", phone: ["0501000002"] },
      { id: "100000003", fullname: "גילה מזרחי", phone: ["0501000003"] },
      { id: "100000004", fullname: "דנה פרץ", phone: ["0501000004"] },
      { id: "100000005", fullname: "הראל ביטון", phone: ["0501000005"] },
      { id: "100000006", fullname: "ורד אדרי", phone: ["0501000006"] },
      // same-ID pair #1
      { id: "333444555", fullname: "רבקה הרצוג", phone: ["0533334445"] },
      { id: "333444555", fullname: "דבורה הרצוג", phone: ["0533334446"] },
      // same-ID pair #2
      { id: "777888999", fullname: "משה ויינברג", phone: ["0577788899"] },
      { id: "777888999", fullname: "יצחק ויינברג", phone: ["0577788900"] },
    ];
    const result = await commitContacts(rows, "file.xlsx", repo);

    // 10 rows in, all distinct people -> 10 persons total.
    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(10);
    expect(result.inserted).toHaveLength(10);

    // Exactly two collisions, both id_data_error.
    expect(result.alerts).toHaveLength(2);
    for (const a of result.alerts) {
      expect(a.errorType).toBe("id_data_error");
      expect(a.relatedPersonId).not.toBeNull();
    }
    const collidingIds = result.alerts.map((a) => a.collidingValue).sort();
    expect(collidingIds).toEqual(["333444555", "777888999"]);
  });
});
