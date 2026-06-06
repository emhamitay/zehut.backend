import { repo as defaultRepo, type Repo } from "./repo";

export async function getPersonHistory(personId: string, repo: Repo = defaultRepo) {
  return repo.listAudit(personId);
}
