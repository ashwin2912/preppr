/**
 * Property lists in iPhone backups: binary (bplist00) and XML, plus the
 * NSKeyedArchiver wrapper Manifest.db uses for each file's metadata.
 */

export class Uid {
  constructor(readonly value: number) {}
}
export type PlistValue = null | boolean | number | bigint | string | Date | Buffer | Uid | PlistValue[] | { [k: string]: PlistValue };
export type PlistDict = { [k: string]: PlistValue };

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Binary or XML plist → plain values (data = Buffer, date = Date). */
export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(buf);
  return parseXml(buf.toString("utf8"));
}

function readUInt(buf: Buffer, at: number, size: number): number {
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]!;
  return n;
}

function parseBinary(buf: Buffer): PlistValue {
  if (buf.length < 40) throw new Error("plist too short");
  const t = buf.length - 32;
  const offSize = buf[t + 6]!;
  const refSize = buf[t + 7]!;
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  if (count > buf.length || tableAt + count * offSize > t) throw new Error("plist trailer is invalid");
  const offsets = Array.from({ length: count }, (_, i) => readUInt(buf, tableAt + i * offSize, offSize));
  const depth = new Set<number>();

  function length(at: number, low: number): [number, number] {
    if (low !== 0xf) return [low, at + 1];
    const m = buf[at + 1]!;
    if (m >> 4 !== 1) throw new Error("plist length marker is invalid");
    const size = 1 << (m & 0xf);
    return [readUInt(buf, at + 2, size), at + 2 + size];
  }

  function obj(ref: number): PlistValue {
    if (ref >= count) throw new Error("plist reference out of range");
    if (depth.has(ref)) throw new Error("plist has a cycle");
    depth.add(ref);
    try {
      return read(offsets[ref]!);
    } finally {
      depth.delete(ref);
    }
  }

  function read(at: number): PlistValue {
    const marker = buf[at]!;
    const hi = marker >> 4;
    const low = marker & 0xf;
    switch (hi) {
      case 0x0:
        return marker === 0x08 ? false : marker === 0x09 ? true : null;
      case 0x1: {
        const size = 1 << low;
        if (size === 8) {
          const v = buf.readBigInt64BE(at + 1);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        if (size === 16) return buf.readBigInt64BE(at + 9);
        return readUInt(buf, at + 1, size);
      }
      case 0x2:
        return low === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3:
        return new Date(APPLE_EPOCH_MS + buf.readDoubleBE(at + 1) * 1000);
      case 0x4: {
        const [n, start] = length(at, low);
        return Buffer.from(buf.subarray(start, start + n));
      }
      case 0x5: {
        const [n, start] = length(at, low);
        return buf.toString("latin1", start, start + n);
      }
      case 0x6: {
        const [n, start] = length(at, low);
        const b = Buffer.from(buf.subarray(start, start + n * 2));
        return b.swap16().toString("utf16le");
      }
      case 0x8:
        return new Uid(readUInt(buf, at + 1, low + 1));
      case 0xa: {
        const [n, start] = length(at, low);
        return Array.from({ length: n }, (_, i) => obj(readUInt(buf, start + i * refSize, refSize)));
      }
      case 0xd: {
        const [n, start] = length(at, low);
        const out: PlistDict = {};
        for (let i = 0; i < n; i++) {
          const k = obj(readUInt(buf, start + i * refSize, refSize));
          out[String(k)] = obj(readUInt(buf, start + (n + i) * refSize, refSize));
        }
        return out;
      }
      default:
        throw new Error(`plist object type 0x${hi.toString(16)} not supported`);
    }
  }
  return obj(top);
}

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name] ?? m,
  );

function parseXml(xml: string): PlistValue {
  const tokens = [...xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "").matchAll(/<(\/?)([a-zA-Z]+)\s*(\/?)>|([^<]+)/g)];
  let i = 0;
  const next = () => tokens[i++];
  const text = (tag: string) => {
    let s = "";
    for (let t = next(); t && !(t[1] === "/" && t[2] === tag); t = next()) if (t[4]) s += t[4];
    return decodeXml(s);
  };
  function value(): PlistValue {
    let t = next();
    while (t && t[4] !== undefined) t = next(); // whitespace between tags
    if (!t) throw new Error("plist XML ended early");
    const [, close, tag, selfClose] = t;
    if (close) throw new Error(`plist XML: unexpected </${tag}>`);
    if (tag === "plist") {
      const v = value();
      return v;
    }
    if (selfClose) return tag === "true" ? true : tag === "false" ? false : tag === "dict" ? {} : tag === "array" ? [] : null;
    switch (tag) {
      case "string":
        return text(tag);
      case "integer":
        return Number(text(tag));
      case "real":
        return Number(text(tag));
      case "date":
        return new Date(text(tag).trim());
      case "data":
        return Buffer.from(text(tag).replace(/\s+/g, ""), "base64");
      case "true":
      case "false":
        text(tag);
        return tag === "true";
      case "array": {
        const out: PlistValue[] = [];
        while (!peekClose("array")) out.push(value());
        return out;
      }
      case "dict": {
        const out: PlistDict = {};
        while (!peekClose("dict")) {
          let k = next();
          while (k && k[4] !== undefined) k = next();
          if (!k || k[2] !== "key") throw new Error("plist XML: expected <key>");
          out[text("key")] = value();
        }
        return out;
      }
      default:
        throw new Error(`plist XML: <${tag}> not supported`);
    }
  }
  function peekClose(tag: string): boolean {
    while (tokens[i] && tokens[i]![4] !== undefined) i++;
    const t = tokens[i];
    if (!t) throw new Error("plist XML ended early");
    if (t[1] === "/" && t[2] === tag) {
      i++;
      return true;
    }
    return false;
  }
  return value();
}

/**
 * NSKeyedArchiver plist → its root object with each field resolved one level
 * (NSData wrappers unwrapped to Buffer). Enough for Manifest.db's MBFile.
 */
export function unarchive(buf: Buffer): PlistDict {
  const top = parsePlist(buf) as PlistDict;
  const objects = top.$objects as PlistValue[] | undefined;
  const rootRef = (top.$top as PlistDict | undefined)?.root;
  if (!Array.isArray(objects) || !(rootRef instanceof Uid)) throw new Error("not an NSKeyedArchiver plist");
  const resolve = (v: PlistValue): PlistValue => {
    const o = v instanceof Uid ? objects[v.value] ?? null : v;
    if (o && typeof o === "object" && !Buffer.isBuffer(o) && !(o instanceof Date) && !Array.isArray(o) && !(o instanceof Uid) && "NS.data" in o)
      return o["NS.data"] ?? null;
    return o;
  };
  const root = resolve(rootRef) as PlistDict;
  const out: PlistDict = {};
  for (const [k, v] of Object.entries(root)) out[k] = resolve(v);
  return out;
}
