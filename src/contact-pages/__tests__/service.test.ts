import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestDb, type TestDb } from "../../../test/setup";
import { makeRepo } from "../repo";
import { makeService, type Config } from "../service";
import {
  alerts,
  contactPageEntries,
  contactPages,
  persons,
  phones,
  users,
} from "../../db/schema";
import { eq, sql } from "drizzle-orm";

let tdb: TestDb;

beforeEach(async () => {
  tdb = await makeTestDb();
});

afterEach(async () => {
  await tdb.close();
});

const SEASON = "test-season";

function config(over: Partial<Config> = {}): Config {
  return {
    season: SEASON,
    rowsPerPage: 5,
    pairWarningRows: 3,
    ...over,
  };
}

async function seedUser(username: string): Promise<string> {
  const [row] = await tdb.db
    .insert(users)
    .values({ username, passwordHash: "x" })
    .returning();
  return row.id;
}

type SeedPerson = {
  nationalId?: string | null;
  fullname?: string | null;
  phones?: string[];
  createdAt?: Date;
};

async function seedPerson(p: SeedPerson = {}): Promise<string> {
  const [row] = await tdb.db
    .insert(persons)
    .values({
      nationalId: p.nationalId ?? null,
      fullname: p.fullname ?? null,
      ...(p.createdAt ? { createdAt: p.createdAt, updatedAt: p.createdAt } : {}),
    })
    .returning();
  if (p.phones && p.phones.length > 0) {
    await tdb.db
      .insert(phones)
      .values(p.phones.map((ph) => ({ personId: row.id, number: ph, raw: ph })));
  }
  return row.id;
}

async function seedAlert(personId: string, relatedPersonId: string) {
  await tdb.db.insert(alerts).values({
    kind: "id_mismatch_name_phone_match",
    personId,
    relatedPersonId,
    details: {
      matchedOn: "phone",
      mismatchedFields: ["id"],
      incoming: { id: null, fullname: null, phone: [] },
    },
  });
}

describe("contact-pages service", () => {
  test("simple page: N persons, no alerts -> N entries, no pairs, no warnings", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const userId = await seedUser("alice");

    const base = new Date(2025, 0, 1);
    for (let i = 0; i < 8; i++) {
      await seedPerson({
        nationalId: `id-${i}`,
        fullname: `Person ${i}`,
        phones: [`050000000${i}`],
        createdAt: new Date(base.getTime() + i * 1000),
      });
    }

    const page = await service.generatePageForUser(userId, config({ rowsPerPage: 5 }));
    expect(page.entries).toHaveLength(5);
    expect(new Set(page.entries.map((e) => e.personId)).size).toBe(5);
    for (const e of page.entries) {
      expect(e.pairGroupId).toBeNull();
      expect(e.crossPageWarnings).toEqual([]);
    }
  });

  test("two consecutive pages give disjoint citizens", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u1 = await seedUser("u1");
    const u2 = await seedUser("u2");
    const base = new Date(2025, 0, 1);
    for (let i = 0; i < 10; i++) {
      await seedPerson({
        nationalId: `id-${i}`,
        fullname: `P${i}`,
        createdAt: new Date(base.getTime() + i * 1000),
      });
    }

    const cfg = config({ rowsPerPage: 4 });
    const p1 = await service.generatePageForUser(u1, cfg);
    const p2 = await service.generatePageForUser(u2, cfg);
    const ids1 = new Set(p1.entries.map((e) => e.personId));
    const ids2 = new Set(p2.entries.map((e) => e.personId));
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
    expect(p1.pageNumber).toBe(1);
    expect(p2.pageNumber).toBe(2);
  });

  test("pair on same page: linked unassigned persons land together with shared pairGroupId", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const userId = await seedUser("u");
    const base = new Date(2025, 0, 1);
    const a = await seedPerson({
      nationalId: "A",
      fullname: "A",
      createdAt: new Date(base.getTime() + 1000),
    });
    const b = await seedPerson({
      nationalId: "B",
      fullname: "B",
      createdAt: new Date(base.getTime() + 2000),
    });
    await seedAlert(a, b);
    for (let i = 0; i < 3; i++) {
      await seedPerson({
        nationalId: `C${i}`,
        fullname: `C${i}`,
        createdAt: new Date(base.getTime() + 5000 + i * 1000),
      });
    }

    const page = await service.generatePageForUser(userId, config({ rowsPerPage: 6, pairWarningRows: 3 }));
    const entryA = page.entries.find((e) => e.personId === a);
    const entryB = page.entries.find((e) => e.personId === b);
    expect(entryA).toBeTruthy();
    expect(entryB).toBeTruthy();
    expect(entryA!.pairGroupId).not.toBeNull();
    expect(entryA!.pairGroupId).toBe(entryB!.pairGroupId);
  });

  test("cross-page warning: linked person already assigned -> new page gets warning, not the linked person", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u1 = await seedUser("u1");
    const u2 = await seedUser("u2");
    const base = new Date(2025, 0, 1);
    const a = await seedPerson({
      nationalId: "A",
      fullname: "A-name",
      createdAt: new Date(base.getTime() + 1000),
    });
    const b = await seedPerson({
      nationalId: "B",
      fullname: "B-name",
      createdAt: new Date(base.getTime() + 999_000),
    });
    await seedAlert(a, b);
    for (let i = 0; i < 3; i++) {
      await seedPerson({
        nationalId: `C${i}`,
        fullname: `C${i}`,
        createdAt: new Date(base.getTime() + 2000 + i * 1000),
      });
    }

    const p1 = await service.generatePageForUser(u1, config({ rowsPerPage: 1 }));
    expect(p1.entries.map((e) => e.personId)).toEqual([a]);

    const p2 = await service.generatePageForUser(u2, config({ rowsPerPage: 5 }));
    const entryB = p2.entries.find((e) => e.personId === b);
    expect(entryB).toBeTruthy();
    expect(entryB!.crossPageWarnings).toHaveLength(1);
    const w = entryB!.crossPageWarnings[0];
    expect(w.otherPersonId).toBe(a);
    expect(w.otherNationalId).toBe("A");
    expect(w.otherFullname).toBe("A-name");
    expect(w.otherPageId).toBe(p1.id);
    expect(w.otherPageNumber).toBe(1);
    expect(w.otherCreatedByUsername).toBe("u1");
  });

  test("unique (season, personId) prevents double-assignment", async () => {
    const repo = makeRepo(tdb.db);
    const u1 = await seedUser("u1");
    const u2 = await seedUser("u2");
    const p = await seedPerson({ nationalId: "X", fullname: "X" });

    await repo.insertPageWithEntries({
      season: SEASON,
      createdByUserId: u1,
      personIds: [p],
    });
    await expect(
      repo.insertPageWithEntries({
        season: SEASON,
        createdByUserId: u2,
        personIds: [p],
      })
    ).rejects.toThrow();
  });

  test("season isolation: switching season makes persons available again, old pages still readable", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u = await seedUser("u");
    const base = new Date(2025, 0, 1);
    for (let i = 0; i < 3; i++) {
      await seedPerson({
        nationalId: `id-${i}`,
        fullname: `P${i}`,
        createdAt: new Date(base.getTime() + i * 1000),
      });
    }

    const seasonA = await service.generatePageForUser(u, config({ season: "A", rowsPerPage: 3 }));
    expect(seasonA.entries).toHaveLength(3);

    const seasonB = await service.generatePageForUser(u, config({ season: "B", rowsPerPage: 3 }));
    expect(seasonB.entries).toHaveLength(3);
    const idsA = new Set(seasonA.entries.map((e) => e.personId));
    const idsB = new Set(seasonB.entries.map((e) => e.personId));
    expect(idsA).toEqual(idsB);

    const reread = await service.getPageForUser(seasonA.id, u);
    expect(reread).not.toBeNull();
    expect(reread!.season).toBe("A");
    expect(reread!.entries).toHaveLength(3);
  });

  test("resolved alert no longer produces pair group or cross-page warning", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u = await seedUser("u");
    const base = new Date(2025, 0, 1);
    const a = await seedPerson({
      nationalId: "A",
      fullname: "A",
      createdAt: new Date(base.getTime() + 1000),
    });
    const b = await seedPerson({
      nationalId: "B",
      fullname: "B",
      createdAt: new Date(base.getTime() + 2000),
    });
    await seedAlert(a, b);
    await tdb.db
      .update(alerts)
      .set({ resolvedAt: new Date() })
      .where(eq(alerts.personId, a));

    const page = await service.generatePageForUser(
      u,
      config({ rowsPerPage: 5, pairWarningRows: 3 })
    );
    const entryA = page.entries.find((e) => e.personId === a)!;
    const entryB = page.entries.find((e) => e.personId === b)!;
    expect(entryA.pairGroupId).toBeNull();
    expect(entryB.pairGroupId).toBeNull();
    expect(entryA.crossPageWarnings).toEqual([]);
    expect(entryB.crossPageWarnings).toEqual([]);
  });

  test("getPageForUser returns null for another user's page", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u1 = await seedUser("u1");
    const u2 = await seedUser("u2");
    await seedPerson({ nationalId: "1", fullname: "P" });
    const page = await service.generatePageForUser(u1, config({ rowsPerPage: 1 }));
    expect(await service.getPageForUser(page.id, u2)).toBeNull();
  });

  test("listPagesForUser returns own pages newest-first", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u = await seedUser("u");
    const other = await seedUser("other");
    const base = new Date(2025, 0, 1);
    for (let i = 0; i < 3; i++) {
      await seedPerson({
        nationalId: `${i}`,
        createdAt: new Date(base.getTime() + i * 1000),
      });
    }
    await service.generatePageForUser(u, config({ rowsPerPage: 1 }));
    await service.generatePageForUser(other, config({ rowsPerPage: 1 }));
    await service.generatePageForUser(u, config({ rowsPerPage: 1 }));

    const list = await service.listPagesForUser(u);
    expect(list).toHaveLength(2);
    expect(list[0].pageNumber).toBeGreaterThan(list[1].pageNumber);
  });

  test("no unassigned persons -> throws", async () => {
    const service = makeService(makeRepo(tdb.db));
    const u = await seedUser("u");
    await expect(
      service.generatePageForUser(u, config({ rowsPerPage: 5 }))
    ).rejects.toThrow(/no unassigned persons/);
  });

  test("entries carry phones in raw form", async () => {
    const repo = makeRepo(tdb.db);
    const service = makeService(repo);
    const u = await seedUser("u");
    await seedPerson({
      nationalId: "X",
      fullname: "X",
      phones: ["0500000000", "0511111111"],
    });
    const page = await service.generatePageForUser(u, config({ rowsPerPage: 1 }));
    expect(page.entries[0].phones.sort()).toEqual(["0500000000", "0511111111"]);
  });
});

describe("readConfig", () => {
  test("returns parsed values when env is valid", async () => {
    const { readConfig } = await import("../service");
    const cfg = readConfig({
      CURRENT_SEASON: "tashpu",
      CONTACT_PAGE_ROWS: "20",
      CONTACT_PAGE_PAIR_ROWS: "4",
    });
    expect(cfg).toEqual({ season: "tashpu", rowsPerPage: 20, pairWarningRows: 4 });
  });

  test("throws when CURRENT_SEASON is missing", async () => {
    const { readConfig } = await import("../service");
    expect(() => readConfig({})).toThrow(/CURRENT_SEASON/);
  });

  test("throws when CONTACT_PAGE_ROWS is not a positive int", async () => {
    const { readConfig } = await import("../service");
    expect(() =>
      readConfig({ CURRENT_SEASON: "s", CONTACT_PAGE_ROWS: "0" })
    ).toThrow(/CONTACT_PAGE_ROWS/);
  });
});
