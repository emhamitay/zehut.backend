import { repo as defaultRepo, type Repo } from "./repo";
import type { PersonAuditRow } from "../db/schema";

export type DeletePersonInput = {
  personId: string;
  reason: string;
};

export type DeleteResult =
  | { ok: true; audit: PersonAuditRow[] }
  | { ok: false; error: "not_found" | "missing_reason" };

function trimOrNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

export async function deletePersonAction(
  input: DeletePersonInput,
  userId: string,
  repo: Repo = defaultRepo
): Promise<DeleteResult> {
  const reason = trimOrNull(input.reason);
  if (!reason) return { ok: false, error: "missing_reason" };

  const victim = await repo.findById(input.personId);
  if (!victim) return { ok: false, error: "not_found" };

  const openAlerts = await repo.listOpenAlerts(victim.id);
  for (const alert of openAlerts) {
    await repo.resolveAlert(alert.id, userId);
  }

  const audit = await repo.insertAuditRows([
    {
      personId: victim.id,
      userId,
      field: "deleted",
      oldValue: victim.id,
      newValue: JSON.stringify({
        nationalId: victim.nationalId,
        fullname: victim.fullname,
        phones: victim.phones,
      }),
      reason,
    },
  ]);

  await repo.deletePerson(victim.id);

  return { ok: true, audit };
}
