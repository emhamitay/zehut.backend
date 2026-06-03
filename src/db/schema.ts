import {
  index,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    personIdx: index("alerts_person_idx").on(t.personId),
    unresolvedIdx: index("alerts_unresolved_idx").on(t.resolvedAt),
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

export type PersonRow = typeof persons.$inferSelect;
export type PhoneRow = typeof phones.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type UserRow = typeof users.$inferSelect;
