/**
 * Starting an assessment, and deleting one.
 *
 * "New assessment" used to create a record on the click, and there was no way
 * to delete one — so every click that went no further left an undeletable
 * "Untitled assessment" behind. These pin both ends: the dialog creates nothing
 * until it is confirmed, and the delete dialog does exactly what the server
 * decided, saying why when the answer is no.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const createAssessment = vi.fn();
const searchClients = vi.fn();
const previewDeletion = vi.fn();
const deleteAssessment = vi.fn();
const archiveAssessment = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/ciAssessment/assessmentManagement', () => ({
  createAssessment: (...args: unknown[]) => createAssessment(...args),
  searchClients: (...args: unknown[]) => searchClients(...args),
  previewDeletion: (...args: unknown[]) => previewDeletion(...args),
  deleteAssessment: (...args: unknown[]) => deleteAssessment(...args),
  archiveAssessment: (...args: unknown[]) => archiveAssessment(...args),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isSuperadmin: false, permissions: [] }),
}));

const PROPERTY_ID = '6b0f4c1e-9a55-4e3c-9c1b-2f6f1d2b7a10';
const listCommercial = vi.fn();
const listIndustrial = vi.fn();
vi.mock('@/hooks/useCommercialProperties', () => ({
  commercialApi: { listProperties: (...args: unknown[]) => listCommercial(...args) },
}));
vi.mock('@/hooks/useIndustrialProperties', () => ({
  industrialApi: { listProperties: (...args: unknown[]) => listIndustrial(...args) },
}));

const { NewAssessmentDialog } = await import('../NewAssessmentDialog');
const { DeleteAssessmentDialog } = await import('../DeleteAssessmentDialog');

const INDUSTRIAL_BUILDING = {
  id: PROPERTY_ID, user_id: 'u1', address: '45 Industrial Drive', suburb: 'Wetherill Park', state: 'NSW',
  postcode: '2164', asset_class: 'industrial', tenure: 'freehold', gst_treatment: 'going_concern',
  purchase_price: 6_100_000, nla_sqm: 4_200, site_area_sqm: 8_000, outgoings_recoverable: {},
  industrial_specs: {}, created_at: '', updated_at: '',
};

beforeEach(() => {
  createAssessment.mockReset().mockResolvedValue({ data: { id: 'new-1' }, error: null });
  searchClients.mockReset().mockResolvedValue({ data: [], error: null });
  previewDeletion.mockReset();
  deleteAssessment.mockReset().mockResolvedValue({ data: { id: 'a1', reference: 'CI-202609-AYY4E' }, error: null });
  archiveAssessment.mockReset().mockResolvedValue({ data: { id: 'a1' }, error: null });
  listCommercial.mockReset().mockResolvedValue({ data: [INDUSTRIAL_BUILDING], error: null });
  listIndustrial.mockReset().mockResolvedValue({ data: [], error: null });
  toast.mockReset();
});

afterEach(cleanup);

describe('New assessment', () => {
  function openDialog(props: Partial<Parameters<typeof NewAssessmentDialog>[0]> = {}) {
    const onCreated = vi.fn();
    render(
      <MemoryRouter>
        <NewAssessmentDialog open onOpenChange={() => {}} onCreated={onCreated} {...props} />
      </MemoryRouter>,
    );
    return { onCreated };
  }

  it('creates nothing until it is confirmed', async () => {
    openDialog();
    expect(await screen.findByRole('dialog', { name: /new assessment/i })).toBeInTheDocument();
    expect(createAssessment).not.toHaveBeenCalled();
  });

  it('creates a named record of the chosen type, and hands back its id', async () => {
    const { onCreated } = openDialog();
    fireEvent.change(await screen.findByLabelText(/assessment name/i), { target: { value: '45 Industrial Drive — acquisition' } });
    fireEvent.click(screen.getByRole('button', { name: /create assessment/i }));

    await waitFor(() => expect(createAssessment).toHaveBeenCalledWith(expect.objectContaining({
      title: '45 Industrial Drive — acquisition',
      assessmentType: 'commercial_investment',
      segment: 'commercial',
      intendedClientId: null,
    })));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-1' })));
  });

  it('starts from the building it was opened for, filling it in and filing it by what it is', async () => {
    const { onCreated } = openDialog({ initialProperty: { domain: 'commercial', propertyId: PROPERTY_ID } });
    // The register loads, the building is chosen, and an untouched type follows it.
    await waitFor(() => expect(screen.getByRole('combobox', { name: /property/i })).toHaveTextContent('45 Industrial Drive'));
    fireEvent.click(screen.getByRole('button', { name: /create assessment/i }));

    await waitFor(() => expect(createAssessment).toHaveBeenCalled());
    const input = createAssessment.mock.calls[0][0];
    expect(input.assessmentType).toBe('industrial_investment');
    expect(input.segment).toBe('industrial');
    expect(input.title).toBe('45 Industrial Drive — industrial investment');
    expect(input.payload.property.address).toBe('45 Industrial Drive');
    expect(input.payload.property.purchasePrice).toBe(6_100_000);
    expect(input.payload.property.registerProperty).toMatchObject({ domain: 'commercial', propertyId: PROPERTY_ID });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ filledFromProperty: expect.any(Number) })));
  });

  it('records the client it is being prepared for — as an intent, never a link', async () => {
    searchClients.mockResolvedValue({
      data: [{ id: 'c1', primary_first_name: 'Marcus', primary_surname: 'Chen', primary_email: 'm@c.test', primary_mobile: null, updated_at: null }],
      error: null,
    });
    openDialog();
    fireEvent.change(await screen.findByLabelText(/search your clients/i), { target: { value: 'Marcus' } });
    fireEvent.click(await screen.findByRole('button', { name: /marcus chen/i }, { timeout: 2000 }));
    fireEvent.click(screen.getByRole('button', { name: /create assessment/i }));

    await waitFor(() => expect(createAssessment).toHaveBeenCalledWith(expect.objectContaining({ intendedClientId: 'c1' })));
  });

  it('says so when the building it was opened for is not in the register', async () => {
    openDialog({ initialProperty: { domain: 'industrial', propertyId: PROPERTY_ID } });
    expect(await screen.findByText(/no longer in your register/i)).toBeInTheDocument();
  });

  it('starts every opening from a fresh form', async () => {
    const dialog = (open: boolean) => (
      <MemoryRouter><NewAssessmentDialog open={open} onOpenChange={() => {}} onCreated={() => {}} /></MemoryRouter>
    );
    const view = render(dialog(true));
    fireEvent.change(await screen.findByLabelText(/assessment name/i), { target: { value: 'Half-typed' } });
    view.rerender(dialog(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.rerender(dialog(true));
    expect(await screen.findByLabelText(/assessment name/i)).toHaveValue('');
  });
});

describe('Delete assessment', () => {
  const ASSESSMENT = { id: 'a1', title: 'Untitled assessment', reference: 'CI-202609-AYY4E' };

  function preview(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        allowed: true, block: null, archiveOffered: false, permitted: true, typedConfirmation: false,
        message: 'Deleting permanently removes this assessment with its calculation runs, scenarios and audit history.',
        reference: ASSESSMENT.reference, title: ASSESSMENT.title, status: 'draft',
        counts: { calculationRuns: 2, scenarios: 0 },
        ...overrides,
      },
      error: null,
    };
  }

  function openDialog() {
    const onDeleted = vi.fn();
    const onArchived = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeleteAssessmentDialog
        assessment={ASSESSMENT}
        open
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
        onArchived={onArchived}
      />,
    );
    return { onDeleted, onArchived, onOpenChange };
  }

  it('asks the server first, then deletes a draft from one explicit button', async () => {
    previewDeletion.mockResolvedValue(preview());
    const { onDeleted } = openDialog();

    expect(await screen.findByText(/removed with it: 2 saved calculation runs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));

    await waitFor(() => expect(deleteAssessment).toHaveBeenCalledWith('a1', undefined));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(ASSESSMENT));
  });

  it('asks for the reference before deleting a completed assessment', async () => {
    previewDeletion.mockResolvedValue(preview({ status: 'completed', typedConfirmation: true }));
    openDialog();

    const button = await screen.findByRole('button', { name: /delete permanently/i });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type CI-202609-AYY4E to confirm/i), { target: { value: 'ci-202609-ayy4e' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(deleteAssessment).toHaveBeenCalledWith('a1', 'ci-202609-ayy4e'));
  });

  it('keeps what reached a client or a report, says why, and offers archiving', async () => {
    previewDeletion.mockResolvedValue(preview({
      allowed: false, block: 'report_issued', archiveOffered: true,
      message: 'A report has been issued from this assessment, and the assessment is kept as the record of what that document states.',
    }));
    const { onArchived } = openDialog();

    expect(await screen.findByText(/a report has been issued from this assessment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete permanently/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /archive instead/i }));

    await waitFor(() => expect(archiveAssessment).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(onArchived).toHaveBeenCalled());
    expect(deleteAssessment).not.toHaveBeenCalled();
  });

  it('tells a user without delete permission, rather than offering a button that will fail', async () => {
    previewDeletion.mockResolvedValue(preview({ permitted: false }));
    openDialog();
    expect(await screen.findByText(/do not have permission to delete/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete permanently/i })).toBeNull();
    expect(screen.getByRole('button', { name: /archive instead/i })).toBeInTheDocument();
  });

  it('shows the server’s reason in place of the button when the answer changes at the last moment', async () => {
    previewDeletion.mockResolvedValue(preview());
    deleteAssessment.mockResolvedValue({
      data: null, code: 'DELETION_REFUSED',
      error: 'A report was requested from this assessment while it was being deleted, so it has been kept. Archive it instead.',
      body: { archiveOffered: true },
    });
    const { onDeleted } = openDialog();
    fireEvent.click(await screen.findByRole('button', { name: /delete permanently/i }));

    expect(await screen.findByText(/while it was being deleted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete permanently/i })).toBeNull();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('asks the server afresh every time it opens — an answer is never reused', async () => {
    previewDeletion.mockResolvedValue(preview());
    const dialog = (open: boolean) => (
      <DeleteAssessmentDialog assessment={ASSESSMENT} open={open} onOpenChange={() => {}} onDeleted={() => {}} />
    );
    const view = render(dialog(true));
    await screen.findByRole('button', { name: /delete permanently/i });
    view.rerender(dialog(false));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    view.rerender(dialog(true));
    await screen.findByRole('button', { name: /delete permanently/i });
    expect(previewDeletion).toHaveBeenCalledTimes(2);
  });

  it('reports a check that could not be made, and lets it be retried', async () => {
    previewDeletion.mockResolvedValueOnce({ data: null, error: 'Assessment request failed' }).mockResolvedValueOnce(preview());
    openDialog();
    expect(await screen.findByText(/assessment request failed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('button', { name: /delete permanently/i })).toBeInTheDocument();
  });
});
