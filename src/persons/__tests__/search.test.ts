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
        { id: "111", fullname: "David Cohen", phone: ["0500000001"] },
        { id: "222", fullname: "David Levi", phone: ["0500000002"] },
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
        { id: "111", fullname: "David Cohen", phone: ["0500000001"] },
        { id: "222", fullname: "David Levi", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const david1 = (await repo.findByNationalId("111"))!;
    const david2 = (await repo.findByNationalId("222"))!;
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

  test("id search ignores myPagesOnly", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "987654321", fullname: "X", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const r = await searchPersons(
      {
        query: "987654321",
        currentUserId: userA,
        myPagesOnly: true,
      },
      repo
    );
    expect(r.resolvedBy).toBe("id");
    expect(r.hits).toHaveLength(1);
  });

  test("phone search normalizes input", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "1", fullname: "X", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
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

  test("hits include openAlertCount", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "111", fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    await commitContacts(
      [{ id: "111", fullname: "Alicia", phone: ["0500000001"] }],
      "x.xlsx",
      repo
    );
    const r = await searchPersons(
      {
        query: "111",
        by: "id",
        currentUserId: userA,
      },
      repo
    );
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].openAlertCount).toBeGreaterThan(0);
  });
});
