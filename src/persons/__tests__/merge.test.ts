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
        { id: null, fullname: "David", phone: ["0500000001"] },
        { id: null, fullname: "David Cohen", phone: ["0500000002"] },
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
        resolved: {
          nationalId: null,
          fullname: "David Cohen",
        },
        phonesToKeep: ["0500000001", "0500000002"],
        reason: "same person, two excel rows",
        confirmDifferentIds: false,
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

  test("rejects merge with differing national_ids unless confirmed", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: "111", fullname: "Alice", phone: ["0500000001"] },
        { id: "222", fullname: "Alice", phone: ["0500000002"] },
      ],
      "seed.xlsx",
      repo
    );
    const a = (await repo.findByNationalId("111"))!;
    const b = (await repo.findByNationalId("222"))!;
    const result = await mergePersons(
      {
        survivorId: a.id,
        victimId: b.id,
        resolved: { nationalId: "111", fullname: "Alice" },
        phonesToKeep: ["0500000001", "0500000002"],
        reason: "same",
        confirmDifferentIds: false,
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect("error" in result && result.error).toBe("confirm_required");
  });

  test("requires a reason", async () => {
    const repo = makeRepo(tdb.db);
    await commitContacts(
      [
        { id: null, fullname: "A", phone: ["0500000001"] },
        { id: null, fullname: "B", phone: ["0500000002"] },
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
        resolved: { nationalId: null, fullname: "A" },
        phonesToKeep: ["0500000001", "0500000002"],
        reason: "   ",
        confirmDifferentIds: false,
      },
      userId,
      repo
    );
    expect(result.ok).toBe(false);
  });
});
