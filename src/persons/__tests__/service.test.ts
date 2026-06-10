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

  test("case 4: id+phone match, name differs -> alert_only", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Bob", phone: ["0500000000"] })],
      "file.xlsx",
      repo
    );
    expect(result.inserted).toHaveLength(0);
    expect(result.phoneAdded).toHaveLength(0);
    expect(result.ignored).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("name_mismatch_on_id");

    const allPersons = await tdb.db.select().from(persons);
    expect(allPersons).toHaveLength(1);
    expect(allPersons[0].fullname).toBe("Alice"); // unchanged
  });

  test("case 6: id matches, name+phone differ -> add_phones + alert", async () => {
    await seed(contact({ fullname: "Alice", phone: ["0500000000"] }));
    const repo = makeRepo(tdb.db);
    const result = await commitContacts(
      [contact({ fullname: "Bob", phone: ["0511111111"] })],
      "file.xlsx",
      repo
    );
    expect(result.phoneAdded).toHaveLength(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].kind).toBe("name_phone_mismatch_on_id");
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

  test("same ID, different name: alert exposes the shared ID + incoming name (no live related person)", async () => {
    // National ID is unique, so two import rows with the same ID merge
    // into one person. The conflicting row has no person record — it
    // lives only in details.incoming. The alert must still surface a
    // usable collidingValue (the shared ID) so the UI never shows "—".
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "333444555", fullname: "רבקה הרצוג", phone: ["0533334445"] },
        { id: "333444555", fullname: "דבורה הרצוג", phone: ["0533334446"] },
      ],
      "file.xlsx",
      repo
    );
    const person = (await repo.findByNationalId("333444555"))!;
    expect(person.fullname).toBe("רבקה הרצוג");

    const open = await repo.listOpenAlerts(person.id);
    expect(open.length).toBeGreaterThan(0);
    const a = open[0];
    expect(a.errorType).toBe("id_data_error");
    // No second person exists for a same-ID merge.
    expect(a.relatedPerson).toBeNull();
    // The shared ID is surfaced for display instead of null.
    expect(a.collidingValue).toBe("333444555");
    // The conflicting name is preserved in the snapshot for the UI to show.
    expect(a.details.incoming.fullname).toBe("דבורה הרצוג");
  });
});
