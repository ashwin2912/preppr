import type { MenuItem, Product, ProductSize } from "../db/schema";
import type { ParsedProducts } from "../llm/types";

/** A product as parsed from the owner's text, before it is saved. */
export type ProductDraft = { name: string; sizes: ProductSize[]; aliases: string[] };

/** Lowercased, single-spaced, punctuation-free name: the unique key of a product. */
export const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const titleCase = (s: string) => s.replace(/\S+/g, (w) => w[0]!.toUpperCase() + w.slice(1));

/** Whole dollars without decimals ("$6"), otherwise two decimals ("$6.50"). */
export const shortMoney = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

const UNIT = "(?:oz|ml|ltr|lb|lbs|g|gm|kg|pc|pcs|piece|pieces)";
const SIZE_RE = new RegExp(`^(?:xs|s|m|l|xl|small|medium|large|regular|half|full|mini|family|\\d+(?:\\.\\d+)?(?:${UNIT}|l))$`, "i");
const NUM_RE = /^\d+(?:\.\d+)?$/;
/** Units written apart from the number ("8 oz"); a bare "L" is a size, never a unit here. */
const UNIT_RE = new RegExp(`^${UNIT}$`, "i");
const PRICE_RE = /^\$?(\d{1,3}(?:\.\d{1,2})?)$/;
/** Words after a single price that name the unit: "Roti 1 each", "Samosa 2 per piece". */
const EACH_RE = /^(?:each|ea|per\s+(?:piece|pc|plate|box|dozen|cup|bowl|serving|portion|tray))$/i;

const cents = (s: string) => Math.round(Number(s) * 100);

function sizeLabel(s: string) {
  if (/^(xs|s|m|l|xl)$/i.test(s)) return s.toUpperCase();
  if (/^\d/.test(s)) return s.toLowerCase();
  return titleCase(s.toLowerCase());
}

/**
 * Strict code parser for one product line: `<name> <price> [each|per X]` or
 * `<name> <size> <price>[, <size> <price>]...`. Any doubt returns null so the model decides.
 */
export function parseProductLine(line: string): ProductDraft | null {
  const clean = line
    .trim()
    .replace(/^(?:[-•*]|\d+[.)])\s+/, "")
    .replace(/\s[-–—]\s/g, " ")
    .replace(/[,;|=@:–—]/g, " ")
    .trim();
  if (!clean) return null;
  const raw = clean.split(/\s+/);
  // "8 oz" -> "8oz"; "16oz-$10" -> "16oz", "$10"
  const toks: string[] = [];
  for (const t of raw.flatMap((t) => t.split(/-(?=\$)/))) {
    if (UNIT_RE.test(t) && toks.length && NUM_RE.test(toks.at(-1)!)) toks.push(`${toks.pop()}${t}`);
    else if (t) toks.push(t);
  }
  const first = toks.findIndex((t) => SIZE_RE.test(t) || PRICE_RE.test(t));
  if (first < 1) return null;
  const nameToks = toks.slice(0, first);
  if (nameToks.some((t) => /\d/.test(t))) return null;
  const name = titleCase(nameToks.join(" "));
  const rest = toks.slice(first);

  // Single price, optional unit words.
  const single = rest[0]!.match(PRICE_RE);
  if (single) {
    const unit = rest.slice(1).join(" ");
    if (unit && !EACH_RE.test(unit)) return null;
    const label = unit ? unit.toLowerCase().replace(/^ea$/, "each") : "each";
    return valid({ name, sizes: [{ label, price_cents: cents(single[1]!) }], aliases: [] });
  }

  if (rest.length % 2 !== 0) return null;
  const sizes: ProductSize[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const price = rest[i + 1]!.match(PRICE_RE);
    if (!SIZE_RE.test(rest[i]!) || !price) return null;
    sizes.push({ label: sizeLabel(rest[i]!), price_cents: cents(price[1]!) });
  }
  return valid({ name, sizes, aliases: [] });
}

function valid(p: ProductDraft): ProductDraft | null {
  if (!nameKey(p.name)) return null;
  const labels = new Set(p.sizes.map((s) => s.label.toLowerCase()));
  if (labels.size !== p.sizes.length) return null;
  if (p.sizes.some((s) => !Number.isInteger(s.price_cents) || s.price_cents <= 0 || s.price_cents >= 100_000)) return null;
  return p;
}

/** Every line parsed by the code parser, or null if any line needs the model. */
export function parseProductsText(text: string): ProductDraft[] | null {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const out: ProductDraft[] = [];
  for (const l of lines) {
    const p = parseProductLine(l);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** Prices the owner actually wrote, in cents ("6", "$6", "6.50"). */
export function pricesInText(text: string): Set<number> {
  return new Set([...text.matchAll(/\d+(?:\.\d{1,2})?/g)].map((m) => cents(m[0])));
}

/**
 * Model output -> drafts. Drops sizes whose price the owner didn't write and
 * products left without sizes; their names come back in `rejected`. With
 * `known` (edits), a size may also keep the price it already has on that product.
 */
export function cleanParsedProducts(parsed: ParsedProducts, text: string, known: Pick<Product, "nameKey" | "sizes">[] = []): { products: ProductDraft[]; rejected: string[] } {
  const written = pricesInText(text);
  const current = (name: string, label: string) =>
    known.find((k) => k.nameKey === nameKey(name))?.sizes.find((s) => s.label.toLowerCase() === label.toLowerCase())?.price_cents;
  const products: ProductDraft[] = [];
  const rejected: string[] = [];
  for (const p of parsed.products) {
    const name = titleCase(p.name.trim());
    if (!nameKey(name)) continue;
    const seen = new Set<string>();
    const sizes: ProductSize[] = [];
    let dropped = false;
    for (const s of p.sizes) {
      const label = s.label.trim() || "each";
      const ok = written.has(s.price_cents) || current(name, label) === s.price_cents;
      if (!ok || !Number.isInteger(s.price_cents) || s.price_cents <= 0 || s.price_cents >= 100_000) {
        dropped = true;
        continue;
      }
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      sizes.push({ label, price_cents: s.price_cents });
    }
    if (!sizes.length || dropped) {
      rejected.push(name);
      continue;
    }
    const aliases = [...new Set(p.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
    products.push({ name, sizes, aliases });
  }
  return { products, rejected };
}

/** A size label that is just the unit ("each", "per piece"): the dish has no real sizes. */
export const isUnitLabel = (label: string) => /^(each|per\s.+)$/i.test(label);

/** "8oz $6 · 16oz $10" or "$1 each". */
export function formatSizes(sizes: ProductSize[]): string {
  if (sizes.length === 1 && isUnitLabel(sizes[0]!.label)) return `${shortMoney(sizes[0]!.price_cents)} ${sizes[0]!.label}`;
  return sizes.map((s) => `${s.label} ${shortMoney(s.price_cents)}`).join(" · ");
}

/** Numbered list as shown by PRODUCTS; numbers are positions in `list`. */
export function formatProductList(list: Pick<Product, "name" | "sizes">[]): string {
  return list.map((p, i) => `${i + 1}. ${p.name} — ${formatSizes(p.sizes)}`).join("\n");
}

export type MenuPick = { product: Product; sizes: ProductSize[] };

/**
 * Resolve the dish part of a MENU message against the product list:
 * "1 3 5", "dal, paneer, roti", "dal (16oz), roti". Exact name or alias first,
 * then a unique prefix or whole word. Unknown or ambiguous words come back in `unknown`.
 */
export function resolvePicks(text: string, list: Product[]): { picks: MenuPick[]; unknown: string[] } {
  const picks: MenuPick[] = [];
  const unknown: string[] = [];
  const add = (product: Product, sizes: ProductSize[]) => {
    const existing = picks.find((p) => p.product.id === product.id);
    if (existing) {
      for (const s of sizes) if (!existing.sizes.includes(s)) existing.sizes.push(s);
    } else picks.push({ product, sizes: [...sizes] });
  };
  // Commas inside "(s, l)" separate sizes, not dishes.
  const flat = text.replace(/\(([^)]*)\)/g, (_, g: string) => `(${g.replace(/[,;]/g, " ")})`);
  for (const seg of flat.split(/[,\n;]+|\s+and\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (/^[\d\s.]+$/.test(seg)) {
      for (const n of seg.split(/[\s.]+/).filter(Boolean)) {
        const p = list[Number(n) - 1];
        if (p) add(p, p.sizes);
        else unknown.push(`#${n}`);
      }
      continue;
    }
    const m = seg.match(/^(.+?)\s*\((.+)\)\s*$/);
    const word = nameKey(m ? m[1]! : seg);
    const p = matchProduct(word, list);
    if (!p) {
      unknown.push(m ? m[1]!.trim() : seg);
      continue;
    }
    if (!m) {
      add(p, p.sizes);
      continue;
    }
    const wanted = m[2]!.split(/[,/\s]+/).map((s) => s.toLowerCase().replace(/\s+/g, "")).filter(Boolean);
    const sizes = p.sizes.filter((s) => wanted.includes(s.label.toLowerCase().replace(/\s+/g, "")));
    if (sizes.length !== wanted.length) unknown.push(seg);
    else add(p, sizes);
  }
  return { picks, unknown };
}

function matchProduct(word: string, list: Product[]): Product | null {
  if (!word) return null;
  const exact = list.filter((p) => p.nameKey === word || p.aliases.includes(word));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const partial = list.filter((p) => p.nameKey.startsWith(word) || ` ${p.nameKey} `.includes(` ${word} `));
  return partial.length === 1 ? partial[0]! : null;
}

/** Menu items, one per product and size, in pick order (ids i1, i2, ...). */
export function menuItemsFromPicks(picks: MenuPick[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const { product, sizes } of picks) {
    const plain = sizes.length === 1 && product.sizes.length === 1 && isUnitLabel(sizes[0]!.label);
    for (const s of sizes) {
      const name = plain ? product.name : `${product.name} ${s.label}`;
      const aliases = [...new Set([nameKey(name), ...(plain ? [product.nameKey, ...product.aliases] : product.aliases.map((a) => `${a} ${s.label.toLowerCase()}`))])];
      items.push({ id: `i${items.length + 1}`, name, price_cents: s.price_cents, aliases, product_id: product.id, size: s.label });
    }
  }
  return items;
}

/** Dish + size labels on a menu, back as picks against today's product list; lines of removed dishes or sizes come back in `missing`. */
export function picksFromMenu(items: MenuItem[], list: Product[]): { picks: MenuPick[]; missing: string[] } {
  const picks: MenuPick[] = [];
  const missing: string[] = [];
  for (const i of items) {
    const product = i.product_id === undefined ? undefined : list.find((p) => p.id === i.product_id);
    const size = product?.sizes.find((s) => s.label === i.size);
    if (!product || !size) {
      missing.push(i.name);
      continue;
    }
    const existing = picks.find((p) => p.product.id === product.id);
    if (existing) existing.sizes.push(size);
    else picks.push({ product, sizes: [size] });
  }
  return { picks, missing };
}

/** Add picks (new dishes, or more sizes of a dish already on). */
export function addPicks(picks: MenuPick[], add: MenuPick[]): MenuPick[] {
  const out = picks.map((p) => ({ product: p.product, sizes: [...p.sizes] }));
  for (const a of add) {
    const existing = out.find((p) => p.product.id === a.product.id);
    if (!existing) out.push({ product: a.product, sizes: [...a.sizes] });
    else for (const s of a.sizes) if (!existing.sizes.some((x) => x.label === s.label)) existing.sizes.push(s);
  }
  // Keep each dish's sizes in product order.
  for (const p of out) p.sizes.sort((x, y) => p.product.sizes.indexOf(x) - p.product.sizes.indexOf(y));
  return out;
}

/** Remove picks: a whole dish when every size is named, otherwise just those sizes. */
export function removePicks(picks: MenuPick[], remove: MenuPick[]): MenuPick[] {
  return picks
    .map((p) => {
      const r = remove.find((x) => x.product.id === p.product.id);
      if (!r) return p;
      return { product: p.product, sizes: p.sizes.filter((s) => !r.sizes.some((x) => x.label === s.label)) };
    })
    .filter((p) => p.sizes.length > 0);
}

/** "Dal Makhani (8oz, 16oz), Roti": dishes and sizes on a menu, for the owner and the model. */
export function describePicks(picks: MenuPick[]): string {
  return picks
    .map((p) => (p.sizes.length === 1 && isUnitLabel(p.sizes[0]!.label) ? p.product.name : `${p.product.name} (${p.sizes.map((s) => s.label).join(", ")})`))
    .join(", ");
}
