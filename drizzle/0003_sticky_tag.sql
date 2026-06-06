CREATE TABLE "contact_page_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_page_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"season" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_page_entries" ADD CONSTRAINT "contact_page_entries_contact_page_id_contact_pages_id_fk" FOREIGN KEY ("contact_page_id") REFERENCES "public"."contact_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_page_entries" ADD CONSTRAINT "contact_page_entries_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_pages" ADD CONSTRAINT "contact_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_page_entries_page_idx" ON "contact_page_entries" USING btree ("contact_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_page_entries_season_person_uq" ON "contact_page_entries" USING btree ("season","person_id");--> statement-breakpoint
CREATE INDEX "contact_pages_user_created_at_idx" ON "contact_pages" USING btree ("created_by_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_pages_season_number_uq" ON "contact_pages" USING btree ("season","page_number");