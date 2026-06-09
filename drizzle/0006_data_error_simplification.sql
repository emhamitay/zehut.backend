-- Drop alert rows whose kind is being removed from the model (name-only
-- matches no longer flag anything).
DELETE FROM "alerts" WHERE "kind" = 'name_match_no_id';
--> statement-breakpoint
-- Previously-resolved alerts must be removed before the column is dropped,
-- otherwise they would resurface as live alerts.
DELETE FROM "alerts" WHERE "resolved_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_resolved_by_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "alerts_unresolved_idx";--> statement-breakpoint
CREATE INDEX "alerts_related_person_idx" ON "alerts" USING btree ("related_person_id");--> statement-breakpoint
ALTER TABLE "alerts" DROP COLUMN "resolved_at";--> statement-breakpoint
ALTER TABLE "alerts" DROP COLUMN "resolved_by_user_id";