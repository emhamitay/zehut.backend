ALTER TABLE "alerts" DROP CONSTRAINT "alerts_related_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "person_audit" DROP CONSTRAINT "person_audit_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "person_audit" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_related_person_id_persons_id_fk" FOREIGN KEY ("related_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_audit" ADD CONSTRAINT "person_audit_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;