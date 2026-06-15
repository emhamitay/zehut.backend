import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { searchPersons } from "../search";
import { commitContacts } from "../service";
import { contactPageEntries, contactPages, users } from "../../db/schema";

let tdb: TestDb;
let userA: string;
let userB: string;

beforeEach(async () => {
  tdb = await makeTestDb();
  const inserted = await tdb.db
    .insert(users)
    .values([
      { username: "a", passwordHash: "x" },
      { username: "b", passwordHash: "x" },
    ])
    .returning();
  userA = inserted[0].id;
  userB = inserted[1].id;
});

afterEach(async () => {
  await tdb.close();
});

async function attach(personId: string, userId: string, pageNumber: number) {
  const [page] = await tdb.db
    .insert(contactPages)
    .values({ season: "2026", createdByUserId: userId, pageNumber })
    .returning();
  await tdb.db
    .insert(contactPageEntries)
    .values({ contactPageId: page.id, personId, season: "2026" });
}

describe("searchPersons", () => {
  test("substring name match", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "David Cohen", phone: ["0500000001"] },
        { fullname: "David Levi", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const r = await searchPersons(
      {
        query: "david",
        by: "name",
        currentUserId: userA,
        myPagesOnly: false,
      },
      repo
    );
    expect(r.resolvedBy).toBe("name");
    expect(r.hits).toHaveLength(2);
  });

  test("myPagesOnly excludes citizens not on the user's pages", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "David Cohen", phone: ["0500000001"] },
        { fullname: "David Levi", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const david1 = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const david2 = (await repo.findByPhoneNumbers(["0500000002"]))[0];
    await attach(david1.id, userA, 1);
    await attach(david2.id, userB, 2);

    const r = await searchPersons(
      {
        query: "david",
        by: "name",
        currentUserId: userA,
        myPagesOnly: true,
      },
      repo
    );
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].person.id).toBe(david1.id);
  });

  test("auto-detects an all-digit query as a phone search", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "X", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const r = await searchPersons(
      {
        query: "0500000001",
        currentUserId: userA,
        myPagesOnly: true,
      },
      repo
    );
    expect(r.resolvedBy).toBe("phone");
    expect(r.hits).toHaveLength(1);
  });

  test("phone search ignores myPagesOnly", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "X", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const x = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    await attach(x.id, userB, 1);

    const r = await searchPersons(
      {
        query: "050-000-0001",
        by: "phone",
        currentUserId: userA,
        myPagesOnly: true,
      },
      repo
    );
    expect(r.hits).toHaveLength(1);
  });

  test("phone search surfaces both citizens of a collision, each with an open alert", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    await commitContacts(
      [{ fullname: "Alicia", phone: ["0500000001"] }],
      "x.xlsx",
      repo
    );
    const r = await searchPersons(
      {
        query: "0500000001",
        by: "phone",
        currentUserId: userA,
      },
      repo
    );
    // Two citizens share the phone with different names, so both surface
    // and each carries the symmetric data-error alert.
    expect(r.hits).toHaveLength(2);
    for (const hit of r.hits) {
      expect(hit.openAlertCount).toBeGreaterThan(0);
    }
  });
});
