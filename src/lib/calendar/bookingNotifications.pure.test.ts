import { describe, expect, it } from 'vitest';
import {
  describeNotificationPlan,
  planBookingNotifications,
  type PartyInput,
} from './bookingNotifications.pure';

const client: PartyInput = { role: 'client', name: 'Arvin Raj', email: 'arvin@example.com' };
const additional: PartyInput = { role: 'additional_contact', name: 'Priya Raj', email: 'priya@example.com' };
const partner: PartyInput = { role: 'finance_partner', name: 'Broker Bob', email: 'bob@brokers.com', financeContactId: 'fc-1' };

const withCrm = { linked: true, sendsClientConfirmation: false };
const noCrm = { linked: false, sendsClientConfirmation: false };

describe('the client is a recipient like everyone else', () => {
  it('emails the client alongside the others — the reported gap', () => {
    const plan = planBookingNotifications({ parties: [client, additional, partner], crm: withCrm });
    expect(plan.recipients.map((r) => r.email)).toContain('arvin@example.com');
    expect(plan.recipients).toHaveLength(3);
    expect(plan.clientNotifiedBy).toBe('platform');
  });

  it('works with no CRM at all — the booking is announced the same way', () => {
    const plan = planBookingNotifications({ parties: [client, partner], crm: noCrm });
    expect(plan.clientNotifiedBy).toBe('platform');
    expect(plan.recipients.map((r) => r.role)).toEqual(['client', 'finance_partner']);
  });

  it('stands aside only when a CRM is linked AND sends its own confirmation', () => {
    const plan = planBookingNotifications({
      parties: [client, additional],
      crm: { linked: true, sendsClientConfirmation: true },
    });
    expect(plan.clientNotifiedBy).toBe('crm');
    expect(plan.recipients.map((r) => r.email)).toEqual(['priya@example.com']);
  });

  it('never leaves the client to a CRM that is not there', () => {
    // The dangerous combination: configured for CRM delivery, no CRM linked.
    const plan = planBookingNotifications({
      parties: [client],
      crm: { linked: false, sendsClientConfirmation: true },
    });
    expect(plan.clientNotifiedBy).toBe('platform');
    expect(plan.recipients.map((r) => r.email)).toEqual(['arvin@example.com']);
    expect(plan.warnings.join(' ')).toMatch(/no crm is linked/i);
  });
});

describe('one person, one email', () => {
  it('collapses an address that appears under two roles, keeping the client role', () => {
    const plan = planBookingNotifications({
      parties: [client, { role: 'additional_contact', name: 'Arvin (personal)', email: 'ARVIN@example.com' }],
      crm: withCrm,
    });
    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0].role).toBe('client');
  });

  it('keeps the finance contact id when a partner is also listed as a contact', () => {
    const plan = planBookingNotifications({
      parties: [
        { role: 'additional_contact', name: 'Bob', email: 'bob@brokers.com', financeContactId: 'fc-1' },
        { role: 'finance_partner', name: 'Broker Bob', email: 'bob@brokers.com', financeContactId: 'fc-1' },
      ],
      crm: withCrm,
    });
    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0].financeContactId).toBe('fc-1');
  });

  it('matches addresses regardless of case or padding', () => {
    const plan = planBookingNotifications({
      parties: [client, { role: 'additional_contact', email: '  Arvin@Example.com  ' }],
      crm: withCrm,
    });
    expect(plan.recipients).toHaveLength(1);
  });
});

describe('a missing address is reported, never silently dropped', () => {
  it('says so when the client has no email', () => {
    const plan = planBookingNotifications({
      parties: [{ role: 'client', name: 'Arvin' }, partner],
      crm: noCrm,
    });
    expect(plan.clientNotifiedBy).toBe('none');
    expect(plan.warnings.join(' ')).toMatch(/no email address on file for the client/i);
    expect(plan.recipients.map((r) => r.role)).toEqual(['finance_partner']);
  });

  it('says so for a contact and a partner too', () => {
    const plan = planBookingNotifications({
      parties: [client, { role: 'additional_contact', name: 'X' }, { role: 'finance_partner', name: 'Y' }],
      crm: withCrm,
    });
    expect(plan.warnings).toHaveLength(2);
  });

  it('reports nothing when everyone can be reached', () => {
    expect(planBookingNotifications({ parties: [client, partner], crm: withCrm }).warnings).toEqual([]);
  });
});

describe('the recipient list itself', () => {
  it('falls back to the address when a party has no name', () => {
    const plan = planBookingNotifications({ parties: [{ role: 'client', email: 'a@b.com' }], crm: noCrm });
    expect(plan.recipients[0].name).toBe('a@b.com');
  });

  it('gives every recipient a stable key, so a cancellation notice is sent once', () => {
    const plan = planBookingNotifications({ parties: [client, additional], crm: withCrm });
    const keys = plan.recipients.map((r) => r.financeContactId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(Boolean)).toBe(true);
  });

  it('orders the client first', () => {
    const plan = planBookingNotifications({ parties: [additional, partner, client], crm: withCrm });
    expect(plan.recipients[0].role).toBe('client');
  });

  it('handles an empty booking without inventing anyone', () => {
    const plan = planBookingNotifications({ parties: [], crm: noCrm });
    expect(plan.recipients).toEqual([]);
    expect(plan.clientNotifiedBy).toBe('none');
  });
});

describe('describeNotificationPlan — what the operator reads before booking', () => {
  it('names the client as included', () => {
    const plan = planBookingNotifications({ parties: [client, partner], crm: withCrm });
    expect(describeNotificationPlan(plan)).toBe('2 people will be emailed from here, including the client.');
  });

  it('says the CRM handles the client when it genuinely does', () => {
    const plan = planBookingNotifications({
      parties: [client, partner],
      crm: { linked: true, sendsClientConfirmation: true },
    });
    expect(describeNotificationPlan(plan)).toMatch(/your CRM emails the client separately/);
  });

  it('is honest when nobody will be emailed', () => {
    const plan = planBookingNotifications({ parties: [], crm: noCrm });
    expect(describeNotificationPlan(plan)).toBe('Nobody will be emailed about this booking.');
  });

  it('uses the singular for one person', () => {
    const plan = planBookingNotifications({ parties: [client], crm: noCrm });
    expect(describeNotificationPlan(plan)).toMatch(/^1 person will be emailed/);
  });
});
