/**
 * Where an old "calculators" link goes now.
 *
 * ## What was retired, and why
 *
 * `/calculators` served a second workspace over the very same assessment
 * records — the "Standalone calculators" button on the module landing opened
 * it. It listed the same assessments ("Untitled assessment · Draft"), created
 * the same records under another name ("Untitled analysis"), and edited them
 * through a second, differently ordered set of stages. Two editors for one
 * record, and nothing to tell a user which one they were meant to be in.
 *
 * Its only capability the assessment lacked — the valuation and the forecast —
 * is now a step of the assessment itself, and starting from a register property
 * is part of "New assessment". So the route is a redirect: every link that has
 * ever pointed at it lands somewhere that does what the link meant.
 *
 * | Arrival | Lands on |
 * | --- | --- |
 * | `?workspace=<id>[&stage=<s>]` | that assessment, at the matching step |
 * | `?propertyId=<id>[&domain=<d>]` | the module, with "New assessment" open on that property |
 * | anything else | the module's assessment list |
 *
 * A property link does not create a record on arrival. It used to — every
 * "Send to Calculators" click minted an "Untitled analysis" — and the dialog it
 * now opens asks for the one confirmation that stops a stray click becoming a
 * draft nobody wanted.
 *
 * The pre-workspace suite at `/calculators/classic` is a separate route and is
 * untouched by this.
 */

export interface LegacyCalculatorParams {
  workspace: string | null;
  stage: string | null;
  domain: string | null;
  propertyId: string | null;
}

/**
 * The analysis workspace's stages, mapped to the assessment step that now
 * holds the same fields. `context` named the analysis and chose the
 * transaction type, which is the Type step; `report` generated the document,
 * which is done from Results.
 */
const STAGE_TO_STEP: Readonly<Record<string, string>> = {
  context: 'type',
  property: 'property',
  income: 'lease',
  ownership: 'ownership',
  lending: 'loan',
  valuation: 'analysis',
  forecast: 'analysis',
  results: 'results',
  report: 'results',
};

/** The query parameter the module landing reads to open "New assessment". */
export const NEW_ASSESSMENT_PARAM = 'new';
export const NEW_ASSESSMENT_VALUE = 'assessment';

/** The landing link that opens "New assessment", optionally on a property. */
export function newAssessmentPath(property?: { domain: string; propertyId: string } | null): string {
  const params = new URLSearchParams({ tab: 'assessments', [NEW_ASSESSMENT_PARAM]: NEW_ASSESSMENT_VALUE });
  if (property) {
    params.set('domain', property.domain === 'industrial' ? 'industrial' : 'commercial');
    params.set('propertyId', property.propertyId);
  }
  return `/commercial?${params.toString()}`;
}

/** What a "New assessment" link asks for: the dialog, and optionally the building. */
export interface NewAssessmentLink {
  property: { domain: 'commercial' | 'industrial'; propertyId: string } | null;
}

/**
 * Read a `newAssessmentPath` link back off the landing's URL — `null` when the
 * URL does not ask for the dialog. A building is named only when both halves
 * are present and the register is one the module has; anything else opens the
 * dialog with no building rather than guessing which register was meant.
 */
export function readNewAssessmentLink(params: URLSearchParams): NewAssessmentLink | null {
  if (params.get(NEW_ASSESSMENT_PARAM) !== NEW_ASSESSMENT_VALUE) return null;
  const domain = params.get('domain');
  const propertyId = params.get('propertyId')?.trim();
  return {
    property: propertyId && (domain === 'commercial' || domain === 'industrial') ? { domain, propertyId } : null,
  };
}

/** The same URL without the request — what the landing writes when the dialog closes. */
export function withoutNewAssessmentLink(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(NEW_ASSESSMENT_PARAM);
  next.delete('domain');
  next.delete('propertyId');
  return next;
}

export function legacyCalculatorRedirect(params: LegacyCalculatorParams): string {
  const workspace = params.workspace?.trim();
  if (workspace) {
    const step = params.stage ? STAGE_TO_STEP[params.stage] : undefined;
    return `/commercial/assessments/${encodeURIComponent(workspace)}${step ? `?step=${step}` : ''}`;
  }

  const propertyId = params.propertyId?.trim();
  if (propertyId) {
    return newAssessmentPath({ domain: params.domain === 'industrial' ? 'industrial' : 'commercial', propertyId });
  }

  return '/commercial?tab=assessments';
}
