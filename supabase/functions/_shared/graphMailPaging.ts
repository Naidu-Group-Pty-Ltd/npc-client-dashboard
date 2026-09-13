/**
 * Reading a Microsoft 365 mailbox as far as it goes, in both directions.
 *
 * ## What this replaces
 *
 * Two functions asked Graph for mail and neither followed the pager.
 * `outlook-email-sync` issued `?$top=${limit}` once per folder and returned
 * `data.value`; `email-sync-cron` did the same with a hardcoded `$top=30`.
 * `@odata.nextLink` was never read by either, so the Email Co-Pilot could hold
 * the most recent page of each folder and, structurally, nothing else.
 * Measured 13 Sep 2026 on the same mailbox: the clone held 101 rows against
 * the prime's 5,677 — 1.8% — and no amount of re-syncing would ever have
 * closed it, because the second page was never requested.
 *
 * It lives here rather than in either function because it was already written
 * twice and the two copies had already drifted (30 versus a caller-supplied
 * limit; inbox-only versus inbox-and-sent). A third copy is how a fix lands in
 * one of them.
 *
 * ## Two rules that are easy to get wrong
 *
 * **A `nextLink` is opaque and complete.** It already carries `$top`,
 * `$select`, `$orderby` and any `$filter`; appending to it or rebuilding it
 * from parts is how a paginator silently starts re-reading page one for ever.
 * It is followed verbatim or not at all.
 *
 * **"No more pages" and "out of budget" are different answers.** Graph
 * offering no `nextLink` means the mailbox is exhausted in that direction and
 * a backfill is genuinely finished. Stopping on a deadline means come back.
 * Collapsing them makes a half-read mailbox report itself complete, which is
 * indistinguishable from a working import and is exactly the failure this
 * module exists to end.
 */

export const GRAPH_MAIL_SELECT =
  "id,internetMessageId,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments";

/** Graph accepts `$top` up to 1000; 100 keeps a page carrying bodies sane. */
export const GRAPH_MAIL_PAGE_SIZE = 100;

export type MailFolder = "inbox" | "sent";

/** The property both `$orderby` and `$filter` must name, per folder. */
export function dateFieldFor(folder: MailFolder | string): string {
  return folder === "sent" ? "sentDateTime" : "receivedDateTime";
}

export function mailboxPathFor(
  mailboxEmail: string,
  folder: MailFolder | string,
): string {
  return folder === "sent"
    ? `https://graph.microsoft.com/v1.0/users/${mailboxEmail}/mailFolders/sentitems/messages`
    : `https://graph.microsoft.com/v1.0/users/${mailboxEmail}/messages`;
}

export function firstPageUrl(
  mailboxEmail: string,
  folder: MailFolder | string,
  pageSize: number,
  olderThanIso?: string | null,
): string {
  const dateField = dateFieldFor(folder);
  const params = [
    `$top=${Math.min(GRAPH_MAIL_PAGE_SIZE, Math.max(1, pageSize))}`,
    `$orderby=${dateField} desc`,
    `$select=${GRAPH_MAIL_SELECT}`,
  ];
  // The backfill's entire resume mechanism: "older than the oldest I already
  // hold" needs no stored cursor, cannot go stale, and converges even when an
  // invocation dies halfway, because the next one re-derives the boundary from
  // what is actually in the table.
  if (olderThanIso) params.push(`$filter=${dateField} lt ${olderThanIso}`);
  return `${mailboxPathFor(mailboxEmail, folder)}?${params.join("&")}`;
}

export interface MailPage<T> {
  readonly messages: T[];
  /** Followed verbatim on the next call, or null when the folder is spent. */
  readonly nextLink: string | null;
}

export async function fetchMailPage<T = unknown>(
  accessToken: string,
  url: string,
  label = "graph-mail",
): Promise<MailPage<T>> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[${label}] Graph returned ${response.status}: ${errorText}`,
    );
  }

  const data = await response.json();
  return {
    messages: (data?.value ?? []) as T[],
    nextLink:
      typeof data?.["@odata.nextLink"] === "string"
        ? data["@odata.nextLink"]
        : null,
  };
}

export interface MailWindow {
  /** Stop once this many messages are in hand. */
  readonly max: number;
  /** Stop once `Date.now()` passes this. Absent means no clock limit. */
  readonly deadline?: number;
  /** Only messages strictly older than this ISO timestamp. */
  readonly olderThanIso?: string | null;
  /** Hard ceiling on pages, so a pathological mailbox cannot spin. */
  readonly maxPages?: number;
}

export interface MailWindowResult<T> {
  readonly messages: T[];
  /**
   * True only when GRAPH offered no further page — the folder is spent in this
   * direction. False means we stopped early and there is more to collect.
   * Never inferred from an empty page alone.
   */
  readonly exhausted: boolean;
  readonly pages: number;
  /** True when the stop was a deadline rather than the end of the folder. */
  readonly stoppedOnBudget: boolean;
}

export async function fetchMailWindow<T = unknown>(
  accessToken: string,
  mailboxEmail: string,
  folder: MailFolder | string,
  window: MailWindow,
  label = "graph-mail",
): Promise<MailWindowResult<T>> {
  const max = Math.max(1, Math.floor(window.max));
  const maxPages = Math.max(1, Math.floor(window.maxPages ?? 100));
  const collected: T[] = [];

  let url: string | null = firstPageUrl(
    mailboxEmail,
    folder,
    max,
    window.olderThanIso,
  );
  let pages = 0;
  let stoppedOnBudget = false;

  while (url && collected.length < max && pages < maxPages) {
    const page: MailPage<T> = await fetchMailPage<T>(accessToken, url, label);
    pages += 1;
    collected.push(...page.messages);
    url = page.nextLink;

    // An empty page with no nextLink is the end. An empty page WITH a nextLink
    // happens when a $filter excludes everything on that page, and following
    // it is how the walk gets past a quiet stretch.
    if (page.messages.length === 0 && !url) break;
    if (window.deadline !== undefined && Date.now() > window.deadline) {
      stoppedOnBudget = true;
      break;
    }
  }

  return {
    messages: collected.slice(0, max),
    // Exhausted only if Graph itself ran out, and only if we did not cut the
    // walk short for our own reasons.
    exhausted: url === null && !stoppedOnBudget,
    pages,
    stoppedOnBudget,
  };
}
