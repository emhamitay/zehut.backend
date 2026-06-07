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
      [{ id: "111", fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
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
      [{ id: "111", fullname: "Alice", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
    const result = await deletePersonAction(
      {
        personId: alice.id,
        reason: "duplicate of citizen 222",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].field).toBe("deleted");
    expect(result.audit[0].reason).toBe("duplicate of citizen 222");
    expect(result.audit[0].newValue).toContain("Alice");

    const reloaded = await repo.findById(alice.id);
    expect(reloaded).toBeNull();
  });

  test("nullifies relatedPersonId on alerts pointing to the deleted person", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "111", fullname: "Alice", phone: ["0500000001"] },
        { id: null, fullname: "Bob", phone: ["0500000001"] },
      ],
      "seed.xlsx",
      repo
    );
    const alice = (await repo.findByNationalId("111"))!;
    const bob = (await repo.findByFullname("Bob"))[0];
    expect(bob).toBeDefined();

    const bobAlertsBefore = await repo.listOpenAlerts(bob.id);
    expect(bobAlertsBefore.length).toBeGreaterThan(0);
    const alertPointingToAlice = bobAlertsBefore.find(
      (a) => a.relatedPersonId === alice.id
    );
    expect(alertPointingToAlice).toBeDefined();

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
    expect(bobAlertsAfter.length).toBeGreaterThan(0);
    const sameAlertAfter = bobAlertsAfter.find(
      (a) => a.id === alertPointingToAlice!.id
    );
    expect(sameAlertAfter).toBeDefined();
    expect(sameAlertAfter!.relatedPersonId).toBeNull();
  });
});
