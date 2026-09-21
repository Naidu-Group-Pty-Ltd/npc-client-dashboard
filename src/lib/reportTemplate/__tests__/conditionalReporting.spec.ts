/**
 * An optional section that is absent is not a defect. A typo is.
 *
 * `evalConditional` rejects any expression naming something the data does not
 * bind, and must keep doing so: an unbound name resolves against the global
 * scope, which is what the allow-list exists to stop. But it reported the
 * *designed* path as a warning.
 *
 * The Borrowing Capacity masters guard three optional namespaces —
 * `explanation`, `audit` and `scenarios`. `explanation` and `audit_trail` are
 * columns written only by calculator runs since the keep-update, so 127 of the
 * 128 stored assessments do not carry them, and `scenarios` has no stored
 * producer at all. Those pages are meant to stay dark, and the guards in the
 * masters say so. Every render of every one of those masters logged three
 * "Rejected expression referencing unbound name" warnings — which is the noise a
 * genuine typo would hide in, and the typo is the case the check exists for.
 *
 * **This file used to end "The rejection is unchanged. Only the reporting
 * is."** That was true of the change it was written for and stopped being
 * true on 20 Sep 2026, because rejecting a guarded absent namespace cost more
 * than a warning. A rejection is `false`, so `name && name.x` and
 * `!(name && name.x)` were BOTH false when `name` was absent — and the second
 * is how a page in this catalogue renders its own absence:
 *
 *     { ...risks(…),   conditional: 'risks && risks[0] && risks[0].risk' }
 *     { ...callout(…), conditional: '!(risks && risks[0] && risks[0].risk)' }
 *
 * Three masters pair them that way and all three fallbacks were dead. Measured
 * on three delivered Investment Compass PDFs (9 Hollow Street, 1 Crestview
 * Avenue, 97 Poole Road, all 20 Sep 2026): page 5 printed the eyebrow "RISK
 * REGISTER" and the heading "Manageable with verification, not without it"
 * over NOTHING, then the recommendation — on every one.
 *
 * A guarded absent namespace is now BOUND as `undefined` instead, which is
 * what the author's own `name &&` asks for. Every assertion below is unchanged
 * and still passes: `undefined && …` is still falsy, and an unbound name still
 * cannot reach the global scope, because a parameter bound to `undefined` is
 * not a global lookup. What changed is only that the author's negated form now
 * means what it says.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { evalConditional } from '../bindingResolver';

const ctx = (data: Record<string, unknown>) => ({
  data,
  tokens: { colors: {}, fonts: {}, spacing: {} },
}) as never;

afterEach(() => vi.restoreAllMocks());

describe('conditional gating is unchanged', () => {
  it('is false when a guarded namespace is absent', () => {
    expect(evalConditional('explanation && explanation.steps', ctx({ capacity: {} }))).toBe(false);
    expect(evalConditional('audit && audit.rows', ctx({ capacity: {} }))).toBe(false);
  });

  it('is true when the guarded namespace is present', () => {
    const data = { explanation: { steps: [{ title: 'a' }] } };
    expect(evalConditional('explanation && explanation.steps', ctx(data))).toBe(true);
    expect(evalConditional(
      'explanation && explanation.steps && explanation.steps.length > 5',
      ctx({ explanation: { steps: Array.from({ length: 8 }, () => ({})) } }),
    )).toBe(true);
  });

  it('lets the author\'s NEGATED guard mean what it says', () => {
    /*
     * The pair a master actually writes. Both halves are asserted together,
     * because the defect was that they agreed: an absent namespace made the
     * section false AND its fallback false, so neither drew.
     */
    const POS = 'risks && risks[0] && risks[0].risk';
    const NEG = `!(${POS})`;
    const absent = ctx({ report: {} });
    expect(evalConditional(POS, absent), 'the section must not draw').toBe(false);
    expect(evalConditional(NEG, absent), 'its fallback must').toBe(true);

    // …and the other way round when the namespace IS there.
    const present = ctx({ risks: [{ risk: 'Flood overlay' }] });
    expect(evalConditional(POS, present)).toBe(true);
    expect(evalConditional(NEG, present)).toBe(false);

    // An empty array and an empty object are absences of a RISK, not of the
    // namespace: the fallback draws for those too, which it always did.
    expect(evalConditional(NEG, ctx({ risks: [] }))).toBe(true);
    expect(evalConditional(NEG, ctx({ risks: [{}] }))).toBe(true);
  });

  it('holds for the other two masters that pair a fallback the same way', () => {
    // `cashFlowComparison.ts` and `clientDetails.ts`. Asserted by expression
    // rather than by rendering, because the point is the evaluator.
    for (const pos of [
      'cashFlowComparison && cashFlowComparison.hasAnalysis',
      'clientDetails && clientDetails.hasFinancials',
    ]) {
      expect(evalConditional(pos, ctx({ report: {} }))).toBe(false);
      expect(evalConditional(`!(${pos})`, ctx({ report: {} }))).toBe(true);
    }
  });

  it('still refuses a name that would reach the global scope', () => {
    // The security case. `window` is all word characters and passes the
    // character whitelist; only the name allow-list stops it.
    expect(evalConditional('window && window.location', ctx({}))).toBe(false);
    expect(evalConditional('globalThis', ctx({}))).toBe(false);
  });

  it('binds a guarded global to undefined rather than reading the real one', () => {
    /*
     * The case the change has to earn. `window` matches the `name &&` guard
     * pattern, so it is now bound as a parameter instead of being refused
     * outright — and a parameter bound to `undefined` shadows the global. The
     * sharp assertion is the NEGATED form: this suite runs in jsdom, where a
     * real `window.location` exists, so a leak would make it false.
     */
    expect(typeof globalThis.window, 'the test needs a real global to shadow')
      .not.toBe('undefined');
    expect(evalConditional('!(window && window.location)', ctx({}))).toBe(true);
    expect(evalConditional('window && window.location', ctx({}))).toBe(false);
  });
});

describe('what gets reported', () => {
  it('says nothing when the author guarded the absent namespace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    evalConditional('explanation && explanation.steps', ctx({ capacity: {} }));
    evalConditional('scenarios && scenarios.rows', ctx({ capacity: {} }));
    evalConditional('audit && audit.rows && audit.rows.length > 7', ctx({ capacity: {} }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns when an unguarded name is referenced', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Dereferenced without ever being tested — the shape of a typo that is
    // meant to be loud.
    evalConditional('explanation.steps.length > 0', ctx({ capacity: {} }));
    expect(warn).toHaveBeenCalled();
  });

  it('warns when only some of the unbound names are guarded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    evalConditional('explanation && explanation.steps && audit.rows', ctx({ capacity: {} }));
    expect(warn).toHaveBeenCalled();
  });
});
