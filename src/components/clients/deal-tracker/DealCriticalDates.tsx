import { useState } from 'react';
import { format, differenceInDays, isPast } from 'date-fns';
import { CalendarIcon, AlertTriangle, Check, Undo2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Deal, DealType } from './types';

interface DealCriticalDatesProps {
  deal: Deal;
  onUpdate: (data: Partial<Deal>) => void;
}

interface DateFieldConfig {
  key: keyof Deal;
  label: string;
  showFor: DealType[] | 'all';
  isUrgent?: boolean;
}

const DATE_FIELDS: DateFieldConfig[] = [
  // Shared
  { key: 'finance_clause_expiry', label: 'Finance Clause Expiry', showFor: ['existing_property', 'house_and_land'], isUrgent: true },
  { key: 'settlement_date', label: 'Settlement Date', showFor: 'all', isUrgent: true },
  // H&L only
  { key: 'land_settlement_date', label: 'Land Settlement Date', showFor: ['house_and_land'] },
  { key: 'expected_build_start', label: 'Expected Build Start', showFor: ['house_and_land'] },
  { key: 'estimated_completion', label: 'Estimated Completion', showFor: ['house_and_land'] },
  // Refinance only
  { key: 'lodgement_date', label: 'Lodgement Date', showFor: ['refinance'] },
  { key: 'valuation_date', label: 'Valuation Date', showFor: ['refinance'] },
  { key: 'conditional_approval_date', label: 'Conditional Approval', showFor: ['refinance'], isUrgent: true },
  { key: 'discharge_authority_date', label: 'Discharge Authority Submitted', showFor: ['refinance'], isUrgent: true },
  { key: 'formal_approval_date', label: 'Formal Approval', showFor: ['refinance'] },
  { key: 'loan_docs_signed_date', label: 'Loan Documents Signed', showFor: ['refinance'] },
  { key: 'clawback_expiry_date', label: 'Clawback Expiry', showFor: ['refinance'], isUrgent: true },
];

/** Completion stamps keyed by the date column ({ settlement_date: ISO }). */
export type CriticalDateCompletions = Record<string, string>;

export function criticalDateCompletionsOf(deal: Pick<Deal, 'critical_date_completions'>): CriticalDateCompletions {
  const raw = deal.critical_date_completions;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CriticalDateCompletions) : {};
}

function DateWarningBadge({ dateStr, completedAt }: { dateStr: string; completedAt?: string }) {
  if (completedAt) {
    return (
      <Badge variant="outline" className="border-success/40 bg-success/10 text-[10px] text-success">
        <Check className="mr-0.5 h-3 w-3" />
        Done {format(new Date(completedAt), 'dd MMM')}
      </Badge>
    );
  }
  const date = new Date(dateStr);
  const daysAway = differenceInDays(date, new Date());

  if (isPast(date)) {
    return <Badge variant="destructive" className="text-[10px]">Overdue by {Math.abs(daysAway)}d</Badge>;
  }
  if (daysAway <= 5) {
    return <Badge className="text-[10px] bg-destructive">{daysAway}d away</Badge>;
  }
  if (daysAway <= 14) {
    return <Badge className="text-[10px] bg-brand-500">{daysAway}d away</Badge>;
  }
  return <Badge variant="outline" className="text-[10px]">{daysAway}d away</Badge>;
}

function DatePickerField({
  value,
  label,
  completedAt,
  onChange,
  onToggleComplete,
}: {
  value: string | null;
  label: string;
  completedAt?: string;
  onChange: (v: string | null) => void;
  onToggleComplete: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    // Stacked, not side-by-side: the label owns a full row, so the date
    // button + badge + Done cluster can never crush "Finance Clause Expiry"
    // into one letter per line inside a half-width card.
    <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/40 p-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-xs font-medium leading-4 text-muted-foreground" title={label}>
          {label}
        </span>
        {value && <span className="shrink-0"><DateWarningBadge dateStr={value} completedAt={completedAt} /></span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
              <CalendarIcon className="mr-1 h-3 w-3" />
              {value ? format(new Date(value), 'dd MMM yyyy') : 'Set'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={value ? new Date(value) : undefined}
              onSelect={(date) => {
                onChange(date ? format(date, 'yyyy-MM-dd') : null);
                setOpen(false);
              }}
              className="p-3 pointer-events-auto"
            />
          </PopoverContent>
        </Popover>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5 text-[10px] text-muted-foreground hover:text-success"
            onClick={onToggleComplete}
            title={completedAt ? `Reopen ${label}` : `Mark ${label} as complete`}
            aria-label={completedAt ? `Reopen ${label}` : `Mark ${label} as complete`}
            aria-pressed={!!completedAt}
          >
            {completedAt ? <Undo2 className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            <span className="ml-0.5">{completedAt ? 'Reopen' : 'Done'}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

export function DealCriticalDates({ deal, onUpdate }: DealCriticalDatesProps) {
  const completions = criticalDateCompletionsOf(deal);

  const visibleFields = DATE_FIELDS.filter(f => {
    if (f.showFor === 'all') return true;
    return f.showFor.includes(deal.deal_type);
  });

  // A completed date is a finished obligation, not an urgent one — the whole
  // reason completion exists is that a passed date otherwise reads Overdue
  // forever, here and on the pipeline's executive summary.
  const urgentDates = visibleFields.filter(f => {
    const val = deal[f.key] as string | null;
    if (!val || !f.isUrgent || completions[f.key as string]) return false;
    const daysAway = differenceInDays(new Date(val), new Date());
    return daysAway <= 7;
  });

  const toggleComplete = (key: string) => {
    const next: CriticalDateCompletions = { ...completions };
    if (next[key]) {
      delete next[key];
    } else {
      next[key] = new Date().toISOString().slice(0, 10);
    }
    onUpdate({ critical_date_completions: next } as Partial<Deal>);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-primary" />
          Critical Dates
          {urgentDates.length > 0 && (
            <Badge variant="destructive" className="text-[10px] ml-auto">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {urgentDates.length} urgent
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {visibleFields.map((field) => {
            const value = deal[field.key] as string | null;
            return (
              <DatePickerField
                key={field.key}
                value={value}
                label={field.label}
                completedAt={completions[field.key as string]}
                onChange={(d) => onUpdate({ [field.key]: d } as Partial<Deal>)}
                onToggleComplete={() => toggleComplete(field.key as string)}
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
