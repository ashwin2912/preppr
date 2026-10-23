CREATE TABLE "conversation_state" (
	"phone" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text,
	"area" text,
	"address_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"human_takeover_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"items_json" jsonb NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"wa_message_id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"body" text,
	"raw_json" jsonb,
	"intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"menu_id" integer NOT NULL,
	"customer_phone" text NOT NULL,
	"lines_json" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"confidence" real,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_menu_customer" UNIQUE("menu_id","customer_phone")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_phone_customers_phone_fk" FOREIGN KEY ("customer_phone") REFERENCES "public"."customers"("phone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_phone_dir_created" ON "messages" USING btree ("phone","direction","created_at");