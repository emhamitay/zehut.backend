import type { UserService } from "../users/service";

export async function bootstrapAdmin(
  users: UserService,
  env: { username: string | undefined; password: string | undefined }
): Promise<boolean> {
  if (!env.username || !env.password) return false;
  const total = await users.count();
  if (total > 0) return false;
  await users.create({ username: env.username, password: env.password });
  return true;
}
