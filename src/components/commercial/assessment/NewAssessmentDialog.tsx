/**
 * "New assessment" — the one way an assessment begins.
 *
 * ## What it replaced
 *
 * The module had four ways to start the same record: the header's "New
 * assessment", ten "Start from a transaction type" buttons under the list, the
 * "Standalone calculators" workspace's "New analysis", and a property page's
 * "Send to Calculators". Each created a record on the click — "Untitled
 * assessment" or "Untitled analysis" — before a single question was asked, so
 * every click that went no further left a draft behind that could not be
 * deleted.
 *
 * This asks first, and creates nothing until the operator confirms:
 *
 *  - **a name** (or none — the record is then named after the building);
 *  - **the transaction type**, the choice the Type step asked straight away
 *    anyway, and the one that decides which income drives serviceability;
 *  - optionally **the building**, from the property register — its figures fill
 *    the assessment's blanks, and the register learns it has been assessed;
 *  - optionally **the client** it is for, from the existing client book. This is
 *    recorded as who the assessment is being prepared for, never as a link: the
 *    link is still made on the final step, after reconciliation, and the client
 *    is waiting there already selected.
 *
 * A client who is not in the book yet is created inside the workflow — on the
 * intake step or the final step — where the assessment can prefill them and
 * the duplicate checks run.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, Check, Factory, Loader2, Plus, User, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import type { ClientSearchRow } from '@/hooks/useCiAssessments';
import { createAssessment, searchClients } from '@/lib/ciAssessment/assessmentManagement';
import { clientLabel } from '@/lib/ciAssessment/clientRecords';
import { planNewAssessment, segmentFor, type Segment } from '@/lib/ciAssessment/newAssessment';
import type { RegisterDomain } from '@/lib/ciAssessment/registerProperty';
import {
  ASSESSMENT_TYPE_DEFINITIONS, assessmentTypeDefinition, type AssessmentType,
} from '@/lib/ciAssessment/types';
import { optionKey, useRegisterProperties } from './useRegisterProperties';

const NO_PROPERTY = 'none';

export interface NewAssessmentCreated {
  id: string;
  title: string;
  /** How many fields the register property filled. */
  filledFromProperty: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The building to start from — from a property page, a register row or an old link. */
  initialProperty?: { domain: RegisterDomain; propertyId: string } | null;
  onCreated: (created: NewAssessmentCreated) => void;
}

export function NewAssessmentDialog({ open, onOpenChange, initialProperty, onCreated }: Props) {
  // Held here, not in the form, because it is what stops the dialog closing
  // while the record is being created.
  const [creating, setCreating] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!creating) onOpenChange(next); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New assessment</DialogTitle>
          <DialogDescription>
            Name it and choose the transaction. Starting from a property in your register fills the
            property details for you. Nothing is created until you select Create.
          </DialogDescription>
        </DialogHeader>
        {/* The content mounts with each opening, so every opening starts from a
            fresh form — and from the building it was opened for. */}
        <NewAssessmentForm
          initialProperty={initialProperty ?? null}
          creating={creating}
          setCreating={setCreating}
          onCancel={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

interface FormProps {
  initialProperty: { domain: RegisterDomain; propertyId: string } | null;
  creating: boolean;
  setCreating: (creating: boolean) => void;
  onCancel: () => void;
  onCreated: (created: NewAssessmentCreated) => void;
}

function NewAssessmentForm({ initialProperty, creating, setCreating, onCancel, onCreated }: FormProps) {
  const { options, loading: loadingProperties, error: propertiesError, resolve } = useRegisterProperties(true);

  const [title, setTitle] = useState('');
  /** The operator's own choices; `null` until they make one. */
  const [typeChoice, setTypeChoice] = useState<AssessmentType | null>(null);
  const [segmentChoice, setSegmentChoice] = useState<Segment | null>(null);
  const [propertyChoice, setPropertyChoice] = useState<string | null>(null);
  const [client, setClient] = useState<ClientSearchRow | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [found, setFound] = useState<{ term: string; rows: ClientSearchRow[] } | null>(null);

  /**
   * The building the dialog was opened for, once its register has loaded. It
   * is the selection until the operator chooses another — derived rather than
   * copied in, so it can never be applied to the wrong opening or not at all.
   */
  const initialResolved = useMemo(() => (
    initialProperty && !loadingProperties ? resolve(initialProperty.domain, initialProperty.propertyId) : null
  ), [initialProperty, loadingProperties, resolve]);
  const propertyKey = propertyChoice ?? (initialResolved ? optionKey(initialResolved.option) : NO_PROPERTY);

  const selectedProperty = useMemo(() => {
    if (propertyKey === NO_PROPERTY) return null;
    const [domain, propertyId] = propertyKey.split(':') as [RegisterDomain, string];
    return resolve(domain, propertyId);
  }, [propertyKey, resolve]);

  const missingInitialProperty = Boolean(initialProperty) && !loadingProperties && !initialResolved && !selectedProperty;

  /**
   * An untouched type follows the building: an industrial building starts as
   * an industrial investment. Once the operator has chosen a type, the
   * building no longer moves it.
   */
  const type: AssessmentType = typeChoice
    ?? (selectedProperty?.option.industrial ? 'industrial_investment' : 'commercial_investment');

  // Client search: nothing until two characters, debounced, scoped by the server.
  const term = clientQuery.trim();
  const searchable = term.length >= 2;
  useEffect(() => {
    if (!searchable) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchClients(term).then((result) => {
        if (!cancelled) setFound({ term, rows: (result.data ?? []).slice(0, 6) });
      });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [term, searchable]);
  // Results are shown for the term they answer, and "Searching…" until then.
  const clientResults = searchable && found?.term === term ? found.rows : [];
  const searching = searchable && found?.term !== term;

  const definition = assessmentTypeDefinition(type);
  const segment = segmentFor(type, segmentChoice, selectedProperty?.option.industrial ?? null);

  const create = async () => {
    const plan = planNewAssessment({
      title,
      assessmentType: type,
      segmentChoice: definition.segment === 'either' ? segmentChoice : null,
      property: selectedProperty
        ? { prefill: selectedProperty.prefill, link: selectedProperty.link, industrial: selectedProperty.option.industrial }
        : null,
    });
    setCreating(true);
    const result = await createAssessment({
      title: plan.title,
      segment: plan.segment,
      assessmentType: plan.assessmentType,
      payload: plan.payload,
      intendedClientId: client?.id ?? null,
    });
    setCreating(false);
    if (result.error || !result.data) {
      toast({ title: 'Could not create the assessment', description: result.error ?? 'Try again.', variant: 'destructive' });
      return;
    }
    onCreated({ id: result.data.id, title: plan.title, filledFromProperty: plan.applied.length });
  };

  const commercialOptions = options.filter((option) => option.domain === 'commercial');
  const industrialOptions = options.filter((option) => option.domain === 'industrial');

  return (
    <>
      <div className="space-y-5">
        {/* ---- Name ------------------------------------------------------ */}
        <div className="space-y-1.5">
          <Label htmlFor="new-assessment-name" className="ci-field-label">Assessment name</Label>
          <Input
            id="new-assessment-name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={selectedProperty ? `${selectedProperty.option.label} — ${definition.label.toLowerCase()}` : 'e.g. 45 Industrial Drive — acquisition'}
            autoComplete="off"
            maxLength={300}
          />
          <p className="text-xs text-muted-foreground">
            Leave it blank to name it after the property. It can be renamed at any time.
          </p>
        </div>

        {/* ---- Transaction type -------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="new-assessment-type" className="ci-field-label">Transaction type</Label>
          <Select
            value={type}
            onValueChange={(value) => setTypeChoice(value as AssessmentType)}
          >
            <SelectTrigger id="new-assessment-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ASSESSMENT_TYPE_DEFINITIONS.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs leading-5 text-muted-foreground">{definition.description}</p>
          {definition.requiresSpecialistReview ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" /> Specialist review required
            </p>
          ) : null}
        </div>

        {definition.segment === 'either' ? (
          <fieldset className="space-y-1.5">
            <legend className="ci-field-label">Segment</legend>
            <div className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Segment">
              {(['commercial', 'industrial'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={segment === value}
                  onClick={() => setSegmentChoice(value)}
                  className={cn(
                    'flex items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs font-medium last:border-r-0',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    segment === value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted',
                  )}
                >
                  {value === 'industrial'
                    ? <Factory className="h-3.5 w-3.5" aria-hidden="true" />
                    : <Building2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  {value === 'industrial' ? 'Industrial' : 'Commercial'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              This transaction type fits either segment. It decides which list the assessment is filed under.
            </p>
          </fieldset>
        ) : null}

        {/* ---- Property -------------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="new-assessment-property" className="ci-field-label">Property (optional)</Label>
          <Select value={propertyKey} onValueChange={setPropertyChoice} disabled={loadingProperties}>
            <SelectTrigger id="new-assessment-property">
              <SelectValue placeholder={loadingProperties ? 'Loading your property register…' : 'Choose a property'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROPERTY}>No property — enter the details in the assessment</SelectItem>
              {commercialOptions.length ? (
                <SelectGroup>
                  <SelectLabel>Commercial register</SelectLabel>
                  {commercialOptions.map((option) => (
                    <SelectItem key={optionKey(option)} value={optionKey(option)}>
                      {option.label}{option.detail ? ` — ${option.detail}` : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {industrialOptions.length ? (
                <SelectGroup>
                  <SelectLabel>Industrial register</SelectLabel>
                  {industrialOptions.map((option) => (
                    <SelectItem key={optionKey(option)} value={optionKey(option)}>
                      {option.label}{option.detail ? ` — ${option.detail}` : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {selectedProperty
              ? 'Its address, value, areas and outgoings fill the assessment where it has no figure of its own, and the property’s page will list this assessment.'
              : !loadingProperties && !options.length
                ? 'Your property register is empty. Add buildings on the Property register tab to start assessments from them.'
                : 'Choose a building from your register to fill its details for you.'}
          </p>
          {propertiesError ? (
            <p className="text-xs text-destructive">The property register could not be read in full: {propertiesError}</p>
          ) : null}
          {missingInitialProperty ? (
            <p className="text-xs text-warning">
              That property is no longer in your register, so the assessment will start without it.
            </p>
          ) : null}
        </div>

        {/* ---- Client ---------------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="new-assessment-client" className="ci-field-label">Client (optional)</Label>
          {client ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <User className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate font-medium text-foreground">{clientLabel(client)}</span>
                {client.primary_email ? <span className="truncate text-xs text-muted-foreground">{client.primary_email}</span> : null}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setClient(null)} aria-label={`Remove ${clientLabel(client)}`}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <>
              <SearchInput
                id="new-assessment-client"
                value={clientQuery}
                onValueChange={setClientQuery}
                placeholder="Search your clients by name, email or mobile"
                aria-label="Search your clients"
              />
              {searching ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Searching…
                </p>
              ) : clientQuery.trim().length >= 2 && !clientResults.length ? (
                <p className="text-xs text-muted-foreground">
                  No client matches “{clientQuery.trim()}”. A new client is created inside the assessment, where
                  it can prefill them — on the intake step or when you link.
                </p>
              ) : clientResults.length ? (
                <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Matching clients">
                  {clientResults.map((row) => (
                    <li key={row.id}>
                      <button type="button" className="ci-client-option" onClick={() => { setClient(row); setClientQuery(''); }}>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground">{clientLabel(row)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.primary_email || row.primary_mobile || 'No contact details recorded'}
                          </span>
                        </span>
                        <Check className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Who this assessment is for. They are linked on the final step, once the assessment is complete,
                  and are selected there already.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={creating}>Cancel</Button>
        {/* Waits for the register only when it was opened FOR a building —
            creating before that building resolves would start without it. */}
        <Button onClick={() => void create()} disabled={creating || (Boolean(initialProperty) && loadingProperties)}>
          {creating
            ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
            : <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />}
          {creating ? 'Creating…' : 'Create assessment'}
        </Button>
      </DialogFooter>
    </>
  );
}
