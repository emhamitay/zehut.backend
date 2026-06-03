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
});
