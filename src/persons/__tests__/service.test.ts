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
    fullname: over.fullname ?? "Alice",
    phone: over.phone ?? ["0500000000"],
  };
}

async function seed(c: Contact) {
  const repo = makeRepo(tdb.db);
  await commitContacts([c], "seed.xlsx", repo);
}

describe("commitContacts (phone-only matching)", () => {
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

  test("phoneless contact -> ignored, nothing written", async () => {
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [{ fullname: "Alice", phone: [] }],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.ignored).toBe(1);
    expect(await tdb.db.select().from(persons)).toHaveLength(0);
  });

  test("phone match + name match, new phone -> phoneAdded, no alert", async () => {
    await seed(contact({ phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ phone: ["0500000000", "0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(1);
    expect(result.phoneAdded[0].addedPhones).toEqual(["0511111111"]);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(1);
  });

  test("phone match, name differs -> second citizen + symmetric phone_match_name_differs", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Bob", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    // Phone is the identifier, but the names disagree, so we keep the row as
    // its own citizen and surface a symmetric data-error alert.
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("phone_match_name_differs");
    expect(result.alerts[0].relatedPersonId).not.toBeNull();
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("name match only, different phones -> insert, no alert (homonyms)", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0599999999"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Alice", phone: ["0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(1);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("incoming name missing, phone matches -> noop, no alert", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [{ fullname: null, phone: ["0500000000"] }],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(0);
    expect(result.ignored).toBe(1);
    expect(result.alerts).toHaveLength(0);
  });

  test("partial phone overlap, same name -> merge, no alert", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Alice", phone: ["0500000000", "0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(1);
    expect(result.phoneAdded[0].addedPhones).toEqual(["0511111111"]);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(1);
  });

  test("intra-batch: same name, different phones -> 2 persons, no alert", async () => {
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000000"] },
        { fullname: "Alice", phone: ["0511111111"] },
      ],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(2);
    expect(result.alerts).toHaveLength(0);
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("intra-batch: same phone, different name -> 2 citizens + alert", async () => {
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000000"] },
        { fullname: "Bob", phone: ["0500000000"] },
      ],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(2);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("phone_match_name_differs");
    expect(await tdb.db.select().from(persons)).toHaveLength(2);
  });

  test("alert row written to alerts table with source file", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [contact({ fullname: "Bob", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    const rows = await tdb.db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("phone_match_name_differs");
    expect(rows[0].sourceFile).toBe("file.xlsx");
  });

  test("same phone, different name: symmetric alert visible from both sides", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "רבקה הרצוג", phone: ["0533334445"] },
        { fullname: "דבורה הרצוג", phone: ["0533334445"] },
      ],
      "file.xlsx",
      repo
    );

    const both = await repo.findByPhoneNumbers(["0533334445"]);
    expect(both).toHaveLength(2);
    const rivka = both.find((p) => p.fullname === "רבקה הרצוג")!;
    const dvora = both.find((p) => p.fullname === "דבורה הרצוג")!;
    expect(rivka).toBeDefined();
    expect(dvora).toBeDefined();

    // From רבקה's side: the other person is דבורה.
    const rivkaAlerts = await repo.listOpenAlerts(rivka.id);
    expect(rivkaAlerts).toHaveLength(1);
    expect(rivkaAlerts[0].collidingValue).toBe("0533334445");
    expect(rivkaAlerts[0].relatedPerson?.id).toBe(dvora.id);

    // From דבורה's side: the same alert, mirrored.
    const dvoraAlerts = await repo.listOpenAlerts(dvora.id);
    expect(dvoraAlerts).toHaveLength(1);
    expect(dvoraAlerts[0].id).toBe(rivkaAlerts[0].id);
    expect(dvoraAlerts[0].relatedPerson?.id).toBe(rivka.id);
  });

  test("full upload with two same-phone pairs -> 12 citizens, 2 symmetric alerts", async () => {
    const repo = makeRepo(tdb.db);
    const rows: Contact[] = [
      { fullname: "אבי כהן", phone: ["0501000001"] },
      { fullname: "בני לוי", phone: ["0501000002"] },
      { fullname: "גילה מזרחי", phone: ["0501000003"] },
      { fullname: "דנה פרץ", phone: ["0501000004"] },
      { fullname: "הראל ביטון", phone: ["0501000005"] },
      { fullname: "ורד אדרי", phone: ["0501000006"] },
      // same-phone pair #1
      { fullname: "רבקה הרצוג", phone: ["0533334445"] },
      { fullname: "דבורה הרצוג", phone: ["0533334445"] },
      // same-phone pair #2
      { fullname: "משה ויינברג", phone: ["0577788899"] },
      { fullname: "יצחק ויינברג", phone: ["0577788899"] },
    ];
    const result = await commitContacts(rows, "file.xlsx", repo);

    // 10 rows in, all distinct people -> 10 persons total.
    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(10);
    expect(result.inserted).toHaveLength(10);

    // Exactly two collisions, both phone_match_name_differs.
    expect(result.alerts).toHaveLength(2);
    for (const a of result.alerts) {
      expect(a.kind).toBe("phone_match_name_differs");
      expect(a.relatedPersonId).not.toBeNull();
    }
    const collidingPhones = result.alerts.map((a) => a.collidingValue).sort();
    expect(collidingPhones).toEqual(["0533334445", "0577788899"]);
  });
});
