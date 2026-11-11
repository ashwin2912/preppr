/** Shared HTML bits for the admin pages (chat viewer, kitchen page). */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--in:#fff;--out:#dcf3e0;--accent:#1f7a4d;--warn:#b4441f;--chip:#efede7}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29c;--line:#33322f;--in:#262624;--out:#1f3a2a;--accent:#5cc98d;--warn:#f08a65;--chip:#2c2b28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:1}
header h1{font-size:17px;margin:0;flex:1}a{color:var(--accent);text-decoration:none}
main{max-width:760px;margin:0 auto;padding:12px 16px 48px}
.tabs a{padding:4px 10px;border-radius:99px;background:var(--chip);color:var(--ink);font-size:13px}.tabs a.on{background:var(--accent);color:#fff}
form.search{display:flex;gap:6px;margin:10px 0}form.search input{flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font-size:15px}
.row{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;color:var(--ink)}
.row .top{display:flex;justify-content:space-between;gap:8px}.row .name{font-weight:600}.muted{color:var(--muted);font-size:13px}
.snip{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--chip);margin:4px 4px 0 0}
.chip.warn{background:var(--warn);color:#fff}.chip.ok{background:var(--accent);color:#fff}
.side{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.side h3{margin:0 0 6px;font-size:14px}.side p{margin:2px 0}
.day{text-align:center;color:var(--muted);font-size:12px;margin:16px 0 6px}
.b{max-width:85%;padding:7px 10px;border-radius:10px;margin:4px 0;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--line)}
.b.in{background:var(--in);margin-right:auto}.b.out{background:var(--out);margin-left:auto}
.meta{font-size:11px;color:var(--muted);margin-top:3px;display:flex;gap:6px;justify-content:flex-end}
.btns{margin-top:4px}.btns span{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:1px 6px;font-size:12px;margin:2px 4px 0 0}
.empty{color:var(--muted);text-align:center;padding:40px 0}`;

export function page(title: string, header: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header>${header}</header><main>${body}</main></body></html>`;
}
