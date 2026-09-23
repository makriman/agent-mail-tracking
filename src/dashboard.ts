import { escapeHtml } from "./instrument";
import type { EventRow, MessageRow } from "./types";
import { messageStatus } from "./confidence";

const STATUS_LABEL: Record<string, string> = {
  replied: "Replied",
  clicked: "Clicked",
  high_confidence_open: "High-confidence open",
  proxy_open: "Proxy / suspected open",
  no_signal: "No signal",
};

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --paper: #f3eee4;
      --ink: #1b1916;
      --muted: #6b645b;
      --line: #d9d0c3;
      --teal: #0f3d3e;
      --teal-soft: #d7e4e2;
      --amber: #8a5a12;
      --amber-soft: #f3e3c4;
      --green: #1f4d2a;
      --green-soft: #d7ead8;
      --rose: #6e2d2d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.5 "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;
    }
    header, main { max-width: 960px; margin: 0 auto; padding: 0 1.25rem; }
    header {
      padding-top: 2rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--line);
      margin-bottom: 1.5rem;
    }
    .kicker {
      font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--teal);
    }
    h1 { font-size: 1.75rem; margin: 0.35rem 0 0.25rem; font-weight: 650; }
    .tagline { color: var(--muted); margin: 0; }
    a { color: var(--teal); }
    table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
    th, td { text-align: left; padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    th {
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font: 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      white-space: nowrap;
    }
    .pill.clicked, .pill.replied { background: var(--green-soft); color: var(--green); }
    .pill.high_confidence_open { background: var(--teal-soft); color: var(--teal); }
    .pill.proxy_open { background: var(--amber-soft); color: var(--amber); }
    .pill.no_signal { background: #ece7de; color: var(--muted); }
    .empty { color: var(--muted); padding: 2rem 0; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem 1.25rem; margin: 1rem 0 2rem; }
    .meta dt { font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .meta dd { margin: 0.15rem 0 0; }
    .timeline { list-style: none; padding: 0; margin: 0; }
    .timeline li {
      padding: 0.85rem 0 0.85rem 1rem;
      border-left: 2px solid var(--line);
      margin-left: 0.4rem;
    }
    .timeline .when { color: var(--muted); }
    .deduped { color: var(--muted); font-size: 0.85rem; }
    footer { max-width: 960px; margin: 3rem auto 2rem; padding: 0 1.25rem; color: var(--muted); font-size: 0.85rem; }
  </style>
</head>
<body>
  <header>
    <div class="kicker">Self-hosted · Cloudflare Worker</div>
    <h1>Agent Mail Track</h1>
    <p class="tagline">Track email opens, clicks, and delivery in a form agents can read and act on.</p>
  </header>
  <main>
    ${body}
  </main>
  <footer>Does not send email. Opens store <span class="mono">ip_hash</span>, never raw IP. Reply detection is a future stub.</footer>
</body>
</html>`;
}

function statusPill(status: string): string {
  return `<span class="pill ${escapeHtml(status)}">${escapeHtml(STATUS_LABEL[status] ?? status)}</span>`;
}

function fmt(ts: string | null): string {
  return ts ? escapeHtml(ts.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace("Z", " UTC")) : "—";
}

export function renderList(messages: MessageRow[], humanOpenIds: ReadonlySet<string> = new Set()): string {
  if (messages.length === 0) {
    return layout(
      "Agent Mail Track",
      `<p class="empty">No messages yet. Have an agent <span class="mono">POST /v1/messages</span> with a Bearer API key, then refresh.</p>`,
    );
  }
  const rows = messages
    .map((m) => {
      const status = messageStatus(m, humanOpenIds.has(m.id));
      const opens = m.open_tracking ? String(m.open_count) : "—";
      return `<tr>
        <td class="mono">${fmt(m.created_at)}</td>
        <td>${escapeHtml(m.recipient)}</td>
        <td>${escapeHtml(m.subject ?? "(no subject)")}</td>
        <td class="mono">${escapeHtml(m.mode)}</td>
        <td>${statusPill(status)}</td>
        <td class="mono">${opens}</td>
        <td class="mono">${m.click_count}</td>
        <td><a href="/m/${escapeHtml(m.id)}">Timeline</a></td>
      </tr>`;
    })
    .join("\n");
  return layout(
    "Agent Mail Track",
    `<table>
      <thead>
        <tr>
          <th>Created</th><th>To</th><th>Subject</th><th>Mode</th>
          <th>Status</th><th>Opens</th><th>Clicks</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

export function renderDetail(message: MessageRow, events: EventRow[], humanOpen: boolean): string {
  const status = messageStatus(message, humanOpen);
  const opens = message.open_tracking ? String(message.open_count) : "null (open tracking off)";
  const items =
    events.length === 0
      ? `<p class="empty">No open or click events yet.</p>`
      : `<ol class="timeline">${events
          .map((e) => {
            const dest = e.original_url
              ? ` → <span class="mono">${escapeHtml(e.original_url)}</span>`
              : "";
            const dedupe = e.deduped ? ` <span class="deduped">deduped</span>` : "";
            const ua = e.user_agent ? `<div class="mono">${escapeHtml(e.user_agent)}</div>` : "";
            const geo = e.cf_country ? ` · ${escapeHtml(e.cf_country)}` : "";
            return `<li>
              <div><strong>${escapeHtml(e.type)}</strong> · ${escapeHtml(e.classification)}${geo}${dest}${dedupe}</div>
              <div class="when mono">${fmt(e.created_at)}</div>
              ${ua}
            </li>`;
          })
          .join("\n")}</ol>`;

  return layout(
    `${message.subject ?? "Message"} · Agent Mail Track`,
    `<p><a href="/">← All messages</a></p>
     <h2>${escapeHtml(message.subject ?? "(no subject)")}</h2>
     <dl class="meta">
       <div><dt>To</dt><dd>${escapeHtml(message.recipient)}</dd></div>
       <div><dt>Status</dt><dd>${statusPill(status)}</dd></div>
       <div><dt>Mode</dt><dd class="mono">${escapeHtml(message.mode)}</dd></div>
       <div><dt>Message ID</dt><dd class="mono">${escapeHtml(message.id)}</dd></div>
       <div><dt>Opens</dt><dd class="mono">${escapeHtml(opens)}</dd></div>
       <div><dt>Clicks</dt><dd class="mono">${message.click_count}</dd></div>
       <div><dt>Created</dt><dd class="mono">${fmt(message.created_at)}</dd></div>
       <div><dt>Replied</dt><dd class="mono">false (stub)</dd></div>
     </dl>
     <h3>Timeline</h3>
     ${items}`,
  );
}

export function renderNotFound(): string {
  return layout("Not found · Agent Mail Track", `<p class="empty">Message not found.</p><p><a href="/">← All messages</a></p>`);
}

export const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
  "CDN-Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
} as const;
