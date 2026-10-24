CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_phone" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"message_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_phone_customers_phone_fk" FOREIGN KEY ("customer_phone") REFERENCES "public"."customers"("phone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_customer" ON "payments" USING btree ("customer_phone");--> statement-breakpoint
CREATE INDEX "payments_status" ON "payments" USING btree ("status");