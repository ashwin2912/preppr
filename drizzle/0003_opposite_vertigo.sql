CREATE TABLE "wa_statuses" (
	"wa_message_id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"error_code" integer,
	"error_text" text,
	"status_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_wa_message_id" ON "outbox" USING btree ("wa_message_id");