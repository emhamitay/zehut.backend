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

  test("rejects when both null-id persons collide via shared phone", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: null, fullname: "David", phone: ["0501111111"] },
        { id: null, fullname: "David", phone: ["0502222222"] },
      ],
      "seed.xlsx",
      repo
    );
    const both = await repo.findByFullname("David");
    expect(both).toHaveLength(2);
    const a = both[0];
    const result = await updatePerson(
      {
        personId: a.id,
        phones: { add: ["0502222222"] },
        reason: "merging onto B",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    if ("notFound" in result) throw new Error("expected conflicts");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].otherPerson.id).not.toBe(a.id);

    const reloaded = (await repo.findById(a.id))!;
    expect(reloaded.phones).toHaveLength(1);
  });

  test("rejects when both null-id persons collide via name-only match", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: null, fullname: "Yossi Cohen", phone: ["0503333333"] },
        { id: null, fullname: "Shimon Cohen", phone: ["0504444444"] },
      ],
      "seed.xlsx",
      repo
    );
    const shimon = (await repo.findByFullname("Shimon Cohen"))[0];
    const result = await updatePerson(
      {
        personId: shimon.id,
        fullname: "Yossi Cohen",
        reason: "renaming",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    if ("notFound" in result) throw new Error("expected conflicts");
    expect(result.conflicts.length).toBeGreaterThan(0);

    const reloaded = (await repo.findById(shimon.id))!;
    expect(reloaded.fullname).toBe("Shimon Cohen");
  });

  test("returns audit rows for all changes when several fields change at once", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "555", fullname: "Original", phone: ["0506666666"] }],
      "seed.xlsx",
      repo
    );
    const person = (await repo.findByNationalId("555"))!;
    const result = await updatePerson(
      {
        personId: person.id,
        fullname: "Updated",
        nationalId: "556",
        phones: { add: ["0507777777"], remove: ["0506666666"] },
        reason: "full rewrite",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const fieldCounts = result.audit.reduce<Record<string, number>>(
      (acc, r) => {
        acc[r.field] = (acc[r.field] ?? 0) + 1;
        return acc;
      },
      {}
    );
    expect(fieldCounts.nationalId).toBe(1);
    expect(fieldCounts.fullname).toBe(1);
    expect(fieldCounts.phone_added).toBe(1);
    expect(fieldCounts.phone_removed).toBe(1);

    const history = await repo.listAudit(person.id);
    expect(history.length).toBe(4);
  });

  test("allows editing back to its own values without conflict", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ id: "999", fullname: "Solo", phone: ["0505555555"] }],
      "seed.xlsx",
      repo
    );
    const solo = (await repo.findByNationalId("999"))!;
    const result = await updatePerson(
      {
        personId: solo.id,
        fullname: "Solo Updated",
        reason: "fix typo",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.person.fullname).toBe("Solo Updated");
  });
});
