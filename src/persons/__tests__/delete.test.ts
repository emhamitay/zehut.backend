import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { deletePersonAction } from "../delete";
import { commitContacts } from "../service";
import { users, alerts as alertsTable } from "../../db/schema";
import { eq } from "drizzle-orm";

let tdb: TestDb;
let userId: string;

beforeEach(async () => {
  tdb = await makeTestDb();
  const [user] = await tdb.db
    .insert(users)
    .values({ username: "remover", passwordHash: "x" })
    .returning();
  userId = user.id;
});

afterEach(async () => {
  await tdb.close();
});

describe("deletePersonAction", () => {
  test("rejects when reason is missing", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const result = await deletePersonAction(
      { personId: alice.id, reason: "   " },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.error).toBe("missing_reason");

    const reloaded = await repo.findById(alice.id);
    expect(reloaded).not.toBeNull();
  });

  test("returns not_found for missing person", async () => {
    const repo = makeRepo(tdb.db);
    const result = await deletePersonAction(
      {
        personId: "00000000-0000-0000-0000-000000000000",
        reason: "test",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.error).toBe("not_found");
  });

  test("deletes person and writes a surviving 'deleted' audit row", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const result = await deletePersonAction(
      {
        personId: alice.id,
        reason: "duplicate of another citizen",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].field).toBe("deleted");
    expect(result.audit[0].reason).toBe("duplicate of another citizen");
    expect(result.audit[0].newValue).toContain("Alice");

    const reloaded = await repo.findById(alice.id);
    expect(reloaded).toBeNull();
  });

  test("deletes alerts touching the removed person on both sides", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000001"] },
        { fullname: "Bob", phone: ["0500000001"] },
      ],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByFullname("Alice"))[0];
    const bob = (await repo.findByFullname("Bob"))[0];
    expect(bob).toBeDefined();

    // Alerts now have a binary lifecycle, and an alert "touches" a person
    // symmetrically (either personId or relatedPersonId). After deleting
    // Alice, every alert that referenced her — from either side — should
    // be gone, not left dangling with a nulled relatedPersonId.
    const bobAlertsBefore = await repo.listOpenAlerts(bob.id);
    expect(bobAlertsBefore.length).toBeGreaterThan(0);

    await deletePersonAction(
      { personId: alice.id, reason: "duplicate" },
      userId,
      repo
    );

    const stillPointing = await tdb.db
      .select()
      .from(alertsTable)
      .where(eq(alertsTable.relatedPersonId, alice.id));
    expect(stillPointing).toHaveLength(0);

    const bobAlertsAfter = await repo.listOpenAlerts(bob.id);
    expect(bobAlertsAfter).toHaveLength(0);
  });
});
