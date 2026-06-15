import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo, type Repo } from "../repo";
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

async function onlyByPhone(repo: Repo, phone: string) {
  return (await repo.findByPhoneNumbers([phone]))[0]!;
}

describe("updatePerson", () => {
  test("updates fullname and writes audit row with reason", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Alise", phone: ["0500000000"] }],
      "seed.xlsx",
      repo
    );
    const person = await onlyByPhone(repo, "0500000000");
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

  test("rejects when adding a phone that belongs to another person with a different name", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000001"] },
        { fullname: "Bob", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const alice = await onlyByPhone(repo, "0500000001");
    const result = await updatePerson(
      { personId: alice.id, phones: { add: ["0500000002"] } },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    if ("notFound" in result) throw new Error("expected conflicts");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].kind).toBe("phone_match_name_differs");

    const reloaded = (await repo.findById(alice.id))!;
    expect(reloaded.phones).toHaveLength(1);
  });

  test("deletes an open alert whose cause is fixed and records an alert_closed audit row", async () => {
    const repo = makeRepo(tdb.db);
    // Two rows sharing a phone with different names -> two citizens plus a
    // symmetric phone_match_name_differs alert. Fixing it means removing
    // the shared phone from one side.
    await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000001"] },
        { fullname: "Bob", phone: ["0500000001", "0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const bob = (await repo.findByFullname("Bob"))[0]!;
    const openBefore = await repo.listOpenAlerts(bob.id);
    expect(openBefore.length).toBeGreaterThan(0);

    const result = await updatePerson(
      {
        personId: bob.id,
        phones: { remove: ["0500000001"] },
        reason: "wrong shared number",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.closedAlerts.length).toBeGreaterThan(0);
    // Each closed alert leaves an `alert_closed` audit row as the only
    // record that this person used to have a data error.
    const closedAuditRows = result.audit.filter(
      (a) => a.field === "alert_closed"
    );
    expect(closedAuditRows.length).toBe(result.closedAlerts.length);

    const openAfter = await repo.listOpenAlerts(bob.id);
    expect(openAfter).toHaveLength(0);
  });

  test("removes a phone and writes a phone_removed audit row", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Alice", phone: ["0500000001", "0500000002"] }],
      "seed.xlsx",
      repo
    );
    const alice = await onlyByPhone(repo, "0500000001");
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

  test("rejects when two homonyms collide via a shared phone", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "David", phone: ["0501111111"] },
        { fullname: "David", phone: ["0502222222"] },
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

  test("name-only matches are not a blocker — renaming to a homonym just saves", async () => {
    // A bare name match (no shared phone) is not a uniqueness violation.
    // Homonyms are real, and the system stays silent about them.
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "Yossi Cohen", phone: ["0503333333"] },
        { fullname: "Shimon Cohen", phone: ["0504444444"] },
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const reloaded = (await repo.findById(shimon.id))!;
    expect(reloaded.fullname).toBe("Yossi Cohen");
  });

  test("returns audit rows for all changes when several fields change at once", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Original", phone: ["0506666666"] }],
      "seed.xlsx",
      repo
    );
    const person = await onlyByPhone(repo, "0506666666");
    const result = await updatePerson(
      {
        personId: person.id,
        fullname: "Updated",
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
    expect(fieldCounts.fullname).toBe(1);
    expect(fieldCounts.phone_added).toBe(1);
    expect(fieldCounts.phone_removed).toBe(1);

    const history = await repo.listAudit(person.id);
    expect(history.length).toBe(3);
  });

  test("allows editing back to its own values without conflict", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Solo", phone: ["0505555555"] }],
      "seed.xlsx",
      repo
    );
    const solo = await onlyByPhone(repo, "0505555555");
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
