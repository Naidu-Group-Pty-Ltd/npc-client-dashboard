/**
 * `/calculators` is retired: every link that pointed at it lands somewhere that
 * does what the link meant, and none of them creates anything on arrival.
 *
 * The analysis workspace this route served was a second editor for the same
 * assessment records — its valuation and forecast are the assessment's
 * "Valuation & forecast" step now, and its property link is the register panel
 * on the Property step. What these pin is the page's one remaining job: the
 * redirect, as rendered by the router, from each of the three routes that
 * mounted it. The mapping itself is covered case by case in
 * `lib/ciAssessment/__tests__/legacyCalculatorLinks.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const create = vi.fn();
vi.mock('@/hooks/useCiAssessments', () => ({
  ciAssessmentApi: { create: (...args: unknown[]) => create(...args) },
}));

const { default: CommercialIndustrialWorkspace } = await import('../CommercialIndustrialWorkspace');

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

function arriveAt(path: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/calculators" element={<CommercialIndustrialWorkspace />} />
        <Route path="/commercial/calculators" element={<CommercialIndustrialWorkspace />} />
        <Route path="/industrial/calculators" element={<CommercialIndustrialWorkspace />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
  const landed = screen.getByTestId('landed').textContent;
  view.unmount();
  return landed;
}

afterEach(() => { cleanup(); create.mockReset(); });

describe('the retired analysis workspace', () => {
  it('opens an analysis link as the same assessment, at the step that holds its fields', () => {
    expect(arriveAt('/calculators?workspace=a1&stage=forecast')).toBe('/commercial/assessments/a1?step=analysis');
    expect(arriveAt('/calculators?workspace=a1')).toBe('/commercial/assessments/a1');
  });

  it('turns a property link into "New assessment" on that property — without creating one', () => {
    expect(arriveAt('/calculators?domain=industrial&propertyId=p1')).toBe(
      '/commercial?tab=assessments&new=assessment&domain=industrial&propertyId=p1',
    );
    // The old page minted an "Untitled analysis" on every property click.
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the old "Standalone calculators" button and its aliases to the assessment list', () => {
    expect(arriveAt('/calculators?domain=commercial')).toBe('/commercial?tab=assessments');
    expect(arriveAt('/commercial/calculators')).toBe('/commercial?tab=assessments');
    expect(arriveAt('/industrial/calculators')).toBe('/commercial?tab=assessments');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('what the redirect must keep', () => {
  it('stays behind the module guard on every route that mounted the workspace', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('src/App.tsx', 'utf8');
    for (const path of ['calculators', 'commercial/calculators', 'industrial/calculators']) {
      expect(app).toContain(`path="${path}" element={<ModuleGuard moduleKey="commercial"><CommercialIndustrialWorkspace />`);
    }
    // The pre-workspace suite is a separate route and is not touched by this.
    expect(app).toContain('path="calculators/classic" element={<ModuleGuard moduleKey="commercial"><PropertyCalculators />');
  });
});
