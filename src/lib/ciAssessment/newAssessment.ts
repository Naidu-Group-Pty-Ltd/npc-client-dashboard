/**
 * What "New assessment" creates.
 *
 * ## Why this asks two questions before creating anything
 *
 * "New assessment" used to create a record on the click — titled "Untitled
 * assessment", typed as a commercial investment — and open it on the type step
 * to ask the questions afterwards. Every click that went no further left an
 * untitled draft behind, and with no way to delete one, the list filled with
 * them. It now asks the name and the transaction type first (the two things the
 * type step asked straight away anyway), optionally the register property and
 * the client, and creates nothing until the operator says so.
 *
 * Pure, so the rules — which segment a type implies, what a register property
 * fills, what the record is called when nobody names it — are test cases.
 */

import type { CalculatorPrefill } from '@/contexts/CalculatorPrefillContext';
import { applyRegisterProperty, type RegisterPropertyLink } from './registerProperty';
import type { PrefillChange } from './propertyPrefill';
import {
  assessmentTypeDefinition, emptyAssessmentPayload,
  type AssessmentPayload, type AssessmentType,
} from './types';

export type Segment = 'commercial' | 'industrial';

/**
 * The segment an assessment is filed under.
 *
 * A type that names its segment decides it. A type that fits either (a
 * refinance, a mixed-use deal) takes the operator's choice, then the building
 * it concerns, then commercial.
 */
export function segmentFor(
  type: AssessmentType,
  choice: Segment | null,
  propertyIsIndustrial: boolean | null,
): Segment {
  const definition = assessmentTypeDefinition(type);
  if (definition.segment === 'industrial') return 'industrial';
  if (definition.segment === 'commercial') return 'commercial';
  if (choice) return choice;
  if (propertyIsIndustrial) return 'industrial';
  return 'commercial';
}

/** The name a record gets when the operator leaves the field blank. */
export function defaultTitle(type: AssessmentType, propertyLabel: string | null): string {
  const label = propertyLabel?.trim();
  const definition = assessmentTypeDefinition(type);
  return label ? `${label} — ${definition.label.toLowerCase()}` : 'Untitled assessment';
}

export interface NewAssessmentInput {
  title: string;
  assessmentType: AssessmentType;
  segmentChoice: Segment | null;
  /** The register property the assessment concerns, with its prefill. */
  property?: { prefill: CalculatorPrefill; link: RegisterPropertyLink; industrial: boolean } | null;
}

export interface NewAssessmentPlan {
  title: string;
  segment: Segment;
  assessmentType: AssessmentType;
  payload: AssessmentPayload;
  /** What the register property filled, for the confirmation toast. */
  applied: PrefillChange[];
}

export function planNewAssessment(input: NewAssessmentInput): NewAssessmentPlan {
  const segment = segmentFor(input.assessmentType, input.segmentChoice, input.property?.industrial ?? null);

  let payload = emptyAssessmentPayload(input.assessmentType);
  // An "either" type filed as industrial is an industrial building: the
  // classification is what drives the industrial-only fields and metrics.
  if (segment === 'industrial' && payload.property.classification === 'commercial') {
    payload = {
      ...payload,
      property: { ...payload.property, classification: 'industrial', assetClass: 'warehouse' },
    };
  }

  let applied: PrefillChange[] = [];
  if (input.property) {
    const outcome = applyRegisterProperty(payload, input.property.prefill, input.property.link);
    payload = outcome.payload;
    applied = outcome.applied;
  }

  const title = input.title.trim().slice(0, 300)
    || defaultTitle(input.assessmentType, input.property?.link.label ?? null);

  return { title, segment, assessmentType: input.assessmentType, payload, applied };
}
