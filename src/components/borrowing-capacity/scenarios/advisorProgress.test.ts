/**
 * What the Strategy Advisor says while it works.
 *
 * The chat used to draw one spinning circle for the 20–90 seconds a request
 * takes. These specs hold the stages to what the server actually reaches, the
 * rotating line to facts from the brief, and both ends to working when the
 * other is older.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  acceptsStage,
  advanceProgress,
  advisorProgressView,
  bindingConstraintOf,
  briefFacts,
  draftingDetail,
  FACT_ROTATION_MS,
  formatElapsed,
  initialProgress,
  PATIENCE_AFTER_MS,
  progressEvent,
  readingDetail,
  readProgressEvent,
  revisingDetail,
  validatingDetail,
} from '@/lib/advisorProgress.pure';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const SERVER = read('../../../../supabase/functions/bc-scenario-agent/index.ts');
const AGENT = read('./BCScenarioAgent.tsx');

/** The Maslin Yawa brief, as the browser sends it. */
const BRIEF = {
  capacity: 1258615,
  monthlySurplus: 7212,
  dtiRatio: 9.18,
  liabilities: [
    { label: 'Money Me', balance: 10000, monthlyServicing: 862 },
    { label: 'Pepper Money', balance: 18000, monthlyServicing: 440 },
  ],
  properties: [{ address: '17 Cahill Street, Innisfail, 4860', current_value: 290000, loan_remaining: 232000 }],
};

describe('the wire', () => {
  it('reads what the server sends, and nothing else', () => {
    const sent = JSON.parse(JSON.stringify(progressEvent('drafting', 'Aiming at $900,000', 'scenarios')));
    expect(readProgressEvent(sent)).toEqual({ stage: 'drafting', detail: 'Aiming at $900,000', mode: 'scenarios' });
    expect(readProgressEvent({ choices: [{ delta: { content: 'x' } }] })).toBeNull();
    expect(readProgressEvent({ progress: { stage: 'thinking' } })).toBeNull();
    expect(readProgressEvent({ progress: { stage: 'reading', detail: '  ' } })).toEqual({ stage: 'reading', detail: null });
    expect(readProgressEvent(null)).toBeNull();
  });

  it('an older browser passes over the event, because it reads only `error` and `choices`', () => {
    const event = progressEvent('reading', 'Capacity today $1');
    expect('error' in event).toBe(false);
    expect('choices' in event).toBe(false);
  });
});

describe('the stages', () => {
  it('never move backwards, so a late report is ignored', () => {
    expect(acceptsStage('drafting', 'reading')).toBe(false);
    expect(acceptsStage('reading', 'drafting')).toBe(true);
    expect(acceptsStage('drafting', 'drafting')).toBe(true);
    const drafting = advanceProgress(initialProgress(0), { stage: 'drafting' }, 10);
    expect(advanceProgress(drafting, { stage: 'reading', detail: 'late' }, 20)).toBe(drafting);
  });

  it('a repeat of the current stage adds detail without resetting its clock', () => {
    const local = advanceProgress(initialProgress(0), { stage: 'reading' }, 100);
    const server = advanceProgress(local, { stage: 'reading', detail: 'Capacity today $1,258,615' }, 400);
    expect(server).toMatchObject({ stage: 'reading', detail: 'Capacity today $1,258,615', stageAt: 100 });
    // A new stage without its own detail does not carry the old stage's.
    expect(advanceProgress(server, { stage: 'drafting' }, 500).detail).toBeNull();
  });

  it('shows the revision step only when there was one', () => {
    const draft = advanceProgress(initialProgress(0), { stage: 'drafting', mode: 'scenarios' }, 0);
    const plain = advisorProgressView(draft, 1000, []).steps.map((s) => s.stage);
    expect(plain).toEqual(['sending', 'reading', 'drafting', 'validating', 'finishing']);
    const revised = advanceProgress(draft, { stage: 'revising', detail: revisingDetail(2, 3) }, 5000);
    const view = advisorProgressView(revised, 6000, []);
    expect(view.steps.map((s) => s.stage)).toContain('revising');
    expect(view.steps.find((s) => s.stage === 'validating')?.state).toBe('done');
    expect(view.headline).toBe('Revising the scenarios the engine flagged');
    expect(view.patienceNote).toBe('A revision adds up to 45 seconds.');
  });

  it('a question about the cards is an answer, not three new scenarios', () => {
    const answer = advanceProgress(initialProgress(0), { stage: 'drafting', mode: 'answer' }, 0);
    const view = advisorProgressView(answer, 1000, []);
    expect(view.headline).toBe('Writing the answer');
    expect(view.steps.map((s) => s.stage)).toEqual(['sending', 'reading', 'drafting', 'finishing']);
  });
});

describe('what the bubble says', () => {
  const facts = briefFacts(BRIEF);

  it('the brief line is a figure the browser sent, one at a time', () => {
    expect(facts).toEqual([
      'Capacity today $1,258,615, monthly surplus $7,212',
      'Debt-to-income ratio 9.18x',
      'Money Me, $10,000 balance, $862/mo',
      'Pepper Money, $18,000 balance, $440/mo',
      '17 Cahill Street, Innisfail, 4860, valued $290,000, loan $232,000, LVR 80%',
    ]);
    const drafting = advanceProgress(initialProgress(0), { stage: 'drafting' }, 1000);
    const lines = [0, 1, 2, 5].map((n) => advisorProgressView(drafting, 1000 + n * FACT_ROTATION_MS, facts).briefLine);
    expect(lines).toEqual([facts[0], facts[1], facts[2], facts[0]]);
  });

  it('never claims what the model is thinking', () => {
    for (const line of facts) expect(line).not.toMatch(/consider|weigh|think|pay(ing)? out|recommend/i);
  });

  it('draws no brief line outside the model\'s own stages', () => {
    const reading = advanceProgress(initialProgress(0), { stage: 'reading' }, 0);
    expect(advisorProgressView(reading, 5000, facts).briefLine).toBeNull();
    const finishing = advanceProgress(reading, { stage: 'finishing' }, 10);
    expect(advisorProgressView(finishing, 5000, facts).briefLine).toBeNull();
  });

  it('counts the time since the request was sent, and says when a long wait is normal', () => {
    const drafting = advanceProgress(initialProgress(0), { stage: 'drafting' }, 2000);
    expect(advisorProgressView(drafting, 25_000, facts)).toMatchObject({ elapsed: '0:25', patienceNote: null });
    expect(advisorProgressView(drafting, PATIENCE_AFTER_MS, facts).patienceNote).toMatch(/up to a minute and a half/);
    expect(formatElapsed(64_900)).toBe('1:04');
  });

  it('an empty brief draws no line rather than a blank one', () => {
    expect(briefFacts({})).toEqual([]);
    expect(briefFacts({ liabilities: [{ label: ' ' }], properties: [{ address: '' }] })).toEqual([]);
  });
});

describe('the server wording', () => {
  it('reads the position in figures', () => {
    expect(readingDetail({ capacity: 1258615, constraint: 'dti_cap', dtiCap: 6 }))
      .toBe('Capacity today $1,258,615 · the 6x debt-to-income cap is what limits capacity');
    expect(readingDetail({ capacity: null, constraint: null, dtiCap: 6 })).toBeNull();
    expect(draftingDetail({ mode: 'scenarios', targetPrice: 900000 })).toBe('Aiming three scenarios at the $900,000 purchase');
    expect(draftingDetail({ mode: 'scenarios', targetPrice: null })).toBe('Drafting three scenarios to lift borrowing capacity');
    expect(validatingDetail(3)).toBe('Running all 3 scenarios through the borrowing engine');
    expect(validatingDetail(1)).toBe('Running the scenario through the borrowing engine');
  });

  it('classifies the constraint by the thresholds the prompt always used', () => {
    expect(bindingConstraintOf({ dtiCapEnabled: true, dtiHeadroom: 0.01, surplus: 100, capacity: 50 })).toBe('dti_cap');
    expect(bindingConstraintOf({ dtiCapEnabled: false, dtiHeadroom: 0.01, surplus: 499, capacity: 50 })).toBe('monthly_surplus');
    expect(bindingConstraintOf({ dtiCapEnabled: false, dtiHeadroom: 1, surplus: 500, capacity: 99_999 })).toBe('low_capacity');
    expect(bindingConstraintOf({ dtiCapEnabled: false, dtiHeadroom: 1, surplus: 500, capacity: 100_000 })).toBe('serviceability');
  });
});

describe('both ends', () => {
  it('the server reports every stage it reaches, in order', () => {
    const at = (s: string) => SERVER.indexOf(s);
    const reading = at("send(progressEvent('reading'");
    const drafting = at("send(progressEvent('drafting'");
    const call = at('const response = await callAI(aiMessages');
    const validating = at("send(progressEvent('validating'");
    const revising = at("send(progressEvent('revising'");
    const revisionCall = at('const revResp = await callAI(');
    for (const i of [reading, drafting, call, validating, revising, revisionCall]) expect(i).toBeGreaterThan(0);
    expect(reading).toBeLessThan(drafting);
    expect(drafting).toBeLessThan(call);
    expect(call).toBeLessThan(validating);
    expect(revising).toBeLessThan(revisionCall);
  });

  it('the prompt keeps its own words for the constraint', () => {
    for (const phrase of [
      'gross income — capacity is hard-capped here, income-growth and debt-payoff levers help most)',
      'monthly surplus (expense reduction or income growth move the needle most)',
      'low absolute capacity — focus on commitment reduction',
      'surplus (serviceability)',
    ]) expect(SERVER).toContain(phrase);
  });

  it('the chat draws the bubble, moves itself on for an older server, and clears it when done', () => {
    expect(AGENT).toContain('<AdvisorProgressBubble progress={progress} facts={progressFacts} />');
    expect(AGENT).toContain('readProgressEvent(parsed)');
    expect(AGENT).toContain('setTimeout(() => advance({ stage: \'drafting\' }), LOCAL_DRAFTING_AFTER_MS)');
    expect(AGENT).toContain('setProgress(null);');
    expect(AGENT).not.toContain('Loader2');
  });
});
