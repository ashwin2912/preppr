CREATE TABLE "raw_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"provider" text NOT NULL,
	"shape" text NOT NULL,
	"body_json" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_webhooks_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "raw_webhooks_status_next" ON "raw_webhooks" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "raw_webhooks_received" ON "raw_webhooks" USING btree ("received_at");