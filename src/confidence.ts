import type { Classification, MessageRow, Status } from "./types";

/**
 * replied (future stub) > clicked > high-confidence open > proxy/suspected open > no signal
 *
 * v0 never emits `replied`. `opens` is null when open_tracking is off — callers
 * must not treat a missing open count as zero.
 */
export function messageStatus(
  row: Pick<MessageRow, "click_count" | "open_count" | "open_tracking" | "last_classification">,
  hadHumanOpen = false,
): Status {
  if (row.click_count > 0) return "clicked";
  if (!row.open_tracking) return "no_signal";
  if (row.open_count <= 0) return "no_signal";
  if (hadHumanOpen || row.last_classification === "human_likely") {
    return "high_confidence_open";
  }
  return "proxy_open";
}

export function isHumanOpen(classification: Classification): boolean {
  return classification === "human_likely";
}
