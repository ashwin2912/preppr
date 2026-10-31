CREATE TABLE "wa_contacts" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "menu_opt_in" boolean;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "menu_opt_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "menu_opt_in_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source" text;