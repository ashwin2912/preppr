CREATE TABLE "customer_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"customer_phone" text NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "customer_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "flag_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "customer_devices" ADD CONSTRAINT "customer_devices_customer_phone_customers_phone_fk" FOREIGN KEY ("customer_phone") REFERENCES "public"."customers"("phone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_devices_phone" ON "customer_devices" USING btree ("customer_phone");