import type { Classification, MessageRow, Status } from "./types";

export async function fireWebhook(
  webhookUrl: string,
  payload: {
    type: "first_open" | "first_click";
    message_id: string;
    to: string;
    subject: string | null;
    status: Status;
    classification: Classification;
    occurred_at: string;
  },
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "agent-mail-track/0",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // Fire-and-forget: webhook failures must not break tracking.
  } finally {
    clearTimeout(timer);
  }
}

export function webhookPayload(
  type: "first_open" | "first_click",
  message: MessageRow,
  classification: Classification,
  status: Status,
  occurred_at: string,
) {
  return {
    type,
    message_id: message.id,
    to: message.recipient,
    subject: message.subject,
    status,
    classification,
    occurred_at,
  };
}
