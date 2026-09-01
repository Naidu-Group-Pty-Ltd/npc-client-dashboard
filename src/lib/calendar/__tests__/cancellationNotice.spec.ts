/**
 * Audit item 33 — a cancellation reached only the client.
 *
 * The command centre set `appointmentStatus: 'cancelled'` on GoHighLevel and
 * stopped. GHL emails the client; the additional contact and the finance
 * partner — who were invited by `send-appointment-notification` — were told
 * nothing.
 *
 * These read the deployed source rather than sending anything. No mail leaves
 * this repository during a test run, which is the point: the assertions are
 * about the contract, and the contract is what makes the live behaviour safe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..', '..');
const notifier = readFileSync(
  join(root, 'supabase', 'functions', 'send-appointment-notification', 'index.ts'),
  'utf8',
);
const calendarPage = readFileSync(join(root, 'src', 'pages', 'Calendar.tsx'), 'utf8');

describe('cancellation notice — the existing invitation path is untouched', () => {
  it('treats an absent kind as the invitation it has always sent', () => {
    // Every caller that predates cancellations omits `kind`. If the default
    // ever changed, those callers would start sending cancellations.
    expect(notifier).toMatch(/kind\s*=\s*'booked'/);
    expect(notifier).toMatch(/const isCancellation = kind === 'cancelled'/);
  });

  it('keeps REQUEST, CONFIRMED and the reminder for an invitation', () => {
    expect(notifier).toMatch(/params\.cancelled \? 'METHOD:CANCEL' : 'METHOD:REQUEST'/);
    expect(notifier).toMatch(/params\.cancelled \? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED'/);
    // The alarm is dropped only for a cancellation.
    expect(notifier).toMatch(/\.\.\.\(params\.cancelled \? \[\] : \[/);
  });
});

describe('cancellation notice — what a cancellation does', () => {
  it('retracts the invitation rather than re-issuing it', () => {
    // A calendar client keeps the original unless the cancellation out-ranks
    // it, so the sequence has to advance.
    expect(notifier).toMatch(/params\.cancelled \? 'SEQUENCE:1' : 'SEQUENCE:0'/);
    expect(notifier).toMatch(/method=\$\{isCancellation \? 'CANCEL' : 'REQUEST'\}/);
  });

  it('says it is a cancellation in the subject and the body', () => {
    expect(notifier).toMatch(/Meeting Cancelled: \$\{appointmentTitle\}/);
    expect(notifier).toMatch(/has been cancelled/);
  });

  it('resolves the recipients from what was actually invited', () => {
    // The page holds an event id and nothing else, so the list cannot come
    // from the caller without risking uninviting a different set of people.
    expect(notifier).toMatch(/from\('appointment_secondary_recipients'\)/);
    expect(notifier).toMatch(/\.eq\('appointment_ghl_id', appointmentGhlId\)/);
  });

  it('tells each person once, however many rows they have', () => {
    // One row is written per recipient per notification, so a person who was
    // emailed twice must not be cancelled at twice.
    expect(notifier).toMatch(/seen\.has\(email\)/);
  });

  it('never writes itself into the invitation log', () => {
    // That table is the record of who was INVITED and is what the next
    // cancellation reads back.
    const inserts = notifier.match(/if \(!isCancellation\) await supabase\s*\n\s*\.from\('appointment_secondary_recipients'\)/g) ?? [];
    expect(inserts).toHaveLength(2);
  });
});

describe('meeting link — audit item 33', () => {
  it('carries the location, so a Zoom booking arrives with its link', () => {
    // The function had no location field at all, so neither the email nor the
    // .ics could ever have contained a join link.
    expect(notifier).toMatch(/appointmentLocation\?: string/);
    expect(notifier).toMatch(/LOCATION:\$\{escapeICS\(params\.location\)\}/);
  });

  it('renders a URL as a link and anything else as plain text', () => {
    expect(notifier).toMatch(/\^https\?:/);
    expect(notifier).toMatch(/'Join' : 'Location'/);
  });

  it('is passed from every path that notifies', () => {
    // Booking, reschedule and cancellation.
    const passes = calendarPage.match(/appointmentLocation:/g) ?? [];
    expect(passes).toHaveLength(3);
  });
});

describe('cancellation notice — the page', () => {
  it('sends the notice after the cancellation, never instead of it', () => {
    expect(calendarPage).toMatch(/const result = await updateEvent\(event\.id, \{ appointmentStatus: 'cancelled' \}\)/);
    expect(calendarPage).toMatch(/if \(!result\?\.success\) return result/);
  });

  it('does not let a failed email report a successful cancellation as failed', () => {
    const helper = calendarPage.slice(
      calendarPage.indexOf('const cancelEventAndNotify'),
      calendarPage.indexOf('// Go to today'),
    );
    expect(helper).toMatch(/catch \(err\)/);
    expect(helper).toMatch(/return result;/);
  });

  it('leaves the recipient list to the server', () => {
    const helper = calendarPage.slice(
      calendarPage.indexOf('const cancelEventAndNotify'),
      calendarPage.indexOf('// Go to today'),
    );
    expect(helper).toMatch(/kind: 'cancelled'/);
    expect(helper).toMatch(/recipients: \[\]/);
  });
});
