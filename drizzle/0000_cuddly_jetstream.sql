CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"national_id" text,
	"fullname" text,
	"source_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_national_id_unique" UNIQUE("national_id")
);
--> statement-breakpoint
CREATE TABLE "phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"number" text NOT NULL,
	"raw" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phones" ADD CONSTRAINT "phones_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phones_number_idx" ON "phones" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "phones_person_number_uq" ON "phones" USING btree ("person_id","number");