CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid NOT NULL,
	"related_person_id" uuid,
	"details" jsonb NOT NULL,
	"source_file" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_related_person_id_persons_id_fk" FOREIGN KEY ("related_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_person_idx" ON "alerts" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "alerts_unresolved_idx" ON "alerts" USING btree ("resolved_at");