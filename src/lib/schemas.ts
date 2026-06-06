import { t } from "elysia";

export const ContactSchema = t.Object({
  id: t.Union([t.String(), t.Null()]),
  fullname: t.Union([t.String(), t.Null()]),
  phone: t.Array(t.String()),
});

export const PersonWithPhonesSchema = t.Object({
  id: t.String(),
  nationalId: t.Union([t.String(), t.Null()]),
  fullname: t.Union([t.String(), t.Null()]),
  sourceFile: t.Union([t.String(), t.Null()]),
  createdAt: t.Union([t.String(), t.Date()]),
  updatedAt: t.Union([t.String(), t.Date()]),
  phones: t.Array(t.String()),
});

const MismatchedFieldSchema = t.Union([
  t.Literal("id"),
  t.Literal("name"),
  t.Literal("phone"),
]);

export const AlertSchema = t.Object({
  id: t.String(),
  kind: t.Union([
    t.Literal("name_mismatch_on_id"),
    t.Literal("name_phone_mismatch_on_id"),
    t.Literal("id_mismatch_name_phone_match"),
    t.Literal("id_name_mismatch_on_phone"),
    t.Literal("cross_person_mismatch"),
    t.Literal("name_match_no_id"),
    t.Literal("phone_match_name_differs_no_id"),
  ]),
  personId: t.String(),
  relatedPersonId: t.Union([t.String(), t.Null()]),
  details: t.Object({
    matchedOn: t.Union([
      t.Literal("id"),
      t.Literal("name"),
      t.Literal("phone"),
    ]),
    mismatchedFields: t.Array(MismatchedFieldSchema),
    incoming: ContactSchema,
  }),
  sourceFile: t.Union([t.String(), t.Null()]),
  resolvedAt: t.Union([t.String(), t.Date(), t.Null()]),
  resolvedByUserId: t.Union([t.String(), t.Null()]),
  createdAt: t.Union([t.String(), t.Date()]),
});

export const CommitResultSchema = t.Object({
  inserted: t.Array(PersonWithPhonesSchema),
  ignored: t.Number(),
  phoneAdded: t.Array(
    t.Object({
      person: PersonWithPhonesSchema,
      addedPhones: t.Array(t.String()),
    })
  ),
  alerts: t.Array(AlertSchema),
});

export const ExtractInputSchema = t.Union([
  t.Object({
    type: t.Literal("excel"),
    rows: t.Array(t.Record(t.String(), t.Unknown())),
  }),
  t.Object({
    type: t.Literal("docx"),
    text: t.String(),
  }),
]);

export const CommitInputSchema = t.Object({
  contacts: t.Array(ContactSchema),
  sourceFile: t.Optional(t.Union([t.String(), t.Null()])),
});

export const CredentialsSchema = t.Object({
  username: t.String(),
  password: t.String(),
});

export const PersonAuditFieldSchema = t.Union([
  t.Literal("nationalId"),
  t.Literal("fullname"),
  t.Literal("phone_added"),
  t.Literal("phone_removed"),
  t.Literal("merged_from"),
]);

export const UpdatePersonInputSchema = t.Object({
  nationalId: t.Optional(t.Union([t.String(), t.Null()])),
  fullname: t.Optional(t.Union([t.String(), t.Null()])),
  phones: t.Optional(
    t.Object({
      add: t.Optional(t.Array(t.String())),
      remove: t.Optional(t.Array(t.String())),
    })
  ),
  reason: t.Optional(t.Union([t.String(), t.Null()])),
});

const ConflictDetailSchema = t.Object({
  kind: t.String(),
  otherPerson: t.Object({
    id: t.String(),
    nationalId: t.Union([t.String(), t.Null()]),
    fullname: t.Union([t.String(), t.Null()]),
    phones: t.Array(t.String()),
  }),
  mismatchedFields: t.Array(
    t.Union([t.Literal("id"), t.Literal("name"), t.Literal("phone")])
  ),
});

export const PersonAuditRowSchema = t.Object({
  id: t.String(),
  personId: t.String(),
  userId: t.String(),
  field: PersonAuditFieldSchema,
  oldValue: t.Union([t.String(), t.Null()]),
  newValue: t.Union([t.String(), t.Null()]),
  reason: t.Union([t.String(), t.Null()]),
  createdAt: t.Union([t.String(), t.Date()]),
});

export const UpdatePersonOkSchema = t.Object({
  ok: t.Literal(true),
  person: PersonWithPhonesSchema,
  audit: t.Array(PersonAuditRowSchema),
  resolvedAlerts: t.Array(AlertSchema),
});

export const UpdatePersonConflictSchema = t.Object({
  ok: t.Literal(false),
  conflicts: t.Array(ConflictDetailSchema),
});

export const MergePersonsInputSchema = t.Object({
  survivorId: t.String(),
  victimId: t.String(),
  resolved: t.Object({
    nationalId: t.Union([t.String(), t.Null()]),
    fullname: t.Union([t.String(), t.Null()]),
  }),
  phonesToKeep: t.Array(t.String()),
  reason: t.String(),
  confirmDifferentIds: t.Boolean(),
});

export const MergePersonsOkSchema = t.Object({
  ok: t.Literal(true),
  person: PersonWithPhonesSchema,
  audit: t.Array(PersonAuditRowSchema),
});

export const SearchHitSchema = t.Object({
  person: PersonWithPhonesSchema,
  openAlertCount: t.Number(),
});

export const SearchResultSchema = t.Object({
  resolvedBy: t.Union([
    t.Literal("id"),
    t.Literal("phone"),
    t.Literal("name"),
  ]),
  hits: t.Array(SearchHitSchema),
});

export const PersonHistoryEntrySchema = t.Object({
  id: t.String(),
  field: PersonAuditFieldSchema,
  oldValue: t.Union([t.String(), t.Null()]),
  newValue: t.Union([t.String(), t.Null()]),
  reason: t.Union([t.String(), t.Null()]),
  createdAt: t.Union([t.String(), t.Date()]),
  user: t.Union([
    t.Object({ id: t.String(), username: t.String() }),
    t.Null(),
  ]),
});

export const PersonDetailSchema = t.Object({
  person: PersonWithPhonesSchema,
  openAlerts: t.Array(AlertSchema),
});
