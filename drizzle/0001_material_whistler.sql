CREATE TABLE "inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"wa_message_id" text NOT NULL,
	"phone" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"idem_key" text NOT NULL,
	"to" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wa_message_id" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_idem_key_unique" UNIQUE("idem_key")
);
--> statement-breakpoint
CREATE INDEX "inbox_status_next" ON "inbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "inbox_phone_created" ON "inbox" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "outbox_status_next" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_to_created" ON "outbox" USING btree ("to","created_at");