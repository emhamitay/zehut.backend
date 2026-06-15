import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { mergePersons } from "../merge";
import { commitContacts } from "../service";
import { contactPageEntries, contactPages, users } from "../../db/schema";
import { eq } from "drizzle-orm";

let tdb: TestDb;
let userId: string;

beforeEach(async () => {
  tdb = await makeTestDb();
  const [user] = await tdb.db
    .insert(users)
    .values({ username: "merger", passwordHash: "x" })
    .returning();
  userId = user.id;
});

afterEach(async () => {
  await tdb.close();
});

describe("mergePersons", () => {
  test("merges victim phones and contact-page entries into survivor", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "David", phone: ["0500000001"] },
        { fullname: "David Cohen", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const survivor = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const victim = (await repo.findByPhoneNumbers(["0500000002"]))[0];

    const [page] = await tdb.db
      .insert(contactPages)
      .values({ season: "2026", createdByUserId: userId, pageNumber: 1 })
      .returning();
    await tdb.db.insert(contactPageEntries).values({
      contactPageId: page.id,
      personId: victim.id,
      season: "2026",
    });

    const result = await mergePersons(
      {
        survivorId: survivor.id,
        victimId: victim.id,
        resolved: { fullname: "David Cohen" },
        phonesToKeep: ["0500000001", "0500000002"],
        reason: "same person, two excel rows",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.person.fullname).toBe("David Cohen");
    expect(result.person.phones).toHaveLength(2);

    const victimGone = await repo.findById(victim.id);
    expect(victimGone).toBeNull();

    const entries = await tdb.db
      .select()
      .from(contactPageEntries)
      .where(eq(contactPageEntries.personId, survivor.id));
    expect(entries).toHaveLength(1);

    expect(result.audit.some((r) => r.field === "merged_from")).toBe(true);
  });

  test("merging two citizens that shared a phone clears the symmetric alert", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "Alice", phone: ["0500000001"] },
        { fullname: "Alice K.", phone: ["0500000001"] },
      ],
      "seed.xlsx",
      repo
    );
    const both = await repo.findByPhoneNumbers(["0500000001"]);
    expect(both).toHaveLength(2);
    const survivor = both.find((p) => p.fullname === "Alice")!;
    const victim = both.find((p) => p.fullname === "Alice K.")!;
    expect((await repo.listOpenAlerts(survivor.id)).length).toBeGreaterThan(0);

    const result = await mergePersons(
      {
        survivorId: survivor.id,
        victimId: victim.id,
        resolved: { fullname: "Alice" },
        phonesToKeep: ["0500000001"],
        reason: "same person",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(true);
    expect(await repo.listOpenAlerts(survivor.id)).toHaveLength(0);
  });

  test("rejects merging a person into itself", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [{ fullname: "Solo", phone: ["0500000001"] }],
      "seed.xlsx",
      repo
    );
    const solo = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const result = await mergePersons(
      {
        survivorId: solo.id,
        victimId: solo.id,
        resolved: { fullname: "Solo" },
        phonesToKeep: ["0500000001"],
        reason: "oops",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect("error" in result && result.error).toBe("same_person");
  });

  test("requires a reason", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { fullname: "A", phone: ["0500000001"] },
        { fullname: "B", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const a = (await repo.findByPhoneNumbers(["0500000001"]))[0];
    const b = (await repo.findByPhoneNumbers(["0500000002"]))[0];
    const result = await mergePersons(
      {
        survivorId: a.id,
        victimId: b.id,
        resolved: { fullname: "A" },
        phonesToKeep: ["0500000001", "0500000002"],
        reason: "   ",
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
  });
});
