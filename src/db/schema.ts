import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { Contact } from "../lib/types";

export type AlertDetails = {
  matchedOn: "id" | "name" | "phone";
  mismatchedFields: ("id" | "name" | "phone")[];
  incoming: Contact;
};

export const persons = pgTable("persons", {
  id: uuid("id").defaultRandom().primaryKey(),
  nationalId: text("national_id").unique(),
  fullname: text("fullname"),
  sourceFile: text("source_file"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const phones = pgTable(
  "phones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .references(() => persons.id, { onDelete: "cascade" })
      .notNull(),
    number: text("number").notNull(),
    raw: text("raw").notNull(),
  },
  (t) => ({
    numberIdx: index("phones_number_idx").on(t.number),
    uniquePerPerson: uniqueIndex("phones_person_number_uq").on(
      t.personId,
      t.number
    ),
  })
);

export const ALERT_KINDS = [
  "name_mismatch_on_id",
  "name_phone_mismatch_on_id",
  "id_mismatch_name_phone_match",
  "id_name_mismatch_on_phone",
  "cross_person_mismatch",
  "name_match_no_id",
  "phone_match_name_differs_no_id",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").$type<AlertKind>().notNull(),
    personId: uuid("person_id")
      .references(() => persons.id, { onDelete: "cascade" })
      .notNull(),
    relatedPersonId: uuid("related_person_id").references(() => persons.id, {
      onDelete: "cascade",
    }),
    details: jsonb("details").$type<AlertDetails>().notNull(),
    sourceFile: text("source_file"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    personIdx: index("alerts_person_idx").on(t.personId),
    unresolvedIdx: index("alerts_unresolved_idx").on(t.resolvedAt),
  })
);

export const PERSON_AUDIT_FIELDS = [
  "nationalId",
  "fullname",
  "phone_added",
  "phone_removed",
  "merged_from",
] as const;
export type PersonAuditField = (typeof PERSON_AUDIT_FIELDS)[number];

export const personAudit = pgTable(
  "person_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .references(() => persons.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    field: text("field").$type<PersonAuditField>().notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    personCreatedAtIdx: index("person_audit_person_created_at_idx").on(
      t.personId,
      t.createdAt
    ),
  })
);

export const personsRelations = relations(persons, ({ many }) => ({
  phones: many(phones),
  alerts: many(alerts),
}));

export const phonesRelations = relations(phones, ({ one }) => ({
  person: one(persons, {
    fields: [phones.personId],
    references: [persons.id],
  }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  person: one(persons, {
    fields: [alerts.personId],
    references: [persons.id],
  }),
  relatedPerson: one(persons, {
    fields: [alerts.relatedPersonId],
    references: [persons.id],
  }),
}));

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const contactPages = pgTable(
  "contact_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    season: text("season").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    pageNumber: integer("page_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    userCreatedAtIdx: index("contact_pages_user_created_at_idx").on(
      t.createdByUserId,
      t.createdAt
    ),
    seasonNumberIdx: uniqueIndex("contact_pages_season_number_uq").on(
      t.season,
      t.pageNumber
    ),
  })
);

export const contactPageEntries = pgTable(
  "contact_page_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactPageId: uuid("contact_page_id")
      .references(() => contactPages.id, { onDelete: "cascade" })
      .notNull(),
    personId: uuid("person_id")
      .references(() => persons.id, { onDelete: "cascade" })
      .notNull(),
    season: text("season").notNull(),
  },
  (t) => ({
    pageIdx: index("contact_page_entries_page_idx").on(t.contactPageId),
    seasonPersonUq: uniqueIndex("contact_page_entries_season_person_uq").on(
      t.season,
      t.personId
    ),
  })
);

export const contactPagesRelations = relations(contactPages, ({ many, one }) => ({
  entries: many(contactPageEntries),
  createdBy: one(users, {
    fields: [contactPages.createdByUserId],
    references: [users.id],
  }),
}));

export const contactPageEntriesRelations = relations(
  contactPageEntries,
  ({ one }) => ({
    page: one(contactPages, {
      fields: [contactPageEntries.contactPageId],
      references: [contactPages.id],
    }),
    person: one(persons, {
      fields: [contactPageEntries.personId],
      references: [persons.id],
    }),
  })
);

export type PersonRow = typeof persons.$inferSelect;
export type PhoneRow = typeof phones.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ContactPageRow = typeof contactPages.$inferSelect;
export type ContactPageEntryRow = typeof contactPageEntries.$inferSelect;
export type PersonAuditRow = typeof personAudit.$inferSelect;
