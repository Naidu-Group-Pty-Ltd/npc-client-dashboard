/**
 * `/calculators`, `/commercial/calculators` and `/industrial/calculators` —
 * retired, and redirected.
 *
 * ## What used to be here
 *
 * The "Commercial & Industrial Analysis" workspace: a second editor for the very
 * same assessment records the assessment workflow edits. The module landing's
 * "Standalone calculators" button opened it; it listed the same assessments
 * ("Untitled assessment · Draft"), minted the same records under another name
 * ("Untitled analysis"), and edited them through nine stages ordered
 * differently from the assessment's ten. It was not standalone in any sense a
 * user could rely on — whatever was entered there WAS the assessment — and two
 * ways into one record, with nothing to say which was the real one, is the
 * duplication the module was audited for.
 *
 * ## Where its capability went
 *
 * - **Valuation and forecast** (the cap-rate and DCF stages, unchanged) are the
 *   assessment's optional "Valuation & forecast" step.
 * - **Linking a register property** is the panel on the Property & transaction
 *   step — now saved on the record, where it used to live only in this page's
 *   URL and was lost when the analysis was reopened.
 * - **The report** was always the platform's `commercial_capacity` document,
 *   generated from the assessment's Results step exactly as before.
 *
 * So this page is a redirect, planned by a pure function so that every
 * bookmark is a test case (`legacyCalculatorLinks.ts`). The route stays
 * guarded by `ModuleGuard`, and the pre-workspace suite at
 * `/calculators/classic` is a separate route this does not touch.
 *
 * The stage components the workspace mounted remain in
 * `components/commercial/workspace/`. Valuation and Forecast are mounted by the
 * assessment; the rest are kept, unmounted, for a separate clean-up. This
 * change reaches every clone by cascade, and a clone can carry code of its own
 * (`docs/operations/CLONE_PROVISIONING_GAPS.md`), so it deletes nothing a
 * clone's own code might still import. See `docs/commercial/MODULE_STRUCTURE.md`.
 */

import { Navigate, useSearchParams } from 'react-router-dom';
import { legacyCalculatorRedirect } from '@/lib/ciAssessment/legacyCalculatorLinks';

export default function CommercialIndustrialWorkspace() {
  const [searchParams] = useSearchParams();
  const to = legacyCalculatorRedirect({
    workspace: searchParams.get('workspace'),
    stage: searchParams.get('stage'),
    domain: searchParams.get('domain'),
    propertyId: searchParams.get('propertyId'),
  });
  return <Navigate to={to} replace />;
}
