import { repo as defaultRepo, type Repo } from "./repo";
import type {
  AlertRow,
  ContactPageEntryRow,
  ContactPageRow,
} from "../db/schema";

export type Config = {
  season: string;
  rowsPerPage: number;
  pairWarningRows: number;
};

export function readConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const season = env.CURRENT_SEASON?.trim();
  if (!season) throw new Error("CURRENT_SEASON is not set");
  const rowsPerPage = Number(env.CONTACT_PAGE_ROWS ?? "25");
  if (!Number.isInteger(rowsPerPage) || rowsPerPage <= 0) {
    throw new Error("CONTACT_PAGE_ROWS must be a positive integer");
  }
  const pairWarningRows = Number(env.CONTACT_PAGE_PAIR_ROWS ?? "3");
  if (!Number.isInteger(pairWarningRows) || pairWarningRows <= 0) {
    throw new Error("CONTACT_PAGE_PAIR_ROWS must be a positive integer");
  }
  return { season, rowsPerPage, pairWarningRows };
}

export type EntryView = {
  personId: string;
  nationalId: string | null;
  fullname: string | null;
  phones: string[];
  pairGroupId: string | null;
  crossPageWarnings: {
    otherPersonId: string;
    otherNationalId: string | null;
    otherFullname: string | null;
    otherPageId: string;
    otherPageNumber: number;
    otherCreatedByUsername: string;
    alertKind: string;
  }[];
};

export type PageView = {
  id: string;
  season: string;
  pageNumber: number;
  createdByUserId: string;
  createdAt: Date;
  entries: EntryView[];
};

export type Service = ReturnType<typeof makeService>;

export function makeService(repo: Repo = defaultRepo) {
  async function generatePageForUser(
    userId: string,
    config: Config = readConfig()
  ): Promise<PageView> {
    const { season, rowsPerPage, pairWarningRows } = config;

    const candidateIds = await repo.findUnassignedPersonIds(season, rowsPerPage);
    if (candidateIds.length === 0) {
      throw new Error("no unassigned persons available in current season");
    }

    const alertRows = await repo.findOpenAlertsForPersons(candidateIds);
    const candidateSet = new Set(candidateIds);

    const pickedIds: string[] = [];
    const pickedSet = new Set<string>();
    let rowBudget = 0;

    for (const id of candidateIds) {
      if (pickedSet.has(id)) continue;

      const linkedIds = new Set<string>();
      for (const a of alertRows) {
        if (a.personId === id && a.relatedPersonId) linkedIds.add(a.relatedPersonId);
        if (a.relatedPersonId === id) linkedIds.add(a.personId);
      }
      linkedIds.delete(id);

      const pairPartners: string[] = [];
      for (const linked of linkedIds) {
        if (candidateSet.has(linked) && !pickedSet.has(linked)) {
          pairPartners.push(linked);
        }
      }

      const cost = pairPartners.length > 0 ? pairWarningRows : 1;
      if (rowBudget + cost > rowsPerPage) {
        if (pairPartners.length === 0 && rowBudget < rowsPerPage) {
          rowBudget += 1;
          pickedIds.push(id);
          pickedSet.add(id);
          continue;
        }
        continue;
      }

      pickedIds.push(id);
      pickedSet.add(id);
      for (const partner of pairPartners) {
        pickedIds.push(partner);
        pickedSet.add(partner);
      }
      rowBudget += cost;
      if (rowBudget >= rowsPerPage) break;
    }

    const { page } = await repo.insertPageWithEntries({
      season,
      createdByUserId: userId,
      personIds: pickedIds,
    });

    return loadPageViewFromIds(page, pickedIds, season);
  }

  async function loadPageViewFromIds(
    page: ContactPageRow,
    personIds: string[],
    season: string
  ): Promise<PageView> {
    const [personRows, phonesByPerson, allAlerts] = await Promise.all([
      repo.findPersonsByIds(personIds),
      repo.findPhonesForPersons(personIds),
      repo.findOpenAlertsForPersons(personIds),
    ]);

    const linkedIds = new Set<string>();
    for (const a of allAlerts) {
      if (a.relatedPersonId && !personIds.includes(a.relatedPersonId)) {
        linkedIds.add(a.relatedPersonId);
      }
      if (!personIds.includes(a.personId)) {
        linkedIds.add(a.personId);
      }
    }

    const externalIds = [...linkedIds];
    const [externalPersons, externalAssignments] = await Promise.all([
      repo.findPersonsByIds(externalIds),
      repo.findAssignmentsForPersons(season, externalIds),
    ]);
    const externalById = new Map(externalPersons.map((p) => [p.id, p]));
    const assignmentByPerson = new Map(
      externalAssignments.map((a) => [a.personId, a])
    );

    const personIdSet = new Set(personIds);
    const pairGroupByPerson = computePairGroups(allAlerts, personIdSet);

    const personOrder = new Map(personIds.map((id, i) => [id, i]));
    const personById = new Map(personRows.map((p) => [p.id, p]));

    const entries: EntryView[] = personIds
      .map((pid) => personById.get(pid))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .sort(
        (a, b) => (personOrder.get(a.id) ?? 0) - (personOrder.get(b.id) ?? 0)
      )
      .map((p) => {
        const crossPageWarnings: EntryView["crossPageWarnings"] = [];
        for (const a of allAlerts) {
          const other = otherSide(a, p.id);
          if (!other) continue;
          if (personIdSet.has(other)) continue;
          const assignment = assignmentByPerson.get(other);
          if (!assignment) continue;
          const otherPerson = externalById.get(other);
          crossPageWarnings.push({
            otherPersonId: other,
            otherNationalId: otherPerson?.nationalId ?? null,
            otherFullname: otherPerson?.fullname ?? null,
            otherPageId: assignment.contactPageId,
            otherPageNumber: assignment.pageNumber,
            otherCreatedByUsername: assignment.createdByUsername,
            alertKind: a.kind,
          });
        }
        return {
          personId: p.id,
          nationalId: p.nationalId,
          fullname: p.fullname,
          phones: phonesByPerson.get(p.id) ?? [],
          pairGroupId: pairGroupByPerson.get(p.id) ?? null,
          crossPageWarnings,
        };
      });

    return {
      id: page.id,
      season: page.season,
      pageNumber: page.pageNumber,
      createdByUserId: page.createdByUserId,
      createdAt: page.createdAt,
      entries,
    };
  }

  async function getPageForUser(
    pageId: string,
    userId: string
  ): Promise<PageView | null> {
    const page = await repo.getPageForUser(pageId, userId);
    if (!page) return null;
    const entries = await repo.findEntriesByPage(pageId);
    const personIds = entries.map((e) => e.personId);
    return loadPageViewFromIds(page, personIds, page.season);
  }

  async function getPage(pageId: string): Promise<PageView | null> {
    const page = await repo.getPage(pageId);
    if (!page) return null;
    const entries = await repo.findEntriesByPage(pageId);
    const personIds = entries.map((e) => e.personId);
    return loadPageViewFromIds(page, personIds, page.season);
  }

  async function listPagesForUser(
    userId: string
  ): Promise<
    { id: string; season: string; pageNumber: number; createdAt: Date }[]
  > {
    const rows = await repo.listPagesForUser(userId);
    return rows.map((r) => ({
      id: r.id,
      season: r.season,
      pageNumber: r.pageNumber,
      createdAt: r.createdAt,
    }));
  }

  async function findContactPageForPerson(personId: string): Promise<{
    pageId: string;
    pageNumber: number;
    season: string;
    createdByUserId: string;
    createdByUsername: string;
  } | null> {
    return repo.findContactPageForPerson(personId);
  }

  return { generatePageForUser, getPageForUser, getPage, listPagesForUser, findContactPageForPerson };
}

function otherSide(alert: AlertRow, personId: string): string | null {
  if (alert.personId === personId) return alert.relatedPersonId ?? null;
  if (alert.relatedPersonId === personId) return alert.personId;
  return null;
}

function computePairGroups(
  alerts: AlertRow[],
  pagePersonIds: Set<string>
): Map<string, string> {
  const parent = new Map<string, string>();
  function find(x: string): string {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (!parent.has(r)) parent.set(r, r);
    let cur = x;
    while (parent.get(cur) && parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const a of alerts) {
    if (!a.relatedPersonId) continue;
    if (!pagePersonIds.has(a.personId) || !pagePersonIds.has(a.relatedPersonId)) {
      continue;
    }
    union(a.personId, a.relatedPersonId);
  }

  const components = new Map<string, string[]>();
  for (const id of pagePersonIds) {
    if (!parent.has(id)) continue;
    const root = find(id);
    const list = components.get(root) ?? [];
    list.push(id);
    components.set(root, list);
  }

  const out = new Map<string, string>();
  for (const [root, members] of components) {
    if (members.length < 2) continue;
    for (const m of members) out.set(m, root);
  }
  return out;
}

export const service = makeService();
