export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("972")) return "0" + digits.slice(3);
  return digits;
}

export function isValidPhone(normalized: string): boolean {
  return normalized.length >= 7 && normalized.length <= 15;
}
