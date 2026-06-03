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
