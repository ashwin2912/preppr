import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { outbox, waStatuses } from "../db/schema";
import type { Ctx } from "../ctx";
import { log } from "../lib/log";
import { normalizePhone } from "../lib/phone";

const StatusSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: z.string().optional(),
  recipient_id: z.string(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().optional(),
        title: z.string().optional(),
        message: z.string().optional(),
        error_data: z.looseObject({ details: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

/** sent < delivered < read; failed always wins. Statuses can arrive out of order. */
const rank = (col: unknown) =>
  sql`(case ${col} when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end)`;

/**
 * Store Meta's delivery statuses for our outbound messages. A failure after
 * Meta accepted the message (customer blocked us, number not on WhatsApp,
 * phone unreachable) is logged as an ERROR so it reaches Sentry.
 */
export async function recordStatuses(ctx: Pick<Ctx, "db" | "cfg" | "now">, raw: unknown[]) {
  for (const r of raw) {
    const p = StatusSchema.safeParse(r);
    if (!p.success) {
      log.warn("unrecognized status", { raw: r });
      continue;
    }
    const s = p.data;
    const err = s.errors?.[0];
    const values = {
      waMessageId: s.id,
      recipient: normalizePhone(s.recipient_id) ?? s.recipient_id,
      status: s.status,
      errorCode: err?.code ?? null,
      errorText: err ? [err.title, err.message, err.error_data?.details].filter(Boolean).join(" — ").slice(0, 500) : null,
      statusAt: s.timestamp ? new Date(Number(s.timestamp) * 1000) : ctx.now(),
      updatedAt: ctx.now(),
    };
    const changed = await ctx.db
      .insert(waStatuses)
      .values(values)
      .onConflictDoUpdate({
        target: waStatuses.waMessageId,
        set: {
          status: values.status,
          errorCode: values.errorCode,
          errorText: values.errorText,
          statusAt: values.statusAt,
          updatedAt: values.updatedAt,
        },
        setWhere: sql`${rank(sql.raw("excluded.status"))} > ${rank(waStatuses.status)}`,
      })
      .returning({ status: waStatuses.status });
    if (changed[0]?.status !== "failed" || s.status !== "failed") continue;

    const [o] = await ctx.db.select({ key: outbox.idemKey }).from(outbox).where(eq(outbox.waMessageId, s.id));
    const toOwner = ctx.cfg.ownerNumbers.includes(values.recipient);
    log.error("delivery failed", {
      alert: toOwner ? "owner_delivery_failed" : "delivery_failed",
      to: values.recipient,
      waMessageId: s.id,
      key: o?.key,
      code: values.errorCode,
      error: values.errorText,
    });
  }
}
