CREATE TABLE "form_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"response_key" text NOT NULL,
	"menu_id" integer,
	"customer_phone" text,
	"name" text,
	"area" text,
	"address" text,
	"note" text,
	"lines_json" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"unmatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_responses_response_key_unique" UNIQUE("response_key")
);
--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_customer_phone_customers_phone_fk" FOREIGN KEY ("customer_phone") REFERENCES "public"."customers"("phone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_responses_menu" ON "form_responses" USING btree ("menu_id");