ALTER TABLE "persons" DROP CONSTRAINT "persons_national_id_unique";--> statement-breakpoint
CREATE INDEX "persons_national_id_idx" ON "persons" USING btree ("national_id");