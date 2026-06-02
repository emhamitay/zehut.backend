export type Contact = {
  id: string | null;
  fullname: string | null;
  phone: string[];
};

export type ContactsEnvelope = { contacts: Contact[] };

export type ExtractInput =
  | { type: "excel"; rows: Record<string, unknown>[] }
  | { type: "docx"; text: string };
