import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { updatePerson } from "../update";
import { commitContacts } from "../service";
import { users } from "../../db/schema";

let tdb: TestDb;
let userId: string;

beforeEach(async () => {
  tdb = await makeTestDb();
  const [user] = await tdb.db
    .insert(users)
    .values({ username: "editor", passwordHash: "x" })
    .returning();
  userId = user.id;
});

afterEach(async () => {
  await tdb.close();
});

describe("updatePerson", () => {
  test("updates fullname and writes audit row with reason", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "111", fullname: "Alise", phone: ["0500000000"] }],
      "seed.xlsx",
      repo
    );
    const person = (await repo.findByNationalId("111"))!;
    const result = await updatePerson(
      {
        personId: person.id,
        fullname: "Alice",
        reason: "spoke on phone, real name is Alice",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.person.fullname).toBe("Alice");
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].field).toBe("fullname");
    expect(result.audit[0].oldValue).toBe("Alise");
    expect(result.audit[0].newValue).toBe("Alice");
    expect(result.audit[0].reason).toBe("spoke on phone, real name is Alice");
  });

  test("rejects when nationalId collides with another person", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "111", fullname: "Alice", phone: ["0500000001"] },
        { id: "222", fullname: "Bob", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
    const result = await updatePerson(
      { personId: alice.id, nationalId: "222" },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    if ("notFound" in result) throw new Error("expected conflicts");
    expect(result.conflicts.length).toBeGreaterThan(0);

    const reloaded = (await repo.findById(alice.id))!;
    expect(reloaded.nationalId).toBe("111");
  });

  test("rejects when adding a phone that belongs to another person with a different name", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "111", fullname: "Alice", phone: ["0500000001"] },
        { id: "222", fullname: "Bob", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
    const result = await updatePerson(
      { personId: alice.id, phones: { add: ["0500000002"] } },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
  });

  test("auto-resolves an open alert whose cause is fixed", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "111", fullname: "Alice", phone: ["0500000000"] }],
      "seed.xlsx",
      repo
    );
    await commitContacts(
      [{ id: "111", fullname: "Alicia", phone: ["0500000000"] }],
      "second.xlsx",
      repo
    );
    const person = (await repo.findByNationalId("111"))!;
    let openBefore = await repo.listOpenAlerts(person.id);
    expect(openBefore.length).toBeGreaterThan(0);

    const result = await updatePerson(
      { personId: person.id, fullname: "Alicia", reason: "called, correct name is Alicia" },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.resolvedAlerts.length).toBeGreaterThan(0);
    expect(result.resolvedAlerts[0].resolvedByUserId).toBe(userId);

    const openAfter = await repo.listOpenAlerts(person.id);
    expect(openAfter).toHaveLength(0);
  });

  test("removes a phone and writes a phone_removed audit row", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "111", fullname: "Alice", phone: ["0500000001", "0500000002"] }],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
    const result = await updatePerson(
      {
        personId: alice.id,
        phones: { remove: ["0500000002"] },
        reason: "wrong number",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.person.phones).toHaveLength(1);
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].field).toBe("phone_removed");
    expect(result.audit[0].oldValue).toBe("0500000002");
  });

  test("returns notFound for missing person", async () => {
    const repo = makeRepo(tdb.db);
    const result = await updatePerson(
      { personId: "00000000-0000-0000-0000-000000000000", fullname: "X" },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect("notFound" in result).toBe(true);
  });
});
