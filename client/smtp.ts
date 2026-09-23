import * as net from "node:net";
import * as tls from "node:tls";
import { AmtClientError, type SmtpSendOptions, type SmtpSendResult } from "./types";

export function envelopeAddress(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AmtClientError(`invalid_address: ${value.replace(/[\r\n]+/g, " ").trim()}`);
  }
  const trimmed = value.trim();
  let addr = trimmed;
  if (trimmed.includes("<") || trimmed.includes(">")) {
    const angled = trimmed.match(/^([^<>]*)<([^<>]+)>([^<>]*)$/);
    if (!angled || angled[3]?.trim()) {
      throw new AmtClientError(`invalid_address: ${trimmed}`);
    }
    addr = angled[2]!.trim();
  }
  addr = addr.replace(/^mailto:/i, "").trim();
  if (!/^[^\s<>"']+@[^\s<>"']+$/.test(addr) || addr.length > 320) {
    throw new AmtClientError(`invalid_address: ${trimmed}`);
  }
  return addr;
}

/** EHLO is one token. Strip CR/LF, whitespace, and other controls so the name cannot open a second SMTP command. */
export function smtpEhloName(value: string | undefined): string {
  const name = (value ?? "amt.localhost").replace(/[\u0000-\u0020\u007F\s]/g, "");
  if (!name) throw new AmtClientError("invalid smtp ehlo name");
  return name;
}

/** Normalize CRLF and dot-stuff lines for SMTP DATA. */
export function smtpDataPayload(rawMime: string): string {
  const normalized = rawMime.replace(/\r?\n/g, "\r\n");
  const stuffed = normalized.replace(/^\./gm, "..");
  return stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
}

class SmtpSession {
  private socket: net.Socket;
  private buf = "";
  private queue: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed: Error | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  static connect(host: string, port: number, secure: boolean, timeoutMs: number): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      const socket = secure
        ? tls.connect({ host, port, servername: host }, () => {
            socket.off("error", onErr);
            const session = new SmtpSession(socket);
            session.setTimeout(timeoutMs);
            resolve(session);
          })
        : net.connect({ host, port }, () => {
            socket.off("error", onErr);
            const session = new SmtpSession(socket);
            session.setTimeout(timeoutMs);
            resolve(session);
          });
      socket.once("error", onErr);
    });
  }

  private attach(socket: net.Socket) {
    socket.on("data", (chunk: Buffer | string) => {
      this.buf += typeof chunk === "string" ? chunk : chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        let line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.queue.push(line);
      }
    });
    socket.on("error", (err) => {
      this.closed = err;
      this.flushWaiters(err);
    });
    socket.on("close", () => {
      if (!this.closed) this.closed = new AmtClientError("smtp connection closed");
      this.flushWaiters(this.closed);
    });
  }

  private flushWaiters(err: Error) {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w(`000 ${err.message}`);
  }

  setTimeout(ms: number) {
    this.socket.setTimeout(ms, () => {
      this.closed = new AmtClientError("smtp timeout");
      this.socket.destroy(this.closed);
    });
  }

  async startTls(host: string, timeoutMs: number): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSocket = tls.connect({ socket: plain, servername: host }, () => resolve(tlsSocket));
      tlsSocket.once("error", reject);
    });
    this.socket = upgraded;
    this.attach(upgraded);
    this.setTimeout(timeoutMs);
  }

  write(data: string) {
    this.socket.write(data);
  }

  private readLine(): Promise<string> {
    if (this.closed && this.queue.length === 0) return Promise.reject(this.closed);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as string);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async readReply(): Promise<{ code: number; text: string; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.length < 3) throw new AmtClientError(`smtp_bad_reply: ${line}`);
      const code = Number(line.slice(0, 3));
      if (!Number.isFinite(code)) throw new AmtClientError(`smtp_bad_reply: ${line}`);
      const sep = line[3] ?? " ";
      lines.push(line.slice(4));
      if (sep === " ") return { code, text: lines.join("\n"), lines };
      if (sep !== "-") throw new AmtClientError(`smtp_bad_reply: ${line}`);
    }
  }

  async expect(ok: number | number[], label: string): Promise<{ code: number; text: string; lines: string[] }> {
    const reply = await this.readReply();
    const allowed = Array.isArray(ok) ? ok : [ok];
    if (!allowed.includes(reply.code)) {
      throw new AmtClientError(`smtp_error: ${label} → ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  async command(cmd: string, ok: number | number[], label = cmd.split(" ")[0] ?? "CMD") {
    this.write(`${cmd}\r\n`);
    return this.expect(ok, label);
  }

  capabilities(lines: string[]): { starttls: boolean; auth: Set<string> } {
    const auth = new Set<string>();
    let starttls = false;
    for (const line of lines) {
      const u = line.toUpperCase();
      if (u === "STARTTLS" || u.startsWith("STARTTLS ")) starttls = true;
      const authMatch = u.match(/^AUTH(?:\s|=)(.+)$/);
      if (authMatch?.[1]) {
        for (const mech of authMatch[1].trim().split(/\s+/)) auth.add(mech);
      }
    }
    return { starttls, auth };
  }

  async close() {
    try {
      this.write("QUIT\r\n");
    } catch {
      // ignore
    }
    this.socket.end();
  }
}

export async function sendRawMimeSmtp(opts: SmtpSendOptions): Promise<SmtpSendResult> {
  const host = opts.host?.trim();
  if (!host) throw new AmtClientError("smtp host is required");
  const port = opts.port;
  if (!Number.isFinite(port) || port <= 0) throw new AmtClientError("smtp port is required");
  const secure = opts.secure ?? port === 465;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ehloName = smtpEhloName(opts.ehloName);
  const mailFrom = envelopeAddress(opts.from);
  const rcptTo = envelopeAddress(opts.to);
  if (!opts.rawMime) throw new AmtClientError("rawMime is required");
  if (!opts.user || opts.pass == null) throw new AmtClientError("smtp user and pass are required");

  const session = await SmtpSession.connect(host, port, secure, timeoutMs);
  try {
    await session.expect(220, "banner");
    let ehlo = await session.command(`EHLO ${ehloName}`, 250, "EHLO");
    let caps = session.capabilities(ehlo.lines);
    let encrypted = secure;

    if (!encrypted && caps.starttls) {
      await session.command("STARTTLS", 220, "STARTTLS");
      await session.startTls(host, timeoutMs);
      ehlo = await session.command(`EHLO ${ehloName}`, 250, "EHLO");
      caps = session.capabilities(ehlo.lines);
      encrypted = true;
    }
    if (!encrypted) {
      throw new AmtClientError("smtp STARTTLS required (refusing AUTH on plaintext)");
    }

    if (caps.auth.has("PLAIN")) {
      const payload = Buffer.from(`\u0000${opts.user}\u0000${opts.pass}`, "utf8").toString("base64");
      await session.command(`AUTH PLAIN ${payload}`, 235, "AUTH PLAIN");
    } else {
      await session.command("AUTH LOGIN", 334, "AUTH LOGIN");
      await session.command(Buffer.from(opts.user, "utf8").toString("base64"), 334, "AUTH LOGIN user");
      await session.command(Buffer.from(opts.pass, "utf8").toString("base64"), 235, "AUTH LOGIN pass");
    }

    await session.command(`MAIL FROM:<${mailFrom}>`, 250, "MAIL FROM");
    await session.command(`RCPT TO:<${rcptTo}>`, [250, 251], "RCPT TO");
    session.write("DATA\r\n");
    await session.expect(354, "DATA");
    session.write(`${smtpDataPayload(opts.rawMime)}.\r\n`);
    const done = await session.expect(250, "DATA body");
    return { accepted: true, code: done.code, response: done.text };
  } finally {
    await session.close();
  }
}
