import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { phones } from "../../db/schema";
import { eq } from "drizzle-orm";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

describe("repo", () => {
  test("insertPersonWithPhones persists person + phones", async () => {
    const repo = makeRepo(tdb.db);
    const person = await repo.insertPersonWithPhones({
      nationalId: "123",
      fullname: "Alice",
      sourceFile: "f.xlsx",
      phones: [{ raw: "050-000-0000", normalized: "0500000000" }],
    });
    expect(person.id).toBeTruthy();
    expect(person.phones).toEqual(["050-000-0000"]);

    const phoneRows = await tdb.db
      .select()
      .from(phones)
      .where(eq(phones.personId, person.id));
    expect(phoneRows).toHaveLength(1);
    expect(phoneRows[0].number).toBe("0500000000");
  });

  test("findByPhoneNumbers matches normalized numbers", async () => {
    const repo = makeRepo(tdb.db);
    await repo.insertPersonWithPhones({
      nationalId: "1",
      fullname: "A",
      phones: [{ raw: "0500000000", normalized: "0500000000" }],
    });
    const found = await repo.findByPhoneNumbers(["0500000000"]);
    expect(found).toHaveLength(1);
    expect(found[0].fullname).toBe("A");
  });

  test("findByFullname is case-insensitive", async () => {
    const repo = makeRepo(tdb.db);
    await repo.insertPersonWithPhones({
      nationalId: "1",
      fullname: "Alice",
      phones: [],
    });
    const found = await repo.findByFullname("alice");
    expect(found).toHaveLength(1);
  });

  test("addPhonesToPerson returns only newly added phones", async () => {
    const repo = makeRepo(tdb.db);
    const p = await repo.insertPersonWithPhones({
      nationalId: "1",
      fullname: "A",
      phones: [{ raw: "0500000000", normalized: "0500000000" }],
    });
    const result = await repo.addPhonesToPerson(p.id, [
      { raw: "0500000000", normalized: "0500000000" },
      { raw: "0511111111", normalized: "0511111111" },
    ]);
    expect(result.addedPhones).toEqual(["0511111111"]);
    expect(result.person.phones).toHaveLength(2);
  });

  test("insertAlert stores alert", async () => {
    const repo = makeRepo(tdb.db);
    const p = await repo.insertPersonWithPhones({
      nationalId: "1",
      fullname: "A",
      phones: [],
    });
    const a = await repo.insertAlert({
      kind: "name_mismatch_on_id",
      personId: p.id,
      details: {
        matchedOn: "id",
        mismatchedFields: ["name"],
        incoming: { id: "1", fullname: "A", phone: [] },
      },
      sourceFile: "x",
    });
    expect(a.id).toBeTruthy();
    expect(a.kind).toBe("name_mismatch_on_id");
  });
});
