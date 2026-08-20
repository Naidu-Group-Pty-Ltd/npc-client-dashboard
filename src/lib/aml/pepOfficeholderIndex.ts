/**
 * Browser entry point for the office-holder index contract — see
 * `supabase/functions/_shared/aml/pepOfficeholderIndex.pure.ts`.
 *
 * The readings, the coverage prose and the rule that a miss is not a
 * clearance are decided once, there, and rendered from here.
 */
export {
  PEP_INDEX_SOURCES,
  describeCoverage,
  indexIsUsable,
  searchVerdict,
  candidateToMethodDraft,
  type PepIndexSourceCode,
  type PepIndexCoverage,
  type PepIndexCandidate,
  type PepIndexReading,
  type PepIndexVerdict,
} from '../../../supabase/functions/_shared/aml/pepOfficeholderIndex.pure.ts';
