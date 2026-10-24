import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { log } from "../lib/log";

export type Cell = string | number | null;

export interface SheetSink {
  /** Replace a tab's contents (creating the tab if needed). */
  writeTab(title: string, rows: Cell[][], opts?: { first?: boolean }): Promise<void>;
}

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/**
 * Google Sheets over plain REST with a service account (no SDK). Values are
 * written RAW, so a customer typing "=IMPORTXML(...)" as their name stays text.
 */
export class GoogleSheetSink implements SheetSink {
  private sa: ServiceAccount;
  private token: { value: string; exp: number } | null = null;
  private titles: Set<string> | null = null;

  /** `serviceAccount` is the key JSON itself, or a path to the downloaded key file. */
  constructor(
    serviceAccount: string,
    private sheetId: string,
  ) {
    const json = serviceAccount.trim().startsWith("{") ? serviceAccount : readFileSync(serviceAccount, "utf8");
    this.sa = JSON.parse(json) as ServiceAccount;
    if (!this.sa.client_email || !this.sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key");
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: this.sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.sa.private_key);
    const res = await fetch(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${head}.${claims}.${b64url(sig)}`,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !json.access_token) throw new Error(`Google token ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    this.token = { value: json.access_token, exp: now + (json.expires_in ?? 3600) };
    return json.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API}/${this.sheetId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }

  private async ensureTab(title: string, first: boolean) {
    if (!this.titles) {
      const meta = await this.call("GET", "?fields=sheets.properties.title");
      this.titles = new Set((meta.sheets ?? []).map((s: any) => s.properties.title as string));
    }
    if (this.titles.has(title)) return;
    await this.call("POST", ":batchUpdate", {
      requests: [{ addSheet: { properties: { title, ...(first ? { index: 0 } : {}) } } }],
    });
    this.titles.add(title);
    log.info("sheet tab created", { title });
  }

  async writeTab(title: string, rows: Cell[][], opts: { first?: boolean } = {}) {
    try {
      await this.ensureTab(title, !!opts.first);
    } catch (e) {
      this.titles = null; // someone may have renamed/deleted tabs; re-read next time
      throw e;
    }
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    await this.call("POST", `/values/${range}:clear`, {});
    await this.call("PUT", `/values/${range}!A1?valueInputOption=RAW`, {
      values: rows.map((r) => r.map((c) => c ?? "")),
    });
  }
}

/** In-memory sink for tests. */
export class FakeSheetSink implements SheetSink {
  tabs = new Map<string, Cell[][]>();
  writes: string[] = [];
  failNext = 0;

  async writeTab(title: string, rows: Cell[][]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Sheets API 503");
    }
    this.writes.push(title);
    this.tabs.set(title, rows);
  }
}
