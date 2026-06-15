CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid NOT NULL,
	"related_person_id" uuid,
	"details" jsonb NOT NULL,
	"source_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "person_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"user_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fullname" text,
	"source_file" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"number" text NOT NULL,
	"raw" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_related_person_id_persons_id_fk" FOREIGN KEY ("related_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_page_entries" ADD CONSTRAINT "contact_page_entries_contact_page_id_contact_pages_id_fk" FOREIGN KEY ("contact_page_id") REFERENCES "public"."contact_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_page_entries" ADD CONSTRAINT "contact_page_entries_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_pages" ADD CONSTRAINT "contact_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_audit" ADD CONSTRAINT "person_audit_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_audit" ADD CONSTRAINT "person_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phones" ADD CONSTRAINT "phones_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_person_idx" ON "alerts" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "alerts_related_person_idx" ON "alerts" USING btree ("related_person_id");--> statement-breakpoint
CREATE INDEX "contact_page_entries_page_idx" ON "contact_page_entries" USING btree ("contact_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_page_entries_season_person_uq" ON "contact_page_entries" USING btree ("season","person_id");--> statement-breakpoint
CREATE INDEX "contact_pages_user_created_at_idx" ON "contact_pages" USING btree ("created_by_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_pages_season_number_uq" ON "contact_pages" USING btree ("season","page_number");--> statement-breakpoint
CREATE INDEX "person_audit_person_created_at_idx" ON "person_audit" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "phones_number_idx" ON "phones" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "phones_person_number_uq" ON "phones" USING btree ("person_id","number");