/**
 * The Commercial & Industrial module, wired: one way in, one workflow.
 *
 * What these pin is the structure the September 2026 audit settled on, as the
 * pages actually render it:
 *
 *  - the landing offers ONE way to start an assessment, and it asks before it
 *    creates — no "Standalone calculators" (a second editor for the same
 *    records), no ten duplicate type buttons, no record minted on a click;
 *  - the tabs name what they hold — the Property register, Policy defaults;
 *  - a register property starts an assessment of that building;
 *  - the assessment carries the analysis the calculators workspace had, as an
 *    optional "Valuation & forecast" step between Loan structure and Results,
 *    with the ten established steps unchanged around it;
 *  - the intake step creates a client in-app, against the assessment, instead
 *    of opening the client list in a new tab;
 *  - archiving and deleting live with the record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { baseAssessment } from '@/lib/ciAssessment/__tests__/fixtures';
import type { AssessmentPayload } from '@/lib/ciAssessment/types';

// ---- The data layer ----------------------------------------------------------

let assessmentRecord: Record<string, unknown> | null = null;
let assessmentPayload: AssessmentPayload | null = null;
const listRows: Array<Record<string, unknown>> = [];
const reload = vi.fn();
const saveNow = vi.fn();

vi.mock('@/hooks/useCiAssessments', () => ({
  ciAssessmentApi: {
    archive: vi.fn().mockResolvedValue({ data: {}, error: null }),
    restore: vi.fn().mockResolvedValue({ data: {}, error: null }),
    runCalculation: vi.fn(),
    complete: vi.fn(),
    clientWorkspace: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
  useCiAssessments: () => ({
    rows: listRows,
    loading: false,
    refresh: vi.fn(),
    metrics: { active: listRows.length, completed: 0, requiringReview: 0, totalProposedLending: 0, averageProposedLvr: 0 },
  }),
  useCiAssessment: () => ({
    record: assessmentRecord,
    payload: assessmentPayload,
    loading: false,
    error: null,
    saveState: 'saved',
    lastSavedAt: null,
    update: vi.fn(),
    saveNow,
    saveTitle: vi.fn(),
    reload,
  }),
}));

const createAssessment = vi.fn();
const previewDeletion = vi.fn();
const intendedClient = vi.fn();
vi.mock('@/lib/ciAssessment/assessmentManagement', () => ({
  createAssessment: (...args: unknown[]) => createAssessment(...args),
  previewDeletion: (...args: unknown[]) => previewDeletion(...args),
  deleteAssessment: vi.fn(),
  archiveAssessment: vi.fn().mockResolvedValue({ data: {}, error: null }),
  restoreAssessment: vi.fn().mockResolvedValue({ data: {}, error: null }),
  intendedClient: (...args: unknown[]) => intendedClient(...args),
  searchClients: vi.fn().mockResolvedValue({ data: [], error: null }),
  createClient: vi.fn(),
  listAssessmentsForProperty: vi.fn().mockResolvedValue({ data: [], error: null }),
}));

const PROPERTY_ID = '6b0f4c1e-9a55-4e3c-9c1b-2f6f1d2b7a10';
const BUILDING = {
  id: PROPERTY_ID, user_id: 'u1', address: 'G12/25 Solent Circuit', suburb: 'Norwest', state: 'NSW',
  postcode: '2153', asset_class: 'office', tenure: 'freehold', gst_treatment: 'going_concern',
  purchase_price: 2_400_000, nla_sqm: 310, outgoings_recoverable: {}, industrial_specs: {},
  created_at: '', updated_at: '',
};
vi.mock('@/hooks/useCommercialProperties', () => ({
  useCommercialProperties: () => ({ properties: [BUILDING], loading: false, refresh: vi.fn() }),
  commercialApi: {
    listProperties: vi.fn().mockResolvedValue({ data: [BUILDING], error: null }),
    deleteProperty: vi.fn(),
  },
}));
vi.mock('@/hooks/useIndustrialProperties', () => ({
  useIndustrialProperties: () => ({ properties: [], loading: false, refresh: vi.fn() }),
  industrialApi: { listProperties: vi.fn().mockResolvedValue({ data: [], error: null }), deleteProperty: vi.fn() },
}));

vi.mock('@/hooks/useCapacityReport', () => ({ useCapacityReport: () => ({ generatingId: null, generate: vi.fn() }) }));
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: () => ({ isSuperadmin: true, permissions: [] }) }));
vi.mock('@/hooks/useModulePermissions', () => ({ useModulePermissions: () => ({ canEdit: true, canDelete: true }) }));
// The template selector is the platform's own and is exercised by its own
// suite; here it only has to be present where it was.
vi.mock('@/components/reports/ReportTemplateSelector', () => ({
  ReportTemplateSelector: () => <div>Report template</div>,
}));

const { default: CommercialIndustrial } = await import('../CommercialIndustrial');
const { default: CommercialAssessmentWorkspace } = await import('../CommercialAssessmentWorkspace');

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{`${location.pathname}${location.search}`}</p>;
}

/**
 * `workspace: false` leaves the assessment route out, so a test asserting WHERE
 * the landing navigates reads the location itself rather than whatever the
 * workspace renders for an id the mocks do not hold.
 */
function renderAt(path: string, { workspace = true }: { workspace?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/commercial" element={<CommercialIndustrial />} />
        {workspace && <Route path="/commercial/assessments/:id" element={<CommercialAssessmentWorkspace />} />}
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listRows.length = 0;
  assessmentRecord = null;
  assessmentPayload = null;
  createAssessment.mockReset().mockResolvedValue({ data: { id: 'new-1' }, error: null });
  previewDeletion.mockReset().mockResolvedValue({
    data: {
      allowed: true, block: null, archiveOffered: false, permitted: true, typedConfirmation: false,
      message: 'Deleting permanently removes this assessment.', reference: 'CI-202609-AYY4E',
      title: 'Untitled assessment', status: 'draft', counts: { calculationRuns: 0, scenarios: 0 },
    },
    error: null,
  });
  intendedClient.mockReset().mockResolvedValue({ data: null, error: null });
  saveNow.mockReset().mockResolvedValue(undefined);
  reload.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

// ---- The landing -------------------------------------------------------------

describe('the module landing', () => {
  it('offers one way to start an assessment, and no second editor', () => {
    renderAt('/commercial');
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: /new assessment/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /standalone calculators/i })).toBeNull();
    expect(screen.queryByText(/start from a transaction type/i)).toBeNull();
  });

  it('asks before it creates anything', async () => {
    renderAt('/commercial', { workspace: false });
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /new assessment/i }));
    expect(await screen.findByRole('dialog', { name: /new assessment/i })).toBeInTheDocument();
    expect(createAssessment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /create assessment/i }));
    // A new assessment opens on the intake pack — the dialog asked the type.
    await waitFor(() => expect(screen.getByTestId('landed')).toHaveTextContent('/commercial/assessments/new-1?step=pack'));
    expect(createAssessment).toHaveBeenCalledTimes(1);
  });

  it('names its tabs for what they hold', () => {
    renderAt('/commercial');
    expect(screen.getByRole('tab', { name: 'Property register' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Policy defaults' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /calculator settings/i })).toBeNull();
  });

  it('starts an assessment of a building from its register row', async () => {
    renderAt('/commercial?tab=properties');
    fireEvent.click(screen.getByRole('button', { name: /new assessment of g12\/25 solent circuit/i }));
    const dialog = await screen.findByRole('dialog', { name: /new assessment/i });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /property/i })).toHaveTextContent('G12/25 Solent Circuit'));
  });

  it('opens "New assessment" on a building when a link asks it to — the old calculators links land here', async () => {
    renderAt(`/commercial?tab=assessments&new=assessment&domain=commercial&propertyId=${PROPERTY_ID}`);
    const dialog = await screen.findByRole('dialog', { name: /new assessment/i });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /property/i })).toHaveTextContent('G12/25 Solent Circuit'));
    expect(createAssessment).not.toHaveBeenCalled();
  });

  it('closes a dialog a link opened, and it stays closed', async () => {
    renderAt(`/commercial?tab=assessments&new=assessment&domain=commercial&propertyId=${PROPERTY_ID}`);
    const dialog = await screen.findByRole('dialog', { name: /new assessment/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    // The dialog is read from the link, so it closes only if the link is cleared.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /new assessment/i })).toBeNull());
    expect(createAssessment).not.toHaveBeenCalled();
  });

  it('lets an assessment be deleted from its row, after asking the server', async () => {
    listRows.push({
      id: 'a1', reference: 'CI-202609-AYY4E', title: 'Untitled assessment', status: 'draft', segment: 'commercial',
      assessment_type: 'commercial_investment', requested_loan: null, maximum_indicative_loan: null,
      proposed_lvr: null, proposed_dscr: null, outcome: null, binding_constraint: null, client_id: null,
      linked_at: null, current_calculation_id: null, version: 1, created_at: '', updated_at: '', archived_at: null,
    });
    renderAt('/commercial');
    // Archive and delete sit behind the row's own menu, as they do in the
    // assessment's header.
    fireEvent.pointerDown(
      screen.getByRole('button', { name: /more actions for untitled assessment/i }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' },
    );
    expect(await screen.findByRole('menuitem', { name: /archive/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    await waitFor(() => expect(previewDeletion).toHaveBeenCalledWith('a1'));
    expect(await screen.findByRole('button', { name: /delete permanently/i })).toBeInTheDocument();
  });
});

// ---- The assessment ------------------------------------------------------------

function openAssessment(step: string, overrides: Record<string, unknown> = {}) {
  assessmentPayload = baseAssessment();
  assessmentRecord = {
    id: 'a1', reference: 'CI-202609-AYY4E', title: '45 Industrial Drive', status: 'data_entry',
    segment: 'commercial', assessment_type: 'commercial_investment', client_id: null,
    current_calculation_id: null, version: 3, archived_at: null, ...overrides,
  };
  return renderAt(`/commercial/assessments/a1?step=${step}`);
}

describe('the assessment workflow', () => {
  it('keeps the ten established steps in order, with Valuation & forecast before Results', () => {
    openAssessment('type');
    const nav = screen.getByRole('navigation', { name: /assessment steps/i });
    const labels = within(nav).getAllByRole('button').map((button) => button.textContent?.replace(/^\d+/, '').trim());
    expect(labels).toEqual([
      'Type', 'Intake pack', 'Property & transaction', 'Ownership', 'Income', 'Portfolio',
      'Lease income', 'Loan structure', 'Valuation & forecast', 'Results', 'Save & link',
    ]);
  });

  it('carries the valuation and forecast the calculators workspace had — optional, and said so', () => {
    openAssessment('analysis');
    expect(screen.getByText(/optional\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Valuation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Forecast' })).toBeInTheDocument();
  });

  it('asks on the property step whether this is a building in the register', () => {
    openAssessment('property');
    expect(screen.getByText(/is this a property in your register/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /link a register property/i })).toBeInTheDocument();
  });

  it('creates the client in-app from the intake step, never in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openAssessment('pack');
    fireEvent.click(await screen.findByRole('button', { name: /create a new client/i }));
    expect(await screen.findByRole('dialog', { name: /create the client/i })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('names who it is being prepared for, before it is linked', async () => {
    intendedClient.mockResolvedValue({
      data: {
        clientId: 'c1', source: 'intended', recordedAt: '',
        client: { id: 'c1', primary_first_name: 'Marcus', primary_surname: 'Chen', primary_email: null, primary_mobile: null, updated_at: null },
      },
      error: null,
    });
    openAssessment('pack');
    expect(await screen.findByText(/for marcus chen \(not linked yet\)/i)).toBeInTheDocument();
    expect(screen.getByText(/being prepared for marcus chen/i)).toBeInTheDocument();
    // One client is not created twice from the same assessment.
    expect(screen.queryByRole('button', { name: /create a new client/i })).toBeNull();
  });

  it('keeps archiving and deleting with the record', async () => {
    openAssessment('type');
    const trigger = screen.getByRole('button', { name: /more actions/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: /archive assessment/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /delete assessment/i }));

    // Any pending edit is saved before the delete is asked about.
    await waitFor(() => expect(saveNow).toHaveBeenCalled());
    await waitFor(() => expect(previewDeletion).toHaveBeenCalledWith('a1'));
  });
});
