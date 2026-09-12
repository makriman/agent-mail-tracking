import { Hono } from "hono";
import { requireApiKey } from "./auth";
import { classifyOpen } from "./classify";
import { messageStatus } from "./confidence";
import { newId } from "./crypto";
import {
  getLink,
  getMessage,
  hadHumanOpen,
  insertLinks,
  insertMessage,
  listEvents,
  listLinks,
  listMessages,
  recordEvent,
  serializeMessage,
} from "./db";
import { HTML_HEADERS, renderDetail, renderList, renderNotFound } from "./dashboard";
import {
  clickUrl,
  collectUrls,
  instrument,
  openUrl,
  trackingOrigin,
  trimSlash,
} from "./instrument";
import { buildRawMime } from "./mime";
import { PIXEL_HEADERS, pixelGifBytes } from "./pixel";
import { isSafeRedirectUrl } from "./redirect";
import { hashIp, signToken, verifyToken } from "./tokens";
import type { CreateMessageBody, Mode } from "./types";
import { MODES } from "./types";
import { fireWebhook, webhookPayload } from "./webhook";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

const MAX_BODY = 256 * 1024;
const MAX_METADATA = 8 * 1024;
const MAX_LIST = 100;

app.get("/health", (c) => c.json({ ok: true, service: "agent-mail-track", version: "0" }));

app.get("/favicon.ico", (c) => c.body(null, 204));

function pixelResponse(): Response {
  return new Response(pixelGifBytes(), { status: 200, headers: PIXEL_HEADERS });
}

app.get("/o/:token", async (c) => {
  const secret = c.env.TOKEN_SECRET;
  if (!secret) return pixelResponse();

  const token = c.req.param("token");
  const id = token ? await verifyToken("o", token, secret) : null;
  if (!id) return pixelResponse();

  const now = new Date().toISOString();
  const ua = (c.req.header("User-Agent") ?? "").slice(0, 512);
  const classification = classifyOpen(ua);
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  const ipHash = await hashIp(ip, secret);
  const country = c.req.header("CF-IPCountry") ?? null;

  try {
    const result = await recordEvent(c.env.DB, {
      id: newId("evt"),
      message_id: id,
      link_id: null,
      type: "open",
      created_at: now,
      ip_hash: ipHash,
      user_agent: ua || null,
      classification,
      cf_country: country,
    });
    if (result?.first && result.message.webhook_url) {
      const human = await hadHumanOpen(c.env.DB, id);
      const status = messageStatus(result.message, human);
      c.executionCtx.waitUntil(
        fireWebhook(
          result.message.webhook_url,
          webhookPayload("first_open", result.message, classification, status, now),
        ),
      );
    }
  } catch {
    // Still return the pixel so clients never show a broken image.
  }
  return pixelResponse();
});

app.get("/c/:token", async (c) => {
  const secret = c.env.TOKEN_SECRET;
  if (!secret) return c.json({ error: "server_misconfigured" }, 500);

  const token = c.req.param("token");
  const linkId = token ? await verifyToken("c", token, secret) : null;
  if (!linkId) return c.json({ error: "not_found" }, 404);

  const link = await getLink(c.env.DB, linkId);
  if (!link || !isSafeRedirectUrl(link.original_url)) {
    return c.json({ error: "invalid_destination" }, 400);
  }

  const now = new Date().toISOString();
  const ua = (c.req.header("User-Agent") ?? "").slice(0, 512);
  const classification = classifyOpen(ua);
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  const ipHash = await hashIp(ip, secret);
  const country = c.req.header("CF-IPCountry") ?? null;

  try {
    const result = await recordEvent(c.env.DB, {
      id: newId("evt"),
      message_id: link.message_id,
      link_id: link.id,
      type: "click",
      created_at: now,
      ip_hash: ipHash,
      user_agent: ua || null,
      classification,
      cf_country: country,
    });
    if (result?.first && result.message.webhook_url) {
      const human = await hadHumanOpen(c.env.DB, link.message_id);
      const status = messageStatus(result.message, human);
      c.executionCtx.waitUntil(
        fireWebhook(
          result.message.webhook_url,
          webhookPayload("first_click", result.message, classification, status, now),
        ),
      );
    }
  } catch {
    // Redirect anyway; telemetry failure must not strand the reader.
  }

  return c.redirect(link.original_url, 302);
});

app.use("/v1/*", requireApiKey);

app.get("/", requireApiKey, async (c) => {
  const messages = await listMessages(c.env.DB, 50);
  return c.html(renderList(messages), 200, HTML_HEADERS);
});

app.get("/m/:id", requireApiKey, async (c) => {
  const id = c.req.param("id");
  if (!id) return c.html(renderNotFound(), 404, HTML_HEADERS);
  const message = await getMessage(c.env.DB, id);
  if (!message) return c.html(renderNotFound(), 404, HTML_HEADERS);
  const [events, human] = await Promise.all([
    listEvents(c.env.DB, message.id),
    hadHumanOpen(c.env.DB, message.id),
  ]);
  return c.html(renderDetail(message, events, human), 200, HTML_HEADERS);
});

app.post("/v1/messages", async (c) => {
  const secret = c.env.TOKEN_SECRET;
  if (!c.env.API_KEY || !secret) {
    return c.json({ error: "server_misconfigured" }, 500);
  }

  let body: CreateMessageBody;
  try {
    body = await c.req.json<CreateMessageBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const error = validateCreate(body);
  if (error) return c.json({ error }, 400);

  const mode: Mode = body.mode ?? "plain_looking";
  const now = new Date().toISOString();
  const messageId = newId("msg");
  const baseUrl = trimSlash(body.base_url || new URL(c.req.url).origin);
  const urls = collectUrls(mode, body.text, body.html);

  const links: { id: string; original_url: string; token: string; tracked_url: string }[] = [];
  for (const original of urls) {
    const id = newId("lnk");
    const token = await signToken("c", id, secret);
    links.push({ id, original_url: original, token, tracked_url: clickUrl(baseUrl, token) });
  }
  const linkMap = new Map(links.map((l) => [l.original_url, l.tracked_url]));

  const openTracking = mode !== "plain_only";
  const openToken = openTracking ? await signToken("o", messageId, secret) : null;
  const pixelUrl = openToken ? openUrl(baseUrl, openToken) : null;

  const result = instrument({
    mode,
    text: body.text,
    html: body.html,
    linkMap,
    pixelUrl,
  });

  await insertMessage(c.env.DB, {
    id: messageId,
    created_at: now,
    recipient: body.to.trim(),
    subject: body.subject?.trim() || null,
    mode,
    open_tracking: result.open_tracking,
    metadata: body.metadata ? JSON.stringify(body.metadata) : null,
    webhook_url: body.webhook_url?.trim() || null,
    base_url: baseUrl,
  });
  await insertLinks(
    c.env.DB,
    links.map((l) => ({
      id: l.id,
      message_id: messageId,
      original_url: l.original_url,
      created_at: now,
    })),
  );

  const mime = buildRawMime({
    to: body.to.trim(),
    from: body.from?.trim() || null,
    subject: body.subject?.trim() || null,
    text: result.text,
    html: result.html,
    messageId,
    date: now,
    baseUrl,
  });

  return c.json(
    {
      message_id: messageId,
      mode,
      open_tracking: result.open_tracking,
      opens: result.open_tracking ? 0 : null,
      clicks: 0,
      status: "no_signal",
      replied: false,
      to: body.to.trim(),
      from: body.from?.trim() || null,
      subject: body.subject?.trim() || null,
      text: result.text,
      html: result.html,
      raw_mime: mime.raw_mime,
      raw_base64url: mime.raw_base64url,
      pixel_url: pixelUrl,
      base_url: baseUrl,
      links: links.map((l) => ({
        id: l.id,
        original_url: l.original_url,
        tracked_url: l.tracked_url,
      })),
      metadata: body.metadata ?? null,
      created_at: now,
    },
    201,
  );
});

app.get("/v1/messages", async (c) => {
  const raw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw)), MAX_LIST) : 50;
  const rows = await listMessages(c.env.DB, limit);
  const messages = [];
  for (const row of rows) {
    const human = row.open_tracking ? await hadHumanOpen(c.env.DB, row.id) : false;
    messages.push(serializeMessage(row, { humanOpen: human }));
  }
  return c.json({ messages });
});

app.get("/v1/messages/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getMessage(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const [links, events, human] = await Promise.all([
    listLinks(c.env.DB, row.id),
    listEvents(c.env.DB, row.id),
    hadHumanOpen(c.env.DB, row.id),
  ]);
  const origin = trackingOrigin(row.base_url, new URL(c.req.url).origin);
  return c.json(
    serializeMessage(row, {
      humanOpen: human,
      events,
      base_url: origin,
      links: await Promise.all(
        links.map(async (l) => ({
          id: l.id,
          original_url: l.original_url,
          tracked_url: clickUrl(origin, await signToken("c", l.id, c.env.TOKEN_SECRET)),
        })),
      ),
      pixel_url: row.open_tracking
        ? openUrl(origin, await signToken("o", row.id, c.env.TOKEN_SECRET))
        : null,
    }),
  );
});

app.notFound((c) => {
  if (c.req.path.startsWith("/v1/") || c.req.header("Accept")?.includes("application/json")) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.html(renderNotFound(), 404, HTML_HEADERS);
});

export default app;

function validateCreate(body: CreateMessageBody): string | null {
  if (!body || typeof body !== "object") return "invalid_body";
  if (
    typeof body.to !== "string" ||
    !body.to.includes("@") ||
    body.to.length > 320 ||
    /[\r\n]/.test(body.to)
  ) {
    return "invalid_to";
  }
  const mode = body.mode ?? "plain_looking";
  if (!MODES.includes(mode)) return "invalid_mode";

  if (body.subject != null && (typeof body.subject !== "string" || body.subject.length > 500)) {
    return "invalid_subject";
  }
  if (body.from != null) {
    if (
      typeof body.from !== "string" ||
      !body.from.includes("@") ||
      body.from.length > 320 ||
      /[\r\n]/.test(body.from)
    ) {
      return "invalid_from";
    }
  }
  if (body.text != null && (typeof body.text !== "string" || body.text.length > MAX_BODY)) {
    return "invalid_text";
  }
  if (body.html != null && (typeof body.html !== "string" || body.html.length > MAX_BODY)) {
    return "invalid_html";
  }

  if (mode === "html") {
    if (!body.html || !body.html.trim()) return "html_required";
  } else if (!body.text || !body.text.trim()) {
    return "text_required";
  }

  if (body.metadata != null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) return "invalid_metadata";
    try {
      if (JSON.stringify(body.metadata).length > MAX_METADATA) return "metadata_too_large";
    } catch {
      return "invalid_metadata";
    }
  }

  if (body.webhook_url != null) {
    if (typeof body.webhook_url !== "string" || !isAllowedWebhook(body.webhook_url)) {
      return "invalid_webhook_url";
    }
  }
  if (body.base_url != null) {
    if (typeof body.base_url !== "string" || !isSafeRedirectUrl(body.base_url)) {
      return "invalid_base_url";
    }
  }
  return null;
}

function isAllowedWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
