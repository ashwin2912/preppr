import { connectPostgres } from "../src/db/client";

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL");
  process.exit(1);
}
await connectPostgres(process.env.DATABASE_URL, true);
console.log("Migrations applied");
process.exit(0);
