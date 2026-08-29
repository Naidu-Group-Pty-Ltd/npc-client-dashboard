import { useState, useEffect, useMemo, useCallback, useRef } from 'react'; // Enhanced PDF export
import * as XLSX from 'xlsx';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { logActivityDirect } from '@/hooks/useActivityLogger';
import { useReportTemplateSelection } from '@/hooks/useReportTemplateSelection';
import { fetchGlobalReportSettings } from '@/hooks/useGlobalReportSettings';
import { drawJsPDFDisclaimerPage } from '@/utils/pdfDisclaimerPage';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-mobile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useCapability } from '@/hooks/useCapability';
import { supabase } from '@/integrations/supabase/client';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import { requestCashFlowPdf } from '@/lib/reports/cashFlow/requestCashFlowPdf';
import { readBaseFinancials } from '@/lib/reports/cashFlow/readBaseFinancials';
import { toWireComparison, type WireComparison } from '@/lib/reports/cashFlowComparison/toWireComparison';
import { CashFlowComparisonDownloadButton } from '@/components/cash-flow/modal/CashFlowComparisonDownloadButton';
import { toWireProjection } from '@/lib/reports/cashFlow/toWireProjection';
import { matchStoredScenario } from '@/lib/reports/cashFlow/storedSeriesMatch';
import {
  saveTemplateDocument,
  tryTemplateDocument,
} from '@/lib/reportTemplate/templateDocument';
import { SendToClientModal } from '@/components/reports/SendToClientModal';
import { ArrowLeft, Calculator, Download, TrendingUp, DollarSign, Percent, Home, Save, RotateCcw, BarChart3, Image, GitCompare, X, FileText, Target, Zap, Building, Award, Printer, ChevronDown, ChevronRight, Send, Search, Check } from 'lucide-react';
import { ComposedChart, LineChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { FlattenPdfIconButton } from '@/components/common/FlattenPdfIconButton';
import { CashFlowCommandHeader } from '@/components/cash-flow/modal/CashFlowCommandHeader';
import { CashFlowControlPanel } from '@/components/cash-flow/modal/CashFlowControlPanel';
import { CashFlowExportMenu } from '@/components/cash-flow/modal/CashFlowExportMenu';
import { CashFlowKpiStrip } from '@/components/cash-flow/modal/CashFlowKpiStrip';
import { CashFlowPresentationShell } from '@/components/cash-flow/modal/CashFlowPresentationShell';
import type { CashFlowPresentation } from '@/components/cash-flow/modal/types';
import { CashFlowChartsWorkspace } from '@/components/cash-flow/modal/CashFlowChartsWorkspace';
import { CashFlowAiPanel } from '@/components/cash-flow/modal/CashFlowAiPanel';
import { CashFlowConstructionPanel } from '@/components/cash-flow/modal/CashFlowConstructionPanel';
import { CashFlowProjectionTable } from '@/components/cash-flow/modal/CashFlowProjectionTable';
import {
  get10YearLoanProjection,
  type MortgageInput,
  type RateChange,
  type RepaymentFrequency,
  type LoanType
} from '@/utils/mortgageCalculations';
import {
  parseFinancialInput,
  resolveYearDepreciation,
  hydrateYearlyOverrides,
} from '@/utils/cashFlowDepreciation';

interface InvestmentReport {
  id: string;
  property_address: string;
  financial_calculations?: any;
  manual_overrides?: any;
}

interface CashFlowAnalysisModalProps {
  report: InvestmentReport | null;
  isOpen: boolean;
  onClose: () => void;
  onReportUpdated?: () => void;
  /**
   * Chrome this workspace is drawn inside. `modal` (the default) keeps the
   * original dialog for surfaces that open it over themselves; `page` renders
   * it as the routed drill-down reached from the Cash Flow Analysis list,
   * where `onClose` is the route back rather than a dismissal.
   */
  presentation?: CashFlowPresentation;
  /** Label for the return control shown in page presentation. */
  backLabel?: string;
}

interface YearlyProjection {
  year: number;
  capitalGrowthRate: number;
  cpiGrowthRate: number;
  propertyMarketValue: number;
  loanAmount: number;
  equityInProperty: number;
  loanToValueRatio: number;
  rentalIncome: number;
  grossYield: number;
  netYield: number;
  propertyExpenses: number;
  interestRate: number;
  interestPayments: number;
  principalPayments: number;
  preTaxCashFlowPA: number;
  preTaxCashFlowPW: number;
  depreciation: number;
  totalDeductions: number;
  netProfitLoss: number;
  taxRefund: number;
  landTax: number;
  afterTaxCashFlowPA: number;
  afterTaxCashFlowPW: number;
}

// Per-year override fields
interface YearOverrides {
  capitalGrowthRate?: number | null;
  cpiGrowthRate?: number | null;
  propertyMarketValue?: number | null;
  rentalIncome?: number | null;
  propertyExpenses?: number | null;
  interestRate?: number | null;
  interestPayment?: number | null;
  principalPayment?: number | null;
  depreciation?: number | null;
  landTax?: number | null;
}

// All year overrides (years 1-10)
type YearlyOverrides = {
  [year: number]: YearOverrides;
};

// Editable field configuration
// Phase 0 UI/UX non-regression lock: presentational refactors must not alter
// projection, override persistence, export, comparison, AI, send-to-client,
// chart-ref/data, print, or construction-schedule behavior. The imported
// rule list keeps those constraints discoverable for future modal component
// extraction while preserving all runtime logic below.


const EDITABLE_FIELDS = [
  { key: 'capitalGrowthRate', label: 'Capital Growth %', type: 'percent', step: 0.1 },
  { key: 'cpiGrowthRate', label: 'CPI Growth %', type: 'percent', step: 0.1 },
  { key: 'propertyMarketValue', label: 'Property Value $', type: 'currency', step: 1000 },
  { key: 'rentalIncome', label: 'Rental Income $', type: 'currency', step: 100 },
  { key: 'propertyExpenses', label: 'Property Expenses $', type: 'currency', step: 100 },
  { key: 'interestRate', label: 'Interest Rate %', type: 'percent', step: 0.1 },
  { key: 'interestPayment', label: 'Interest Payments $', type: 'currency', step: 100 },
  { key: 'principalPayment', label: 'Principal Payments $', type: 'currency', step: 100 },
  { key: 'depreciation', label: 'Depreciation $', type: 'currency', step: 100 },
  { key: 'landTax', label: 'Land Tax $', type: 'currency', step: 100 },
] as const;

type EditableFieldKey = typeof EDITABLE_FIELDS[number]['key'];

// Template configuration interface for Cash Flow PDF export
interface CashFlowTemplateConfig {
  id: string;
  name: string;
  companyName: string;
  companyNameLine2: string;
  tagline: string;
  contactPhone: string;
  contactEmail: string;
  website: string;
  disclaimer: string;
}

// Default Brand configuration for Cash Flow exports
const defaultCashFlowConfig: CashFlowTemplateConfig = {
  id: 'default',
  name: 'Default Template',
  companyName: 'PROPERTY',
  companyNameLine2: 'CONSULTING',
  tagline: 'YOUR DEDICATED PROPERTY PARTNER',
  contactPhone: '',
  contactEmail: '',
  website: '',
  disclaimer: 'This analysis is for informational purposes only and does not constitute financial advice. Projections are estimates based on assumed growth rates.',
};

// Function to load active Cash Flow export template
const loadActiveCashFlowTemplate = async (): Promise<CashFlowTemplateConfig> => {
  try {
    // Fetch active cashflow_export template
    const { data: template, error } = await supabase
      .from('report_structure_templates')
      .select('*')
      .eq('template_type', 'cashflow_export' as any)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.warn('Error fetching Cash Flow template:', error);
      return defaultCashFlowConfig;
    }

    if (!template) {
      console.log('No active Cash Flow template found, using default');
      return defaultCashFlowConfig;
    }

    // Parse metadata for custom configuration if available
    const metadata = template.metadata as Record<string, any> | null;
    
    if (metadata?.branding) {
      const branding = metadata.branding;
      return {
        id: template.id,
        name: template.name,
        companyName: branding.companyName || defaultCashFlowConfig.companyName,
        companyNameLine2: branding.companyNameLine2 || defaultCashFlowConfig.companyNameLine2,
        tagline: branding.tagline || defaultCashFlowConfig.tagline,
        contactPhone: branding.contactPhone || defaultCashFlowConfig.contactPhone,
        contactEmail: branding.contactEmail || defaultCashFlowConfig.contactEmail,
        website: branding.website || defaultCashFlowConfig.website,
        disclaimer: branding.disclaimer || defaultCashFlowConfig.disclaimer,
      };
    }

    // Template exists but no custom branding - use default with template name
    console.log(`Using template "${template.name}" with default styling`);
    return {
      ...defaultCashFlowConfig,
      id: template.id,
      name: template.name,
    };
  } catch (err) {
    console.error('Failed to load Cash Flow template:', err);
    return defaultCashFlowConfig;
  }
};

export function CashFlowAnalysisModal({ report, isOpen, onClose, onReportUpdated, presentation = 'modal', backLabel = 'Back to Cash Flow Analysis' }: CashFlowAnalysisModalProps) {
  const isPagePresentation = presentation === 'page';
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [isSaving, setIsSaving] = useState(false);
  /** The typeset PDF is a round trip to a render service; the menu says so. */
  const [isExportingServerPdf, setIsExportingServerPdf] = useState(false);
  /**
   * Whether this person has chosen a template for the 10 Year Cash Flow.
   *
   * Read only so the export can *explain itself*. This format is the one whose
   * template cannot always be used — the projection below is recomputed in the
   * browser from the adviser's overrides, and a template renders the stored
   * series — so somebody who chose one and received the standard layout is owed
   * the reason rather than left to think the choice did nothing. The query is
   * the picker's own and is already cached, so this costs no extra request.
   */
  const cashFlowTemplateChoice = useReportTemplateSelection('cashflow');
  const [hasChanges, setHasChanges] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [editingCell, setEditingCell] = useState<{ year: number; field: EditableFieldKey } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  
  // Chart metric visibility toggles
  const [chartMetrics, setChartMetrics] = useState({
    propertyValue: true,
    equity: true,
    rentalIncome: true,
    cashFlow: true,
    loanBalance: true,
  });
  
  // Per-year overrides state (years 2-10)
  const [yearlyOverrides, setYearlyOverrides] = useState<YearlyOverrides>({});

  // Chart refs for PNG export
  const cashFlowChartRef = useRef<HTMLDivElement>(null);
  const yieldChartRef = useRef<HTMLDivElement>(null);
  const comparisonChartRef = useRef<HTMLDivElement>(null);

  // Cash-Flow Comparisons are commercialised independently of the standard
  // 10-year analysis (Growth+ or the add-on). Without the capability the
  // toggle is removed, comparison mode cannot activate, and neither
  // comparison query effect runs (both are comparisonMode-gated).
  const cashflowComparisonsEnabled = useCapability('cashflow.comparisons').enabled;

  // Comparison mode state - support up to 5 properties (1 primary + 4 comparison)
  const [comparisonMode, setComparisonModeRaw] = useState(false);
  const setComparisonMode = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setComparisonModeRaw((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        return cashflowComparisonsEnabled ? value : false;
      });
    },
    [cashflowComparisonsEnabled],
  );
  useEffect(() => {
    if (!cashflowComparisonsEnabled) setComparisonModeRaw(false);
  }, [cashflowComparisonsEnabled]);
  const [availableReports, setAvailableReports] = useState<InvestmentReport[]>([]);
  const [selectedComparisonReportIds, setSelectedComparisonReportIds] = useState<string[]>([]);
  const [comparisonReports, setComparisonReports] = useState<InvestmentReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [investorProfile, setInvestorProfile] = useState<'growth' | 'income' | 'balanced'>('balanced');
  
  // AI-powered comparison analysis state
  const [aiAnalysis, setAiAnalysis] = useState<any>(null);
  const [isGeneratingAiAnalysis, setIsGeneratingAiAnalysis] = useState(false);
  const [savedAnalysisId, setSavedAnalysisId] = useState<string | null>(null);
  const [isSavingAnalysis, setIsSavingAnalysis] = useState(false);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);

  // Inputs Summary state
  const [inputsSummaryOpen, setInputsSummaryOpen] = useState(true);
  const [includeInputsSummaryInExport, setIncludeInputsSummaryInExport] = useState(true);
  
  // Land tax exclusion toggle
  const [excludeLandTaxFromCashFlow, setExcludeLandTaxFromCashFlow] = useState(false);

  // Send to Client state
  const [sendToClientOpen, setSendToClientOpen] = useState(false);
  const [cashFlowStoragePath, setCashFlowStoragePath] = useState<string | null>(null);

  // Construction Progress Schedule state
  const [constructionScheduleOpen, setConstructionScheduleOpen] = useState(false);
  const [includeConstructionScheduleInExport, setIncludeConstructionScheduleInExport] = useState(true);
  
  // Chart insight visibility toggles
  const [showCashFlowInsight, setShowCashFlowInsight] = useState(false);
  const [showYieldInsight, setShowYieldInsight] = useState(false);

  // Chart export toggles - individual and global
  const [includeAllChartsInExport, setIncludeAllChartsInExport] = useState(true);
  const [chartExportToggles, setChartExportToggles] = useState({
    cashFlowTrends: true,
    yieldChart: true,
    comparisonChart: true,
  });
  
  // Handler for global charts toggle
  const handleGlobalChartsToggle = (checked: boolean) => {
    setIncludeAllChartsInExport(checked);
    setChartExportToggles({
      cashFlowTrends: checked,
      yieldChart: checked,
      comparisonChart: checked,
    });
  };
  
  // Handler for individual chart toggle
  const handleChartToggle = (chartKey: keyof typeof chartExportToggles, checked: boolean) => {
    const newToggles = { ...chartExportToggles, [chartKey]: checked };
    setChartExportToggles(newToggles);
    // Update global toggle based on individual states
    const allChecked = Object.values(newToggles).every(v => v);
    const noneChecked = Object.values(newToggles).every(v => !v);
    if (allChecked) {
      setIncludeAllChartsInExport(true);
    } else if (noneChecked) {
      setIncludeAllChartsInExport(false);
    }
  };
  
  // Construction Schedule Preset Mode: 'rapid' | 'even' | 'custom'
  type SchedulePreset = 'rapid' | 'even' | 'custom';
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('rapid');
  
  // Custom stage month positions (for 'custom' mode) - stage index (0-5) to month number
  // Default: month 2-7 for stages 1-6
  const [customStageMonths, setCustomStageMonths] = useState<{ [stageIndex: number]: number }>({
    0: 2, // Deposit
    1: 3, // Slab/Base
    2: 4, // Frame
    3: 5, // Lock-up
    4: 6, // Fixing
    5: 7, // Practical Completion
  });

  // Get build type from report (defaults to 'existing_property')
  const buildType = report?.manual_overrides?.buildType || 'existing_property';
  const isNewBuild = buildType === 'new_build';

  // Comparison chart colors for up to 5 properties
  const COMPARISON_COLORS = [
    { value: 'hsl(var(--primary))', cashFlow: '#8b5cf6' }, // Primary
    { value: '#f97316', cashFlow: '#14b8a6' }, // Comparison 1
    { value: '#ef4444', cashFlow: '#06b6d4' }, // Comparison 2
    { value: '#eab308', cashFlow: '#84cc16' }, // Comparison 3
    { value: '#a855f7', cashFlow: '#f43f5e' }, // Comparison 4
  ];

  // Initialize overrides from report when modal opens
  useEffect(() => {
    if (report && isOpen) {
      const cfOverrides = report.manual_overrides?.cashFlowYearlyOverrides || {};

      // Hydrate the editable per-year overrides from the persisted record.
      //
      // Saved manual overrides (including manual depreciation edits) are
      // authoritative. We intentionally DO NOT seed the generated
      // `depreciationSchedule` into the override map here: doing so was the
      // root cause of manual depreciation edits reverting after Save/refetch,
      // because the generated figure overwrote the saved value on every open.
      // Years the user has never edited carry no depreciation override and fall
      // back to the generated schedule in the projection calculation below, so
      // schedule changes still flow through for non-edited years.
      const hydratedOverrides = hydrateYearlyOverrides<YearOverrides>(
        cfOverrides as YearlyOverrides,
      );

      setYearlyOverrides(hydratedOverrides);
      setHasChanges(false);
      setEditingCell(null);
      setComparisonMode(false);
      setSelectedComparisonReportIds([]);
      setComparisonReports([]);
      setAiAnalysis(null);
      setSavedAnalysisId(null);
      
      // Load construction stage timing preset from manual_overrides
      setSchedulePreset(report.manual_overrides?.schedulePreset || 'rapid');
      setCustomStageMonths(report.manual_overrides?.customStageMonths || {
        0: 2, 1: 3, 2: 4, 3: 5, 4: 6, 5: 7
      });
      
      // Load land tax exclusion setting
      setExcludeLandTaxFromCashFlow(report.manual_overrides?.excludeLandTaxFromCashFlow || false);
    }
  }, [report, isOpen]);

  // Load saved AI analysis when comparison reports are selected
  useEffect(() => {
    if (comparisonMode && report && selectedComparisonReportIds.length > 0) {
      const loadSavedAnalysis = async () => {
        setIsLoadingAnalysis(true);
        try {
          const sortedComparisonIds = [...selectedComparisonReportIds].sort();
          
          const { data, error } = await supabase
            .from('cash_flow_analyses')
            .select('*')
            .eq('primary_report_id', report.id)
            .contains('comparison_report_ids', sortedComparisonIds)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (error) throw error;
          
          if (data && data.comparison_report_ids.length === sortedComparisonIds.length) {
            setAiAnalysis(data.analysis_data);
            setSavedAnalysisId(data.id);
            setInvestorProfile((data.investor_profile as 'growth' | 'income' | 'balanced') || 'balanced');
            toast({
              title: "Analysis Loaded",
              description: "Previously saved analysis has been loaded.",
            });
          } else {
            setAiAnalysis(null);
            setSavedAnalysisId(null);
          }
        } catch (error) {
          console.error('Error loading saved analysis:', error);
        } finally {
          setIsLoadingAnalysis(false);
        }
      };
      loadSavedAnalysis();
    }
  }, [comparisonMode, report, selectedComparisonReportIds, toast]);

  // Fetch available reports for comparison when comparison mode is enabled
  useEffect(() => {
    if (comparisonMode && isOpen && report) {
      const fetchReports = async () => {
        setLoadingReports(true);
        try {
          const { data, error } = await invokeSecureFunction('get-investment-reports', {
            listMode: true,
            listOptions: {
              select: 'id, property_address, financial_calculations, manual_overrides',
              status: 'completed',
              orderBy: 'created_at',
              orderAsc: false
            }
          });

          if (error) throw new Error(error.message);
          // Filter out the current report
          const allReports = (data?.reports || []) as InvestmentReport[];
          setAvailableReports(allReports.filter(r => r.id !== report.id));
        } catch (error) {
          console.error('Error fetching reports for comparison:', error);
          toast({
            title: "Failed to load reports",
            description: "Could not fetch available reports for comparison. Please try again.",
            variant: "destructive",
          });
        } finally {
          setLoadingReports(false);
        }
      };
      fetchReports();
    }
  }, [comparisonMode, isOpen, report, toast]);

  // Fetch selected comparison reports details
  useEffect(() => {
    const selectedReports = availableReports.filter(r => selectedComparisonReportIds.includes(r.id));
    setComparisonReports(selectedReports);
  }, [selectedComparisonReportIds, availableReports]);

  // Handle adding/removing comparison reports
  const handleToggleComparisonReport = useCallback((reportId: string) => {
    setSelectedComparisonReportIds(prev => {
      if (prev.includes(reportId)) {
        return prev.filter(id => id !== reportId);
      }
      if (prev.length >= 4) {
        toast({
          title: "Maximum reached",
          description: "You can compare up to 5 properties total (including the primary).",
          variant: "destructive"
        });
        return prev;
      }
      return [...prev, reportId];
    });
  }, [toast]);

  const exportChartAsPNG = useCallback(async (chartRef: React.RefObject<HTMLDivElement>, filename: string) => {
    if (!chartRef.current) return;
    
    try {
      const canvas = await html2canvas(chartRef.current, {
        backgroundColor: '#ffffff',
        scale: 2,
      });
      
      const link = document.createElement('a');
      link.download = `${filename}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      toast({
        title: "Chart Exported",
        description: `${filename}.png has been downloaded.`,
      });
    } catch (error) {
      console.error('Error exporting chart:', error);
      toast({
        title: "Export Failed",
        description: "Failed to export chart as PNG.",
        variant: "destructive"
      });
    }
  }, [toast]);

  // Calculate projections for all comparison reports (using same chained cascade logic)
  const allComparisonProjections = useMemo(() => {
    return comparisonReports.map(compReport => {
      const fc = compReport.financial_calculations || {};
      const mo = compReport.manual_overrides || {};
      const cashFlow = fc.cashFlow || {};
      const assumptions = fc.assumptions || {};
      const initialCosts = fc.initialCosts || {};
      // Merge depreciationSchedule into cfOverrides for comparison reports.
      // Schedule values are authoritative here as well.
      let cfOverrides = { ...(mo.cashFlowYearlyOverrides || {}) };
      const compDepSchedule = mo.depreciationSchedule as Record<string | number, number> | undefined;
      if (compDepSchedule) {
        for (let y = 1; y <= 10; y++) {
          const sv = compDepSchedule[y] ?? compDepSchedule[String(y)];
          if (sv != null) {
            if (!cfOverrides[y]) cfOverrides[y] = {};
            cfOverrides[y] = { ...cfOverrides[y], depreciation: sv };
          }
        }
      }
      const includeDepreciation = mo.includeDepreciationInCashFlow !== false;

      // CRITICAL: Use same fallback paths as baseFinancialData
      const purchasePrice = mo.purchasePrice ?? initialCosts.propertyValue ?? fc.purchasePrice ?? fc.propertyValue ?? 0;
      const loanAmount = mo.loanAmount ?? cashFlow.loanAmount ?? (purchasePrice * ((mo.loanToValueRatio ?? fc.loanToValueRatio ?? 80) / 100));
      const weeklyRent = mo.weeklyRent ?? fc.weeklyRent ?? 0;
      const occupancyRate = mo.occupancyRate ?? cashFlow.occupancyRate ?? 52;
      // CRITICAL: capitalGrowth may be in assumptions.capitalGrowth (nested) or fc.capitalGrowth (root)
      const baseCapitalGrowthRate = (mo.capitalGrowth ?? assumptions.capitalGrowth ?? fc.capitalGrowth ?? 5) / 100;
      const baseInterestRate = (mo.interestRate ?? fc.interestRate ?? 5.5) / 100;
      // CPI Growth: independent macro indicator, NOT derived from capital growth. Fallback to 2.5% (RBA target midpoint)
      const baseCpiRate = (mo.cpiGrowthRate ?? cashFlow.cpiGrowthRate ?? 2.5) / 100;
      const taxRate = (mo.taxRate ?? cashFlow.taxRate ?? 30) / 100;
      const baseDepreciation = includeDepreciation ? (mo.depreciation ?? cashFlow.depreciation ?? 6000) : 0;
      const depreciationSchedule = mo.depreciationSchedule as Record<number, number> | undefined;
      const baseLandTax = mo.landTax ?? fc.landTax ?? 0;
      const marketValueNow = mo.marketValueNow ?? cashFlow.marketValueNow ?? purchasePrice;

      // Fixed expenses (excluding management fee)
      const baseFixedExpenses = 
        (mo.councilRates ?? fc.councilRates ?? 0) +
        (mo.waterRates ?? fc.waterRates ?? 0) +
        (mo.bodyCorporateFees ?? fc.bodyCorporateFees ?? 0) +
        (mo.buildingLandlordInsurance ?? fc.buildingLandlordInsurance ?? 0) +
        (mo.repairsMaintenance ?? fc.repairsMaintenance ?? 0);
      const propertyManagementPercent = (mo.propertyManagementFees ?? fc.propertyManagementFees ?? 7) / 100;
      const baseAnnualRent = weeklyRent * occupancyRate;

      const results: YearlyProjection[] = [];
      
      // Track previous year values for CHAINED cascade
      let previousPropertyValue = marketValueNow;
      let previousRentalIncome = baseAnnualRent;
      let previousFixedExpenses = baseFixedExpenses;

      for (let year = 0; year <= 10; year++) {
        const yearOverrides = cfOverrides[year] || {};
        
        const yearCapitalGrowthRate = year >= 1 && yearOverrides.capitalGrowthRate != null
          ? yearOverrides.capitalGrowthRate / 100 : baseCapitalGrowthRate;
        const yearCpiRate = year >= 1 && yearOverrides.cpiGrowthRate != null
          ? yearOverrides.cpiGrowthRate / 100 : baseCpiRate;
        const yearInterestRate = year >= 1 && yearOverrides.interestRate != null
          ? yearOverrides.interestRate / 100 : baseInterestRate;

        // Property value - CHAINED cascade
        let propertyValue: number;
        if (year === 0) {
          propertyValue = marketValueNow;
        } else if (yearOverrides.propertyMarketValue != null) {
          propertyValue = yearOverrides.propertyMarketValue;
        } else {
          // CHAINED: Grow from previous year's actual value
          propertyValue = previousPropertyValue * (1 + yearCapitalGrowthRate);
        }
        previousPropertyValue = propertyValue;

        const currentLoanAmount = loanAmount;
        const equity = propertyValue - currentLoanAmount;
        const lvr = propertyValue > 0 ? (currentLoanAmount / propertyValue) * 100 : 0;

        // Rental income - CHAINED cascade
        let annualRent: number;
        if (year === 0) {
          annualRent = baseAnnualRent;
        } else if (yearOverrides.rentalIncome != null) {
          annualRent = yearOverrides.rentalIncome;
        } else {
          // CHAINED: Grow from previous year's actual rent using current year's CPI
          annualRent = previousRentalIncome * (1 + yearCpiRate);
        }
        previousRentalIncome = annualRent;

        // Property expenses - HYBRID: Fixed portion chains, mgmt fee is dynamic
        let totalExpenses: number;
        let currentFixedExpenses: number;
        if (year === 0) {
          currentFixedExpenses = baseFixedExpenses;
          totalExpenses = currentFixedExpenses + (annualRent * propertyManagementPercent);
        } else if (yearOverrides.propertyExpenses != null) {
          totalExpenses = yearOverrides.propertyExpenses;
          currentFixedExpenses = totalExpenses - (annualRent * propertyManagementPercent);
        } else {
          // CHAINED: Fixed expenses grow from previous year using current year's CPI
          currentFixedExpenses = previousFixedExpenses * (1 + yearCpiRate);
          totalExpenses = currentFixedExpenses + (annualRent * propertyManagementPercent);
        }
        previousFixedExpenses = currentFixedExpenses;

        // Interest & Principal (simplified for comparison - no amortization engine)
        let interestPayments = year === 0 ? 0 : 
          yearOverrides.interestPayment != null ? yearOverrides.interestPayment : 
          currentLoanAmount * yearInterestRate;
        let principalPayments = year === 0 ? 0 : yearOverrides.principalPayment ?? 0;
        
        // Depreciation - LOCKED (schedule-based or direct)
        let depreciation: number;
        if (year === 0) {
          depreciation = 0;
        } else if (yearOverrides.depreciation != null) {
          depreciation = yearOverrides.depreciation;
        } else if (depreciationSchedule && depreciationSchedule[year] != null) {
          depreciation = depreciationSchedule[year];
        } else {
          depreciation = baseDepreciation;
        }
        
        // Land tax - LOCKED
        let landTax = year === 0 ? 0 : yearOverrides.landTax ?? baseLandTax;

        const grossYield = year === 0 ? 0 : (annualRent / propertyValue) * 100;
        const netYield = year === 0 ? 0 : ((annualRent - totalExpenses) / propertyValue) * 100;
        const preTaxCashFlow = year === 0 ? 0 : annualRent - totalExpenses - interestPayments - principalPayments - landTax;
        const totalDeductions = totalExpenses + interestPayments + depreciation + landTax;
        const netProfitLoss = year === 0 ? 0 : annualRent - totalDeductions;
        const taxRefund = year === 0 ? 0 : (netProfitLoss < 0 ? Math.abs(netProfitLoss) * taxRate : 0);
        const afterTaxCashFlow = year === 0 ? 0 : preTaxCashFlow + taxRefund;

        results.push({
          year,
          capitalGrowthRate: year === 0 ? 0 : yearCapitalGrowthRate * 100,
          cpiGrowthRate: year === 0 ? 0 : yearCpiRate * 100,
          propertyMarketValue: Math.round(propertyValue),
          loanAmount: Math.round(currentLoanAmount),
          equityInProperty: Math.round(equity),
          loanToValueRatio: Math.round(lvr * 100) / 100,
          rentalIncome: Math.round(annualRent),
          grossYield: Math.round(grossYield * 100) / 100,
          netYield: Math.round(netYield * 100) / 100,
          propertyExpenses: Math.round(totalExpenses),
          interestRate: year === 0 ? 0 : yearInterestRate * 100,
          interestPayments: Math.round(interestPayments),
          principalPayments: Math.round(principalPayments),
          preTaxCashFlowPA: Math.round(preTaxCashFlow),
          preTaxCashFlowPW: Math.round(preTaxCashFlow / 52),
          depreciation: Math.round(depreciation),
          totalDeductions: Math.round(totalDeductions),
          netProfitLoss: Math.round(netProfitLoss),
          taxRefund: Math.round(taxRefund),
          landTax: Math.round(landTax),
          afterTaxCashFlowPA: Math.round(afterTaxCashFlow),
          afterTaxCashFlowPW: Math.round(afterTaxCashFlow / 52),
        });
      }
      return { report: compReport, projections: results };
    });
  }, [comparisonReports]);

  // Extract base financial data from report
  /**
   * The cascade that reads this position now lives in `readBaseFinancials`, and
   * this is a call to it rather than a copy of it.
   *
   * Moved so that the properties in a comparison can be read by the same code as
   * the one this modal has open. They were not: `compBaseData` below reads a
   * shorter, differently-ordered set of the same fields, which is how the
   * primary's return-on-capital came to be divided by a cost base including LMI
   * while every property it was ranked against had theirs divided by one without.
   *
   * The body is unchanged. The only difference is that the current year is
   * passed in.
   */
  const baseFinancialData = useMemo(
    () => (report ? readBaseFinancials(report, new Date().getFullYear()) : null),
    [report],
  );

  // Generate 10-year loan projection using amortisation engine
  const loanProjections = useMemo(() => {
    if (!baseFinancialData) return null;
    
    const loanAmount = baseFinancialData.loanAmount || 
      (baseFinancialData.purchasePrice * (baseFinancialData.loanToValueRatio / 100));
    
    if (loanAmount <= 0) return null;
    
    // Convert monthly extra repayment to the appropriate frequency
    const periodsPerYear = baseFinancialData.repaymentFrequency === 'weekly' ? 52 : 
                           baseFinancialData.repaymentFrequency === 'fortnightly' ? 26 : 12;
    const extraPerPeriod = baseFinancialData.extraRepaymentPerMonth * 12 / periodsPerYear;
    
    const mortgageInput: MortgageInput = {
      loanAmount,
      annualInterestRate: baseFinancialData.interestRate,
      loanTermYears: baseFinancialData.loanTermYears,
      repaymentFrequency: baseFinancialData.repaymentFrequency,
      loanType: baseFinancialData.loanType === 'interest_only' ? 'interest_only' : 'principal_interest',
      interestOnlyPeriodYears: baseFinancialData.interestOnlyPeriodYears,
      extraRepaymentPerPeriod: extraPerPeriod,
      offsetBalance: baseFinancialData.offsetBalance,
    };
    
    // Build rate changes from yearly overrides (including Year 1)
    const rateChanges: RateChange[] = [];
    Object.entries(yearlyOverrides).forEach(([yearStr, overrides]) => {
      const year = parseInt(yearStr);
      if (overrides.interestRate !== undefined && overrides.interestRate !== null && year >= 1) {
        rateChanges.push({
          effectiveFromPeriod: (year - 1) * periodsPerYear + 1,
          newAnnualRate: overrides.interestRate,
        });
      }
    });
    // Sort rate changes by period to ensure proper application
    rateChanges.sort((a, b) => a.effectiveFromPeriod - b.effectiveFromPeriod);
    
    return get10YearLoanProjection(mortgageInput, rateChanges);
  }, [baseFinancialData, yearlyOverrides]);

  // Get override value for a specific year and field
  const getOverrideValue = useCallback((year: number, field: EditableFieldKey): number | null => {
    return yearlyOverrides[year]?.[field] ?? null;
  }, [yearlyOverrides]);

  // Set override value for a specific year and field
  const setOverrideValue = useCallback((year: number, field: EditableFieldKey, value: number | null) => {
    setYearlyOverrides(prev => {
      const newOverrides = { ...prev };
      if (!newOverrides[year]) {
        newOverrides[year] = {};
      }
      newOverrides[year] = { ...newOverrides[year], [field]: value };
      return newOverrides;
    });
    setHasChanges(true);
  }, []);

  // Handle cell edit start
  const handleCellEditStart = useCallback((year: number, field: EditableFieldKey, currentValue: number) => {
    const overrideValue = getOverrideValue(year, field);
    setEditingCell({ year, field });
    setEditValue(overrideValue !== null ? String(overrideValue) : String(currentValue));
  }, [getOverrideValue]);

  // Handle cell edit commit
  const handleCellEditCommit = useCallback(() => {
    if (!editingCell) return;

    // parseFinancialInput strips currency symbols/commas and returns null for a
    // temporarily-blank field. Zero parses to 0 (a valid override), never null.
    const numValue = parseFinancialInput(editValue);
    if (editValue.trim() !== '' && numValue === null) {
      // Non-empty but unparseable (invalid text) — discard the edit, keep the
      // previously committed value rather than corrupting the override.
      setEditingCell(null);
      return;
    }

    setOverrideValue(editingCell.year, editingCell.field, numValue);
    setEditingCell(null);
  }, [editingCell, editValue, setOverrideValue]);

  // Handle key press in edit mode
  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCellEditCommit();
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    }
  }, [handleCellEditCommit]);

  // Save overrides to database
  const handleSaveOverrides = async () => {
    if (!report) return;

    setIsSaving(true);
    try {
      const existingOverrides = report.manual_overrides || {};
      const updatedOverrides = {
        ...existingOverrides,
        cashFlowYearlyOverrides: yearlyOverrides,
        excludeLandTaxFromCashFlow: excludeLandTaxFromCashFlow,
      };

      const { data: updateResult, error } = await invokeSecureFunction('manage-investment-reports', {
        action: 'update',
        reportId: report.id,
        data: { manual_overrides: updatedOverrides }
      });

      if (error || !updateResult?.success) {
        throw new Error(error?.message || updateResult?.error || 'Failed to save overrides');
      }

      toast({
        title: "Overrides Saved",
        description: "Cash flow analysis overrides have been saved successfully.",
      });

      // Log activity
      logActivityDirect({
        actionType: 'cash_flow_updated',
        entityType: 'cash_flow_analysis',
        entityId: report.id,
        entityName: report.property_address,
        metadata: { overrideKeys: Object.keys(yearlyOverrides), excludeLandTax: excludeLandTaxFromCashFlow }
      });

      setHasChanges(false);
      onReportUpdated?.();
    } catch (error) {
      console.error('Error saving overrides:', error);
      toast({
        title: "Save Failed",
        description: "Failed to save cash flow analysis overrides.",
        variant: "destructive"
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Reset all overrides
  const handleResetOverrides = useCallback(() => {
    setYearlyOverrides({});
    setHasChanges(true);
    setShowResetConfirm(false);
  }, []);

  // Calculate 10-year projections with per-year overrides and amortisation engine
  const projections = useMemo(() => {
    if (!baseFinancialData) return [];

    const results: YearlyProjection[] = [];
    
    // Calculate initial values
    const purchasePrice = baseFinancialData.purchasePrice;
    const initialLoanAmount = baseFinancialData.loanAmount || (purchasePrice * (baseFinancialData.loanToValueRatio / 100));
    const weeklyRent = baseFinancialData.weeklyRent;
    const occupancyRate = baseFinancialData.occupancyRate;
    const baseCapitalGrowthRate = baseFinancialData.capitalGrowth / 100;
    const baseInterestRate = baseFinancialData.interestRate / 100;
    const baseCpiRate = baseFinancialData.cpiGrowthRate / 100;
    const taxRate = baseFinancialData.taxRate / 100;

    // Calculate initial fixed expenses (excluding property management which is rent-based)
    const baseFixedExpenses = 
      baseFinancialData.councilRates +
      baseFinancialData.waterRates +
      baseFinancialData.bodyCorporateFees +
      baseFinancialData.buildingLandlordInsurance +
      baseFinancialData.repairsMaintenance;

    // Calculate property management as percentage of rent
    const propertyManagementPercent = baseFinancialData.propertyManagementFees / 100;

    // Base calculated values for Year 0
    const baseAnnualRent = weeklyRent * occupancyRate;

    // Track previous year values for CHAINED cascade (not compound from base)
    let previousPropertyValue = baseFinancialData.marketValueNow || purchasePrice;
    let previousRentalIncome = baseAnnualRent;
    let previousFixedExpenses = baseFixedExpenses;

    for (let year = 0; year <= 10; year++) {
      const yearOverrides = yearlyOverrides[year] || {};
      
      // Get rates for this year (use override or base)
      // FIX: Year 1 can now use override if provided
      const yearCapitalGrowthRate = year >= 1 && yearOverrides.capitalGrowthRate !== undefined && yearOverrides.capitalGrowthRate !== null
        ? yearOverrides.capitalGrowthRate / 100
        : baseCapitalGrowthRate;
      
      const yearCpiRate = year >= 1 && yearOverrides.cpiGrowthRate !== undefined && yearOverrides.cpiGrowthRate !== null
        ? yearOverrides.cpiGrowthRate / 100
        : baseCpiRate;
      
      const yearInterestRate = year >= 1 && yearOverrides.interestRate !== undefined && yearOverrides.interestRate !== null
        ? yearOverrides.interestRate / 100
        : baseInterestRate;

      // =====================================================
      // PROPERTY VALUE - Chained cascade from previous year
      // =====================================================
      let propertyValue: number;
      if (year === 0) {
        propertyValue = baseFinancialData.marketValueNow || purchasePrice;
      } else if (yearOverrides.propertyMarketValue !== undefined && yearOverrides.propertyMarketValue !== null) {
        // Direct override - use it, but still chain from here for subsequent years
        propertyValue = yearOverrides.propertyMarketValue;
      } else {
        // CHAINED: Grow from PREVIOUS year's actual value (including any overrides)
        // This applies the CURRENT year's growth rate to the previous year's value
        propertyValue = previousPropertyValue * (1 + yearCapitalGrowthRate);
      }
      // Update tracker for next iteration
      previousPropertyValue = propertyValue;

      // =====================================================
      // LOAN CALCULATIONS - Amortization engine with rate changes
      // =====================================================
      let currentLoanAmount: number;
      let interestPayments: number;
      let principalPayments: number;
      
      if (year === 0) {
        currentLoanAmount = initialLoanAmount;
        interestPayments = 0;
        principalPayments = 0;
      } else if (loanProjections && loanProjections[year - 1]) {
        const yearProjection = loanProjections[year - 1];
        
        // Use override values if provided (locked), otherwise use amortization engine values
        if (yearOverrides.interestPayment !== undefined && yearOverrides.interestPayment !== null) {
          interestPayments = yearOverrides.interestPayment;
        } else {
          interestPayments = yearProjection.interestPayment;
        }
        
        if (yearOverrides.principalPayment !== undefined && yearOverrides.principalPayment !== null) {
          principalPayments = yearOverrides.principalPayment;
        } else {
          principalPayments = yearProjection.principalPayment;
        }
        
        // Loan balance comes from amortization engine (reflects rate changes)
        currentLoanAmount = yearProjection.closingBalance;
      } else {
        // Fallback to simple calculation if amortization engine not available
        currentLoanAmount = initialLoanAmount;
        interestPayments = initialLoanAmount * yearInterestRate;
        principalPayments = 0;
      }

      // Equity - derived from property value and loan balance
      const equity = propertyValue - currentLoanAmount;

      // LVR - derived from loan balance and property value
      const lvr = propertyValue > 0 ? (currentLoanAmount / propertyValue) * 100 : 0;

      // =====================================================
      // RENTAL INCOME - Chained cascade from previous year
      // =====================================================
      let annualRent: number;
      if (year === 0) {
        annualRent = baseAnnualRent;
      } else if (yearOverrides.rentalIncome !== undefined && yearOverrides.rentalIncome !== null) {
        // Direct override - use it, subsequent years chain from here
        annualRent = yearOverrides.rentalIncome;
      } else {
        // CHAINED: Grow from PREVIOUS year's actual rent using CURRENT year's CPI
        annualRent = previousRentalIncome * (1 + yearCpiRate);
      }
      // Update tracker for next iteration
      previousRentalIncome = annualRent;

      // =====================================================
      // PROPERTY EXPENSES - Hybrid: Fixed portion chains, Mgmt fee is dynamic
      // =====================================================
      let totalExpenses: number;
      let currentFixedExpenses: number;
      
      if (year === 0) {
        currentFixedExpenses = baseFixedExpenses;
        const propertyManagement = annualRent * propertyManagementPercent;
        totalExpenses = currentFixedExpenses + propertyManagement;
      } else if (yearOverrides.propertyExpenses !== undefined && yearOverrides.propertyExpenses !== null) {
        // Direct override - LOCKED value, doesn't cascade
        totalExpenses = yearOverrides.propertyExpenses;
        // Estimate fixed expenses for tracking (approximate)
        currentFixedExpenses = totalExpenses - (annualRent * propertyManagementPercent);
      } else {
        // CHAINED: Fixed expenses grow from PREVIOUS year's fixed expenses using CURRENT year's CPI
        currentFixedExpenses = previousFixedExpenses * (1 + yearCpiRate);
        // Property management is ALWAYS recalculated from current year's rent
        const propertyManagement = annualRent * propertyManagementPercent;
        totalExpenses = currentFixedExpenses + propertyManagement;
      }
      // Update tracker for next iteration
      previousFixedExpenses = currentFixedExpenses;

      // Gross yield - derived from rent and property value
      const grossYield = year === 0 ? 0 : (annualRent / propertyValue) * 100;

      // Net yield - derived from rent, expenses, and property value
      const netYield = year === 0 ? 0 : ((annualRent - totalExpenses) / propertyValue) * 100;

      // =====================================================
      // DEPRECIATION - LOCKED (schedule-based or direct override)
      // Priority: saved/draft manual override > generated 10-year schedule >
      // single default. Manual overrides (incl. 0) always win so saved edits
      // are never overwritten by the generated figure during recalculation.
      // =====================================================
      const depreciation = resolveYearDepreciation({
        year,
        override: yearOverrides.depreciation,
        scheduleValue: baseFinancialData.depreciationSchedule?.[year],
        defaultValue: baseFinancialData.depreciation,
      });

      // =====================================================
      // LAND TAX - LOCKED (direct override or base value)
      // =====================================================
      let landTax: number;
      if (excludeLandTaxFromCashFlow) {
        landTax = 0;
      } else if (year === 0) {
        landTax = 0;
      } else if (yearOverrides.landTax !== undefined && yearOverrides.landTax !== null) {
        landTax = yearOverrides.landTax;
      } else {
        landTax = baseFinancialData.landTax;
      }

      // =====================================================
      // CASH FLOW CALCULATIONS - All derived from above values
      // =====================================================
      
      // Pre-tax cash flow (includes land tax as a cash expense)
      const preTaxCashFlow = year === 0 ? 0 : annualRent - totalExpenses - interestPayments - principalPayments - landTax;

      // Total deductions (includes land tax for tax calculation)
      const totalDeductions = totalExpenses + interestPayments + depreciation + landTax;

      // Net profit/loss (taxable income/loss)
      const netProfitLoss = year === 0 ? 0 : annualRent - totalDeductions;

      // Tax refund (negative gearing benefit when in loss position)
      const taxRefund = year === 0 ? 0 : (netProfitLoss < 0 ? Math.abs(netProfitLoss) * taxRate : 0);

      // After-tax cash flow
      const afterTaxCashFlow = year === 0 ? 0 : preTaxCashFlow + taxRefund;

      results.push({
        year,
        capitalGrowthRate: year === 0 ? 0 : (yearCapitalGrowthRate * 100),
        cpiGrowthRate: year === 0 ? 0 : (yearCpiRate * 100),
        propertyMarketValue: Math.round(propertyValue),
        loanAmount: Math.round(currentLoanAmount),
        equityInProperty: Math.round(equity),
        loanToValueRatio: Math.round(lvr * 100) / 100,
        rentalIncome: Math.round(annualRent),
        grossYield: Math.round(grossYield * 100) / 100,
        netYield: Math.round(netYield * 100) / 100,
        propertyExpenses: Math.round(totalExpenses),
        interestRate: year === 0 ? 0 : (yearInterestRate * 100),
        interestPayments: Math.round(interestPayments),
        principalPayments: Math.round(principalPayments),
        preTaxCashFlowPA: Math.round(preTaxCashFlow),
        preTaxCashFlowPW: Math.round(preTaxCashFlow / 52),
        depreciation: Math.round(depreciation),
        totalDeductions: Math.round(totalDeductions),
        netProfitLoss: Math.round(netProfitLoss),
        taxRefund: Math.round(taxRefund),
        landTax: landTax,
        afterTaxCashFlowPA: Math.round(afterTaxCashFlow),
        afterTaxCashFlowPW: Math.round(afterTaxCashFlow / 52),
      });
    }

    return results;
  }, [baseFinancialData, yearlyOverrides, loanProjections, excludeLandTaxFromCashFlow]);

  // Construction Progress Payment Schedule calculation
  interface ConstructionStage {
    stage: string;
    description: string;
    percentage: number;
    buildAmount: number;
    cumulativeDrawn: number;
    landInterest: number;
    buildInterest: number;
    totalMonthlyInterest: number;
    month: number;
  }

  const constructionProgressSchedule = useMemo(() => {
    if (!baseFinancialData) return null;

    const landPrice = baseFinancialData.landPrice || 0;
    const buildPrice = baseFinancialData.buildPrice || (baseFinancialData.purchasePrice - landPrice);
    const interestRate = baseFinancialData.interestRate / 100; // Annual rate
    const durationMonths = Math.min(baseFinancialData.constructionDurationMonths || 7, 24);

    // Land interest calculation: Land Cost × Interest Rate / 12
    // This calculates monthly interest on the full land value
    const monthlyLandInterest = landPrice * interestRate / 12;

    // Get custom stage percentages from manual overrides or use defaults
    const stagePercentages = {
      deposit: (report?.manual_overrides?.stageDepositPercent as number) ?? 5,
      slab: (report?.manual_overrides?.stageSlabPercent as number) ?? 15,
      frame: (report?.manual_overrides?.stageFramePercent as number) ?? 20,
      lockup: (report?.manual_overrides?.stageLockupPercent as number) ?? 25,
      fixing: (report?.manual_overrides?.stageFixingPercent as number) ?? 20,
      completion: (report?.manual_overrides?.stageCompletionPercent as number) ?? 15,
    };

    // Build stages - use custom percentages or defaults
    const baseStages = [
      { stage: 'Deposit', description: 'Paid from your funds (not from lender)', percentage: stagePercentages.deposit },
      { stage: 'Slab/Base Stage', description: 'Foundation, slab, ground works', percentage: stagePercentages.slab },
      { stage: 'Frame Stage', description: 'Wall frames, roof trusses, structural frame', percentage: stagePercentages.frame },
      { stage: 'Lock-up Stage', description: 'External walls, windows, doors (can "lock up")', percentage: stagePercentages.lockup },
      { stage: 'Fixing Stage', description: 'Internal linings, plaster, cabinets, fittings', percentage: stagePercentages.fixing },
      { stage: 'Practical Completion', description: 'Final works, painting, finishes', percentage: stagePercentages.completion },
    ];

    // Determine stage months based on preset
    const getStageMonths = (): number[] => {
      if (schedulePreset === 'rapid') {
        // Rapid: stages at months 2-7 (fixed)
        return [2, 3, 4, 5, 6, 7];
      } else if (schedulePreset === 'even') {
        // Even distribution: spread 6 stages across (durationMonths - 1) months
        // Month 1 is always land interest, so stages start at month 2
        const availableMonths = durationMonths - 1; // Exclude month 1
        const numStages = baseStages.length;
        const months: number[] = [];
        
        for (let i = 0; i < numStages; i++) {
          // Distribute evenly: first stage at month 2, last stage at durationMonths
          const month = Math.round(2 + (i * (availableMonths - 1)) / Math.max(1, numStages - 1));
          months.push(Math.min(month, durationMonths));
        }
        return months;
      } else {
        // Custom: use customStageMonths state
        return baseStages.map((_, index) => customStageMonths[index] || (index + 2));
      }
    };

    const stageMonths = getStageMonths();

    // Create a map of month -> array of stage data for that month (supports multiple stages per month)
    const monthToStages: { [month: number]: Array<{ stage: typeof baseStages[0]; index: number }> } = {};
    stageMonths.forEach((month, index) => {
      if (!monthToStages[month]) {
        monthToStages[month] = [];
      }
      monthToStages[month].push({ stage: baseStages[index], index });
    });

    let cumulativeDrawn = 0;
    let totalBuildInterest = 0;
    let totalCombinedRepayment = monthlyLandInterest; // Start with first month land interest

    // Land Interest Charge row (month 1)
    const landInterestRow: ConstructionStage = {
      stage: 'Land Interest Charge',
      description: '',
      percentage: 0,
      buildAmount: landPrice,
      cumulativeDrawn: 0,
      landInterest: Math.round(monthlyLandInterest * 100) / 100,
      buildInterest: 0,
      totalMonthlyInterest: Math.round(monthlyLandInterest * 100) / 100,
      month: 1,
    };

    const stageResults: ConstructionStage[] = [landInterestRow];

    // Build rows for months 2 through durationMonths
    for (let month = 2; month <= durationMonths; month++) {
      const stagesThisMonth = monthToStages[month] || [];
      
      if (stagesThisMonth.length > 0) {
        // This month has one or more stage payments - add a row for each stage
        stagesThisMonth.forEach((stageData) => {
          const s = stageData.stage;
          const buildAmount = (buildPrice * s.percentage) / 100;
          
          // For Deposit stage, no build interest is charged
          // For other stages: Build Interest = (Cumulative Stage Pricing up to and including this stage) × Interest Rate ÷ 12
          const isDeposit = s.stage === 'Deposit';
          
          // Add this stage to cumulative drawn
          cumulativeDrawn += buildAmount;
          
          // Calculate build interest based on the formula:
          // - Deposit: No interest (0)
          // - Slab/Base: (Slab pricing) × Interest Rate ÷ 12
          // - Frame: (Slab + Frame pricing) × Interest Rate ÷ 12
          // - Lock-up: (Slab + Frame + Lock-up pricing) × Interest Rate ÷ 12
          // - Fixing: (Slab + Frame + Lock-up + Fixing pricing) × Interest Rate ÷ 12
          // - Practical Completion: (All stage pricings) × Interest Rate ÷ 12
          // Note: "cumulativeDrawn" at this point includes all stages up to and including current
          // But for interest calc, we exclude the deposit amount
          const depositAmount = (buildPrice * stagePercentages.deposit) / 100;
          const cumulativeForInterest = isDeposit ? 0 : (cumulativeDrawn - depositAmount);
          const buildInterest = isDeposit ? 0 : (cumulativeForInterest * interestRate / 12);
          
          const combinedRepayment = monthlyLandInterest + buildInterest;
          
          totalBuildInterest += buildInterest;
          totalCombinedRepayment += combinedRepayment;

          stageResults.push({
            stage: s.stage,
            description: s.description,
            percentage: s.percentage,
            buildAmount: Math.round(buildAmount * 100) / 100,
            cumulativeDrawn: Math.round(cumulativeDrawn * 100) / 100,
            landInterest: Math.round(monthlyLandInterest * 100) / 100,
            buildInterest: Math.round(buildInterest * 100) / 100,
            totalMonthlyInterest: Math.round(combinedRepayment * 100) / 100,
            month: month,
          });
        });
      } else {
        // No stage this month - interest-only row
        // Use cumulative drawn excluding deposit for interest calculation
        const depositAmount = (buildPrice * stagePercentages.deposit) / 100;
        const cumulativeForInterest = Math.max(0, cumulativeDrawn - depositAmount);
        const buildInterest = cumulativeForInterest * interestRate / 12;
        const combinedRepayment = monthlyLandInterest + buildInterest;
        
        totalBuildInterest += buildInterest;
        totalCombinedRepayment += combinedRepayment;

        stageResults.push({
          stage: '',
          description: '',
          percentage: 0,
          buildAmount: 0,
          cumulativeDrawn: Math.round(cumulativeDrawn * 100) / 100,
          landInterest: Math.round(monthlyLandInterest * 100) / 100,
          buildInterest: Math.round(buildInterest * 100) / 100,
          totalMonthlyInterest: Math.round(combinedRepayment * 100) / 100,
          month: month,
        });
      }
    }

    // Upfront costs
    const tenPercentLand = landPrice * 0.10;
    const fivePercentBuild = buildPrice * 0.05;
    const stampDuty = baseFinancialData.stampDuty || 0;
    const solicitorFees = baseFinancialData.solicitorFees || 0;
    const agentFee = baseFinancialData.agentFee || 0;
    const lmiAmount = baseFinancialData.lmiAmount || 0;
    const totalUpfrontCost = tenPercentLand + fivePercentBuild + stampDuty + solicitorFees + agentFee + lmiAmount;

    // Total interest during construction
    // IMPORTANT: Sum the already-rounded per-row values so the footer total
    // matches what users see when adding the visible monthly column.
    const totalLandInterestRounded = stageResults.reduce((sum, r) => sum + (r.landInterest || 0), 0);
    const totalBuildInterestRounded = stageResults.reduce((sum, r) => sum + (r.buildInterest || 0), 0);
    const totalCombinedRepaymentRounded = stageResults.reduce((sum, r) => sum + (r.totalMonthlyInterest || 0), 0);
    const stagedProgressInterest = Math.round((totalLandInterestRounded + totalBuildInterestRounded) * 100) / 100;

    return {
      landPrice,
      buildPrice,
      totalProject: landPrice + buildPrice,
      interestRate: baseFinancialData.interestRate,
      durationMonths,
      stages: stageResults,
      monthlyLandInterest: Math.round(monthlyLandInterest * 100) / 100,
      totals: {
        landInterest: Math.round(totalLandInterestRounded * 100) / 100,
        buildInterest: Math.round(totalBuildInterestRounded * 100) / 100,
        totalInterest: stagedProgressInterest,
        totalCombinedRepayment: Math.round(totalCombinedRepaymentRounded * 100) / 100,
      },
      upfrontCosts: {
        tenPercentLand,
        fivePercentBuild,
        stampDuty,
        solicitorFees,
        agentFee,
        totalUpfrontCost,
      },
      grandTotal: Math.round((totalUpfrontCost + stagedProgressInterest) * 100) / 100,
    };
  }, [baseFinancialData, report?.manual_overrides, schedulePreset, customStageMonths]);


  // Calculate advanced comparison metrics
  const calculateAdvancedMetrics = useCallback((
    projs: YearlyProjection[],
    baseData: any
  ) => {
    if (!baseData || projs.length < 11) return null;

    const purchasePrice = baseData.purchasePrice;
    const depositValue = baseData.depositValue || (purchasePrice * (1 - baseData.loanToValueRatio / 100));
    const stampDuty = baseData.stampDuty;
    const lmiAmount = baseData.lmiAmount || 0;
    const totalInitialInvestment = depositValue + stampDuty + (baseData.solicitorFees || 2000) + lmiAmount;

    // Total cash flow over 10 years
    const totalCashFlow = projs.slice(1).reduce((sum, p) => sum + p.afterTaxCashFlowPA, 0);

    // Capital gain
    const capitalGain = projs[10].propertyMarketValue - purchasePrice;

    // Total return (capital gain + cash flow)
    const totalReturn = capitalGain + totalCashFlow;

    // ROI = Total Return / Initial Investment * 100
    const roi = totalInitialInvestment > 0 ? (totalReturn / totalInitialInvestment) * 100 : 0;

    // Annualized ROI
    const annualizedRoi = Math.pow(1 + roi / 100, 1 / 10) * 100 - 100;

    // Break-even year (when cumulative cash flow becomes positive)
    let cumulativeCashFlow = 0;
    let breakEvenYear: number | null = null;
    for (let i = 1; i <= 10; i++) {
      cumulativeCashFlow += projs[i].afterTaxCashFlowPA;
      if (cumulativeCashFlow >= 0 && breakEvenYear === null) {
        breakEvenYear = i;
      }
    }

    // Cash-on-cash return (Year 1)
    const cashOnCash = totalInitialInvestment > 0 
      ? (projs[1].afterTaxCashFlowPA / totalInitialInvestment) * 100 
      : 0;

    // Equity multiple
    const equityMultiple = totalInitialInvestment > 0 
      ? (projs[10].equityInProperty + totalCashFlow) / totalInitialInvestment 
      : 0;

    return {
      totalInitialInvestment,
      totalCashFlow,
      capitalGain,
      totalReturn,
      roi,
      annualizedRoi,
      breakEvenYear,
      cashOnCash,
      equityMultiple
    };
  }, []);

  // Memoized metrics for primary property
  const primaryMetrics = useMemo(() => 
    calculateAdvancedMetrics(projections, baseFinancialData),
    [projections, baseFinancialData, calculateAdvancedMetrics]
  );

  // Memoized metrics for all comparison properties
  const allComparisonMetrics = useMemo(() => {
    return allComparisonProjections.map(({ report: compReport, projections: compProjs }) => {
      if (compProjs.length < 11) return { report: compReport, metrics: null };
      
      const fc = compReport.financial_calculations || {};
      const mo = compReport.manual_overrides || {};
      
      const compBaseData = {
        purchasePrice: mo.purchasePrice || fc.purchasePrice || fc.propertyValue || 0,
        depositValue: mo.depositValue || fc.depositValue || 0,
        stampDuty: mo.stampDuty || fc.stampDuty || 0,
        solicitorFees: mo.solicitorFees || fc.solicitorFees || 2000,
        loanToValueRatio: mo.loanToValueRatio || fc.loanToValueRatio || 80,
      };
      
      return { report: compReport, metrics: calculateAdvancedMetrics(compProjs, compBaseData), projections: compProjs };
    });
  }, [allComparisonProjections, calculateAdvancedMetrics]);

  // Generate AI-powered comparison analysis
  const generateAiAnalysis = useCallback(async () => {
    if (!report || comparisonReports.length === 0) return;
    
    setIsGeneratingAiAnalysis(true);
    setAiAnalysis(null);
    
    try {
      const allReportIds = [report.id, ...comparisonReports.map(r => r.id)];
      
      // Prepare projection data for each report
      const projectionData: Record<string, any> = {};
      
      // Add primary report projection summary
      if (projections.length > 0) {
        projectionData[report.id] = {
          year1: projections[1] || {},
          year5: projections[5] || {},
          year10: projections[10] || {},
          metrics: primaryMetrics,
        };
      }
      
      // Add comparison reports projection summaries
      allComparisonProjections.forEach(({ report: compReport, projections: compProjs }) => {
        const compMetrics = allComparisonMetrics.find(m => m.report.id === compReport.id);
        projectionData[compReport.id] = {
          year1: compProjs[1] || {},
          year5: compProjs[5] || {},
          year10: compProjs[10] || {},
          metrics: compMetrics?.metrics || {},
        };
      });
      
      const { data, error } = await invokeSecureFunction('compare-cash-flow-reports', {
        reportIds: allReportIds,
        projectionData,
        investorProfile,
        timeHorizon: '10 years',
      });
      
      if (error) throw error;
      
      if (data?.success && data?.analysis) {
        setAiAnalysis(data.analysis);
        toast({
          title: "AI Analysis Complete",
          description: "Cash flow comparison analysis has been generated.",
        });
      } else {
        throw new Error(data?.error || 'Failed to generate analysis');
      }
    } catch (error: any) {
      console.error('Error generating AI analysis:', error);
      toast({
        title: "Analysis Failed",
        description: error.message || "Failed to generate AI comparison analysis.",
        variant: "destructive"
      });
    } finally {
      setIsGeneratingAiAnalysis(false);
    }
  }, [report, comparisonReports, projections, primaryMetrics, allComparisonProjections, allComparisonMetrics, investorProfile, toast]);

  // Save AI analysis to database
  const saveAiAnalysis = useCallback(async () => {
    if (!report || !aiAnalysis || comparisonReports.length === 0) return;
    
    setIsSavingAnalysis(true);
    try {
      const sortedComparisonIds = comparisonReports.map(r => r.id).sort();
      
      if (savedAnalysisId) {
        // Update existing
        const { error } = await supabase
          .from('cash_flow_analyses')
          .update({
            analysis_data: aiAnalysis,
            investor_profile: investorProfile,
            updated_at: new Date().toISOString(),
          })
          .eq('id', savedAnalysisId);
        
        if (error) throw error;
        
        logActivityDirect({
          actionType: 'cash_flow_updated',
          entityType: 'cash_flow_analysis',
          entityId: savedAnalysisId,
          entityName: report.property_address,
          metadata: { investor_profile: investorProfile, comparison_count: comparisonReports.length }
        });
        
        toast({
          title: "Analysis Updated",
          description: "Your cash flow analysis has been updated.",
        });
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('cash_flow_analyses')
          .insert({
            primary_report_id: report.id,
            comparison_report_ids: sortedComparisonIds,
            analysis_data: aiAnalysis,
            investor_profile: investorProfile,
          })
          .select('id')
          .single();
        
        if (error) throw error;
        
        setSavedAnalysisId(data.id);
        logActivityDirect({
          actionType: 'cash_flow_created',
          entityType: 'cash_flow_analysis',
          entityId: data.id,
          entityName: report.property_address,
          metadata: { investor_profile: investorProfile, comparison_count: comparisonReports.length }
        });
        
        toast({
          title: "Analysis Saved",
          description: "Your cash flow analysis has been saved and can be viewed later.",
        });
      }
    } catch (error: any) {
      console.error('Error saving AI analysis:', error);
      toast({
        title: "Save Failed",
        description: error.message || "Failed to save the analysis.",
        variant: "destructive"
      });
    } finally {
      setIsSavingAnalysis(false);
    }
  }, [report, aiAnalysis, comparisonReports, savedAnalysisId, investorProfile, toast]);

  const propertyRecommendation = useMemo(() => {
    if (!primaryMetrics || comparisonReports.length === 0 || !report) return null;

    // Calculate profile-specific scores
    const getProfileScore = (metrics: typeof primaryMetrics, profile: 'growth' | 'income' | 'balanced') => {
      if (!metrics) return 0;
      
      switch (profile) {
        case 'growth':
          return (
            (metrics.capitalGain / 100000) * 30 +
            (metrics.roi) * 25 +
            (metrics.annualizedRoi) * 20 +
            (metrics.equityMultiple) * 25
          );
        case 'income':
          return (
            (metrics.totalCashFlow > 0 ? metrics.totalCashFlow / 1000 : metrics.totalCashFlow / 500) * 35 +
            (metrics.cashOnCash * 10) * 30 +
            ((10 - (metrics.breakEvenYear || 10)) * 10) * 20 +
            (projections[1]?.grossYield || 0) * 15
          );
        case 'balanced':
          return (
            (metrics.capitalGain / 100000) * 20 +
            (metrics.roi) * 15 +
            (metrics.totalCashFlow > 0 ? metrics.totalCashFlow / 1000 : metrics.totalCashFlow / 500) * 25 +
            (metrics.cashOnCash * 10) * 15 +
            (metrics.equityMultiple) * 15 +
            ((10 - (metrics.breakEvenYear || 10)) * 5) * 10
          );
      }
    };

    // Build all property scores
    const allScores = [
      { 
        name: report.property_address.split(',')[0], 
        score: getProfileScore(primaryMetrics, investorProfile),
        isPrimary: true,
        metrics: primaryMetrics
      },
      ...allComparisonMetrics.map(({ report: compReport, metrics }) => ({
        name: compReport.property_address.split(',')[0],
        score: getProfileScore(metrics, investorProfile),
        isPrimary: false,
        metrics
      }))
    ].sort((a, b) => b.score - a.score);

    const winner = allScores[0];
    const scoreDiff = allScores.length > 1 ? allScores[0].score - allScores[1].score : 0;
    const confidence = scoreDiff > 50 ? 'high' : scoreDiff > 20 ? 'moderate' : 'marginal';

    return {
      winner: winner.name,
      rankings: allScores.map((s, i) => ({ rank: i + 1, name: s.name, score: Math.round(s.score) })),
      confidence,
      insights: [
        `${winner.name} scores highest for ${investorProfile}-focused investors`,
        winner.metrics?.roi ? `10-Year ROI: ${winner.metrics.roi.toFixed(1)}%` : '',
        winner.metrics?.totalCashFlow ? `Total Cash Flow: $${winner.metrics.totalCashFlow.toLocaleString('en-AU')}` : ''
      ].filter(Boolean).slice(0, 3)
    };
  }, [primaryMetrics, allComparisonMetrics, report, comparisonReports, investorProfile, projections]);

  // PDF Export function for comparison (supports multiple properties)
  const exportComparisonPDF = useCallback(async (options?: { returnBlob?: boolean }): Promise<Blob | void> => {
    if (!report || comparisonReports.length === 0) return;

    try {
      toast({
        title: "Generating PDF",
        description: "Please wait while charts are being captured...",
      });

      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      let yPos = margin;

      // Title
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Cash Flow Analysis Comparison', pageWidth / 2, yPos, { align: 'center' });
      yPos += 10;

      // Properties being compared
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`Property 1 (Primary): ${report.property_address}`, margin, yPos);
      yPos += 5;
      comparisonReports.forEach((compReport, idx) => {
        pdf.text(`Property ${idx + 2}: ${compReport.property_address}`, margin, yPos);
        yPos += 5;
      });
      pdf.text(`Generated: ${new Date().toLocaleDateString('en-AU')}`, margin, yPos);
      yPos += 10;

      // Capture and add charts
      const chartRefs = [
        { ref: cashFlowChartRef, title: 'Cash Flow Trends' },
        { ref: yieldChartRef, title: 'Yield Percentages' },
        { ref: comparisonChartRef, title: 'Property Comparison' }
      ];

      for (const chart of chartRefs) {
        if (chart.ref.current) {
          const canvas = await html2canvas(chart.ref.current, {
            backgroundColor: '#ffffff',
            scale: 2,
          });
          
          const imgData = canvas.toDataURL('image/png');
          const imgWidth = pageWidth - (margin * 2);
          const imgHeight = (canvas.height * imgWidth) / canvas.width;

          if (yPos + imgHeight > pageHeight - margin) {
            pdf.addPage();
            yPos = margin;
          }

          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text(chart.title, margin, yPos);
          yPos += 5;
          
          pdf.addImage(imgData, 'PNG', margin, yPos, imgWidth, imgHeight);
          yPos += imgHeight + 10;
        }
      }

      // Add comparison metrics table
      pdf.addPage();
      yPos = margin;

      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Investment Comparison Metrics', pageWidth / 2, yPos, { align: 'center' });
      yPos += 10;

      const formatValue = (value: number | null | undefined, format: string) => {
        if (value === null || value === undefined) return 'N/A';
        switch (format) {
          case 'currency': return `$${Math.round(value).toLocaleString('en-AU')}`;
          case 'percent': return `${value.toFixed(2)}%`;
          case 'year': return value === null ? 'N/A' : `Year ${value}`;
          case 'multiple': return `${value.toFixed(2)}x`;
          default: return String(value);
        }
      };

      // Table header
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Metric', margin, yPos);
      pdf.text('Primary', margin + 55, yPos);
      allComparisonMetrics.slice(0, 4).forEach((_, idx) => {
        pdf.text(`Prop ${idx + 2}`, margin + 85 + (idx * 25), yPos);
      });
      yPos += 2;
      pdf.line(margin, yPos, pageWidth - margin, yPos);
      yPos += 5;

      const metrics = [
        { label: '10-Year ROI', key: 'roi', format: 'percent' },
        { label: 'Annualized ROI', key: 'annualizedRoi', format: 'percent' },
        { label: 'Total Return', key: 'totalReturn', format: 'currency' },
        { label: 'Break-Even Year', key: 'breakEvenYear', format: 'year' },
        { label: 'Cash-on-Cash (Y1)', key: 'cashOnCash', format: 'percent' },
        { label: 'Equity Multiple', key: 'equityMultiple', format: 'multiple' },
        { label: 'Total Cash Flow', key: 'totalCashFlow', format: 'currency' },
        { label: 'Capital Gain', key: 'capitalGain', format: 'currency' },
      ];

      // Table rows
      pdf.setFont('helvetica', 'normal');
      for (const metric of metrics) {
        pdf.text(metric.label, margin, yPos);
        pdf.text(formatValue((primaryMetrics as any)?.[metric.key], metric.format), margin + 55, yPos);
        allComparisonMetrics.slice(0, 4).forEach(({ metrics: compMetrics }, idx) => {
          pdf.text(formatValue((compMetrics as any)?.[metric.key], metric.format), margin + 85 + (idx * 25), yPos);
        });
        yPos += 6;
      }

      // Add AI Analysis section if available
      if (aiAnalysis) {
        pdf.addPage();
        yPos = margin;

        pdf.setFontSize(16);
        pdf.setFont('helvetica', 'bold');
        pdf.text('AI-Powered Cash Flow Analysis', pageWidth / 2, yPos, { align: 'center' });
        yPos += 12;

        // Helper function to add wrapped text
        const addWrappedText = (text: string, fontSize: number, maxWidth: number, lineHeight: number = 5) => {
          pdf.setFontSize(fontSize);
          const lines = pdf.splitTextToSize(text, maxWidth);
          for (const line of lines) {
            if (yPos + lineHeight > pageHeight - margin) {
              pdf.addPage();
              yPos = margin;
            }
            pdf.text(line, margin, yPos);
            yPos += lineHeight;
          }
        };

        // Executive Summary
        if (aiAnalysis.executiveSummary) {
          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text('Executive Summary', margin, yPos);
          yPos += 7;
          pdf.setFont('helvetica', 'normal');
          addWrappedText(aiAnalysis.executiveSummary, 9, pageWidth - (margin * 2), 4.5);
          yPos += 8;
        }

        // Final Rankings
        if (aiAnalysis.finalRankings && aiAnalysis.finalRankings.length > 0) {
          if (yPos > pageHeight - 60) {
            pdf.addPage();
            yPos = margin;
          }
          
          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text('Final Rankings', margin, yPos);
          yPos += 7;

          pdf.setFontSize(9);
          for (const ranking of aiAnalysis.finalRankings) {
            if (yPos + 20 > pageHeight - margin) {
              pdf.addPage();
              yPos = margin;
            }
            
            pdf.setFont('helvetica', 'bold');
            // `address`, not `propertyAddress`: the producer's schema emits the
            // former (`compare-cash-flow-reports/index.ts:192`) and this line
            // read the latter, so every ranking in this PDF printed
            // "#1 - undefined". The old key is kept as a fallback in case a
            // future prompt emits it.
            pdf.text(`#${ranking.rank} - ${ranking.address ?? ranking.propertyAddress ?? ''}`, margin, yPos);
            yPos += 5;

            pdf.setFont('helvetica', 'normal');
            // Same story for `score`, and the `/100` is gone with it. The schema
            // states no scale, so printing a denominator asserts something the
            // record does not support — fixing the key while keeping `/100`
            // would turn "undefined" into a confidently wrong number.
            const rankingScore = ranking.score ?? ranking.overallScore;
            if (rankingScore !== undefined && rankingScore !== null) {
              pdf.text(`Score: ${rankingScore}`, margin + 5, yPos);
              yPos += 4;
            }
            
            if (ranking.strengths && ranking.strengths.length > 0) {
              pdf.text(`Strengths: ${ranking.strengths.join(', ')}`, margin + 5, yPos);
              yPos += 4;
            }
            if (ranking.weaknesses && ranking.weaknesses.length > 0) {
              pdf.text(`Weaknesses: ${ranking.weaknesses.join(', ')}`, margin + 5, yPos);
              yPos += 4;
            }
            yPos += 3;
          }
          yPos += 5;
        }

        // Investor Recommendations
        if (aiAnalysis.investorRecommendations) {
          if (yPos > pageHeight - 80) {
            pdf.addPage();
            yPos = margin;
          }
          
          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text('Investor Profile Recommendations', margin, yPos);
          yPos += 7;

          pdf.setFontSize(9);
          // `balanced`, not `balancedApproach`. The producer's schema (`:185`)
          // emits the former and both generators asked for the latter, so the
          // Balanced recommendation has never appeared in a client's PDF. The
          // old key stays as a fallback.
          const recommendations = [
            { keys: ['growthFocused'], label: 'Growth Focused' },
            { keys: ['incomeFocused'], label: 'Income Focused' },
            { keys: ['balanced', 'balancedApproach'], label: 'Balanced Approach' },
            { keys: ['riskAverse'], label: 'Risk Averse' },
          ];

          for (const rec of recommendations) {
            const recData = rec.keys
              .map((key) => aiAnalysis.investorRecommendations[key])
              .find(Boolean);
            if (recData) {
              if (yPos + 15 > pageHeight - margin) {
                pdf.addPage();
                yPos = margin;
              }

              // The label alone. The schema gives `{propertyNumber, reason}` and
              // no `recommendation`, so this printed "N/A" for all four
              // profiles. `propertyNumber` is not substituted in its place: it
              // indexes `propertiesData`, which is built by mapping over the
              // result of an `IN` query whose row order Postgres does not
              // guarantee, so it names an ordering nobody recorded. The
              // on-screen panel prints the reason and no property for the same
              // reason.
              pdf.setFont('helvetica', 'bold');
              pdf.text(`${rec.label}`, margin, yPos);
              yPos += 4.5;

              if (recData.reason) {
                pdf.setFont('helvetica', 'normal');
                addWrappedText(recData.reason, 8, pageWidth - (margin * 2) - 5, 4);
              }
              yPos += 3;
            }
          }
          yPos += 5;
        }

        // Overall Recommendation
        //
        // `.bestProperty.reason`, not the object. The schema (`:199`) makes this
        // `{bestProperty, avoid, alternativeScenarios}` and this line handed the
        // whole object to `pdf.splitTextToSize`. The on-screen panel reads it
        // correctly, so the same object was being read three different ways in
        // one file.
        const bestOverall = aiAnalysis.overallRecommendation?.bestProperty?.reason;
        if (bestOverall) {
          if (yPos > pageHeight - 40) {
            pdf.addPage();
            yPos = margin;
          }

          pdf.setFontSize(12);
          pdf.setFont('helvetica', 'bold');
          pdf.text('Overall Recommendation', margin, yPos);
          yPos += 7;

          pdf.setFont('helvetica', 'normal');
          addWrappedText(bestOverall, 9, pageWidth - (margin * 2), 4.5);
        }
      }

      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      yPos += 10;
      if (yPos > pageHeight - 20) {
        pdf.addPage();
        yPos = margin;
      }
      pdf.text('This comparison is for informational purposes only.', margin, yPos);

      if (options?.returnBlob) {
        return pdf.output('blob');
      }

      pdf.save(`cash-flow-comparison-${comparisonReports.length + 1}-properties-${new Date().toISOString().split('T')[0]}.pdf`);

      logActivityDirect({
        actionType: 'comparison_pdf_downloaded',
        entityType: 'cash_flow_analysis',
        entityName: report.property_address,
        metadata: { comparison_count: comparisonReports.length + 1, has_ai_analysis: !!aiAnalysis }
      });

      toast({
        title: "PDF Exported",
        description: aiAnalysis ? "Comparison PDF with AI analysis has been downloaded." : "Comparison PDF has been downloaded successfully.",
      });
    } catch (error) {
      console.error('Error exporting PDF:', error);
      toast({
        title: "Export Failed",
        description: "Failed to generate comparison PDF.",
        variant: "destructive"
      });
    }
  }, [report, comparisonReports, allComparisonMetrics, primaryMetrics, aiAnalysis, toast]);

  // Export AI Analysis Only as PDF
  const exportAiAnalysisPDF = useCallback(async (options?: { returnBlob?: boolean }): Promise<Blob | void> => {
    if (!report || !aiAnalysis) return;

    try {
      toast({
        title: "Generating PDF",
        description: "Exporting AI analysis...",
      });

      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      let yPos = margin;

      // Helper function to add wrapped text
      const addWrappedText = (text: string, fontSize: number, maxWidth: number, lineHeight: number = 5) => {
        pdf.setFontSize(fontSize);
        const lines = pdf.splitTextToSize(text, maxWidth);
        for (const line of lines) {
          if (yPos + lineHeight > pageHeight - margin) {
            pdf.addPage();
            yPos = margin;
          }
          pdf.text(line, margin, yPos);
          yPos += lineHeight;
        }
      };

      // Title
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('AI Cash Flow Comparison Analysis', pageWidth / 2, yPos, { align: 'center' });
      yPos += 12;

      // Properties analyzed
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.text('Properties Analyzed:', margin, yPos);
      yPos += 5;
      pdf.text(`1. ${report.property_address} (Primary)`, margin + 5, yPos);
      yPos += 5;
      comparisonReports.forEach((compReport, idx) => {
        pdf.text(`${idx + 2}. ${compReport.property_address}`, margin + 5, yPos);
        yPos += 5;
      });
      yPos += 3;
      pdf.text(`Generated: ${new Date().toLocaleDateString('en-AU')}`, margin, yPos);
      yPos += 12;

      // Executive Summary
      if (aiAnalysis.executiveSummary) {
        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Executive Summary', margin, yPos);
        yPos += 8;
        pdf.setFont('helvetica', 'normal');
        addWrappedText(aiAnalysis.executiveSummary, 10, pageWidth - (margin * 2), 5);
        yPos += 10;
      }

      // Final Rankings
      if (aiAnalysis.finalRankings && aiAnalysis.finalRankings.length > 0) {
        if (yPos > pageHeight - 60) {
          pdf.addPage();
          yPos = margin;
        }
        
        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Final Rankings', margin, yPos);
        yPos += 8;

        for (const ranking of aiAnalysis.finalRankings) {
          if (yPos + 25 > pageHeight - margin) {
            pdf.addPage();
            yPos = margin;
          }
          
          // Rank header with background
          pdf.setFillColor(ranking.rank === 1 ? 220 : 240, ranking.rank === 1 ? 252 : 240, ranking.rank === 1 ? 231 : 240);
          pdf.rect(margin, yPos - 4, pageWidth - (margin * 2), 20, 'F');
          
          pdf.setFontSize(11);
          pdf.setFont('helvetica', 'bold');
          // The schema's key first. This read `propertyAddress` first and fell
          // through, which happened to work; the order now matches the producer.
          pdf.text(`#${ranking.rank} - ${ranking.address ?? ranking.propertyAddress ?? ''}`, margin + 3, yPos);
          yPos += 6;

          pdf.setFontSize(9);
          pdf.setFont('helvetica', 'normal');
          // No `/100`: the schema names no scale. `??` rather than `||`, so a
          // genuine score of 0 prints instead of being treated as absent.
          const overallScore = ranking.score ?? ranking.overallScore;
          if (overallScore !== undefined && overallScore !== null) {
            pdf.text(`Overall Score: ${overallScore}`, margin + 5, yPos);
            yPos += 4;
          }
          
          if (ranking.strengths && ranking.strengths.length > 0) {
            pdf.setTextColor(34, 139, 34);
            pdf.text(`Strengths: ${ranking.strengths.join(', ')}`, margin + 5, yPos);
            pdf.setTextColor(0, 0, 0);
            yPos += 4;
          }
          if (ranking.weaknesses && ranking.weaknesses.length > 0) {
            pdf.setTextColor(178, 34, 34);
            pdf.text(`Weaknesses: ${ranking.weaknesses.join(', ')}`, margin + 5, yPos);
            pdf.setTextColor(0, 0, 0);
            yPos += 4;
          }
          yPos += 6;
        }
        yPos += 5;
      }

      // Investor Recommendations
      if (aiAnalysis.investorRecommendations) {
        if (yPos > pageHeight - 80) {
          pdf.addPage();
          yPos = margin;
        }
        
        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Investor Profile Recommendations', margin, yPos);
        yPos += 8;

        // `balanced` first, `balancedApproach` as a fallback — see the same fix
        // in `exportComparisonPDF`.
        const recommendations = [
          { keys: ['growthFocused'], label: 'Growth Focused', color: [59, 130, 246] },
          { keys: ['incomeFocused'], label: 'Income Focused', color: [34, 197, 94] },
          { keys: ['balanced', 'balancedApproach'], label: 'Balanced Approach', color: [168, 85, 247] },
          { keys: ['riskAverse'], label: 'Risk Averse', color: [249, 115, 22] },
        ];

        for (const rec of recommendations) {
          const recData = rec.keys
            .map((key) => aiAnalysis.investorRecommendations[key])
            .find(Boolean);
          if (recData) {
            if (yPos + 20 > pageHeight - margin) {
              pdf.addPage();
              yPos = margin;
            }

            pdf.setFontSize(10);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(rec.color[0], rec.color[1], rec.color[2]);
            // The label alone. `recData.recommendation` is not in the schema and
            // printed "N/A" for every profile; `propertyNumber` is not put in
            // its place because it indexes an ordering nobody recorded.
            pdf.text(`${rec.label}`, margin, yPos);
            pdf.setTextColor(0, 0, 0);
            pdf.setFont('helvetica', 'normal');
            yPos += 5;

            if (recData.reason) {
              addWrappedText(recData.reason, 9, pageWidth - (margin * 2) - 5, 4.5);
            }
            yPos += 5;
          }
        }
        yPos += 5;
      }

      // Overall Recommendation — the object's `bestProperty.reason`, not the
      // object. See the same fix in `exportComparisonPDF`.
      const bestOverall = aiAnalysis.overallRecommendation?.bestProperty?.reason;
      if (bestOverall) {
        if (yPos > pageHeight - 50) {
          pdf.addPage();
          yPos = margin;
        }

        pdf.setFontSize(14);
        pdf.setFont('helvetica', 'bold');
        pdf.text('Overall Recommendation', margin, yPos);
        yPos += 8;

        pdf.setFont('helvetica', 'normal');
        addWrappedText(bestOverall, 10, pageWidth - (margin * 2), 5);
      }

      // Disclaimer
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'italic');
      yPos += 15;
      if (yPos > pageHeight - 20) {
        pdf.addPage();
        yPos = margin;
      }
      pdf.text('This AI-powered analysis is for informational purposes only and should not be considered financial advice.', margin, yPos);

      if (options?.returnBlob) {
        return pdf.output('blob');
      }

      pdf.save(`ai-cash-flow-analysis-${new Date().toISOString().split('T')[0]}.pdf`);

      toast({
        title: "PDF Exported",
        description: "AI analysis PDF has been downloaded successfully.",
      });
    } catch (error) {
      console.error('Error exporting AI analysis PDF:', error);
      toast({
        title: "Export Failed",
        description: "Failed to generate AI analysis PDF.",
        variant: "destructive"
      });
    }
  }, [report, comparisonReports, aiAnalysis, toast]);

  const formatCurrency = (value: number) => {
    if (value === 0) return '-';
    const formatted = Math.abs(value).toLocaleString('en-AU', { maximumFractionDigits: 0 });
    return value < 0 ? `-$${formatted}` : `$${formatted}`;
  };

  const formatPercent = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  // Check if a cell has an override
  const hasOverride = useCallback((year: number, field: EditableFieldKey): boolean => {
    const value = yearlyOverrides[year]?.[field];
    return value !== undefined && value !== null;
  }, [yearlyOverrides]);

  // Render editable cell
  const renderEditableCell = useCallback((
    year: number, 
    field: EditableFieldKey, 
    displayValue: number,
    formatFn: (val: number) => string
  ) => {
    const isEditing = editingCell?.year === year && editingCell?.field === field;
    const isEditable = year >= 1; // Years 1-10 are editable
    const hasOverrideValue = hasOverride(year, field);
    const fieldConfig = EDITABLE_FIELDS.find(f => f.key === field);
    const fieldLabel = fieldConfig?.label ?? field;
    // Accessible label, e.g. "Year 1 Depreciation $". Keyboard/screen-reader
    // users get a per-cell label instead of an unlabelled control.
    const a11yLabel = `Year ${year} ${fieldLabel}`;

    // Shared geometry so the control never changes size between the read-only
    // button and the editing input (prevents hover/focus layout shift, flicker
    // and column jump). Fixed height + 1px border in every state. The md:*
    // variants pin the height/text-size across breakpoints so the shadcn Input
    // base classes (md:h-10 / md:text-sm) can't reintroduce a size mismatch.
    const cellBox = 'box-border h-9 md:h-9 w-full min-w-[88px] rounded-lg border px-2 text-center text-xs md:text-xs';

    if (isEditing) {
      return (
        <Input
          type="number"
          inputMode="decimal"
          step={fieldConfig?.step || 1}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCellEditCommit}
          onKeyDown={handleEditKeyDown}
          autoFocus
          aria-label={a11yLabel}
          className={cn(
            cellBox,
            'border-primary/50 bg-primary/5 py-0 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0',
            // Hide native number spinners so the field width stays constant on focus.
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          )}
        />
      );
    }

    if (isEditable) {
      return (
        <button
          type="button"
          onClick={() => handleCellEditStart(year, field, displayValue)}
          aria-label={hasOverrideValue ? `${a11yLabel} (overridden)` : a11yLabel}
          title={hasOverrideValue ? 'Click to edit (overridden)' : 'Click to edit'}
          className={cn(
            cellBox,
            // Only colours transition on hover/focus — no transform, size or
            // border-width change — so adjacent columns never shift.
            'group relative inline-flex items-center justify-center transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            hasOverrideValue
              ? 'border-primary/40 bg-primary/10 font-semibold text-primary'
              : 'border-transparent bg-transparent',
          )}
        >
          {hasOverrideValue && (
            <span
              className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
              aria-hidden="true"
            />
          )}
          <span className="block truncate">{formatFn(displayValue)}</span>
        </button>
      );
    }

    return <span>{formatFn(displayValue)}</span>;
  }, [editingCell, editValue, hasOverride, handleCellEditStart, handleCellEditCommit, handleEditKeyDown]);

  const handleExportExcel = () => {
    if (!baseFinancialData || !report) return;

    // Create workbook
    const wb = XLSX.utils.book_new();

    // ==================== SHEET 1: Cash Flow Analysis ====================
    const analysisData: (string | number | null)[][] = [];
    
    // Title
    analysisData.push(['10 Year Cash Flow Analysis']);
    analysisData.push([report.property_address]);
    analysisData.push([]);
    
    // ---- INPUT PARAMETERS SECTION ----
    analysisData.push(['INPUT PARAMETERS']);
    analysisData.push([]);
    
    // Purchase & Loan Details
    analysisData.push(['PURCHASE & LOAN DETAILS']);
    analysisData.push(['Purchase Price', baseFinancialData.purchasePrice]);
    analysisData.push(['Land Price', baseFinancialData.landPrice]);
    analysisData.push(['Build Price', baseFinancialData.buildPrice]);
    analysisData.push(['Market Value Now', baseFinancialData.marketValueNow]);
    analysisData.push(['Deposit', baseFinancialData.depositValue]);
    analysisData.push(['Loan Amount', baseFinancialData.loanAmount || (baseFinancialData.purchasePrice * (baseFinancialData.loanToValueRatio / 100))]);
    analysisData.push(['LVR %', baseFinancialData.loanToValueRatio]);
    analysisData.push(['Interest Rate %', baseFinancialData.interestRate]);
    analysisData.push(['Loan Type', baseFinancialData.loanType === 'interest_only' ? 'Interest Only' : 'Principal & Interest']);
    analysisData.push(['Loan Term (Years)', baseFinancialData.loanTermYears]);
    analysisData.push([]);
    
    // Rental Income
    analysisData.push(['RENTAL INCOME']);
    analysisData.push(['Weekly Rent', baseFinancialData.weeklyRent]);
    analysisData.push(['Annual Rent', baseFinancialData.weeklyRent * baseFinancialData.occupancyRate]);
    analysisData.push(['Occupancy (Weeks/Year)', baseFinancialData.occupancyRate]);
    analysisData.push([]);
    
    // Expenses
    analysisData.push(['ANNUAL EXPENSES']);
    analysisData.push(['Stamp Duty (One-off)', baseFinancialData.stampDuty]);
    analysisData.push(['Council Rates', baseFinancialData.councilRates]);
    analysisData.push(['Water Rates', baseFinancialData.waterRates]);
    analysisData.push(['Body Corporate/Strata', baseFinancialData.bodyCorporateFees]);
    analysisData.push(['Building & Landlord Insurance', baseFinancialData.buildingLandlordInsurance]);
    analysisData.push(['Property Management %', baseFinancialData.propertyManagementFees]);
    analysisData.push(['Repairs & Maintenance', baseFinancialData.repairsMaintenance]);
    analysisData.push(['Letting Fees', baseFinancialData.lettingFees]);
    analysisData.push(['Land Tax', baseFinancialData.landTax]);
    if (baseFinancialData.lmiAmount > 0) {
      analysisData.push(['LMI (Lenders Mortgage Insurance)', baseFinancialData.lmiAmount]);
    }
    analysisData.push([]);
    
    // Tax & Growth
    analysisData.push(['TAX & GROWTH']);
    analysisData.push(['Capital Growth Rate %', baseFinancialData.capitalGrowth]);
    analysisData.push(['CPI Growth Rate %', baseFinancialData.cpiGrowthRate]);
    analysisData.push(['Depreciation p.a.', baseFinancialData.depreciation]);
    analysisData.push(['Tax Rate %', baseFinancialData.taxRate]);
    analysisData.push([]);

    // Create first worksheet
    const ws1 = XLSX.utils.aoa_to_sheet(analysisData);
    XLSX.utils.book_append_sheet(wb, ws1, 'Input Parameters');

    // ==================== SHEET 2: 10 Year Projections ====================
    const projectionData: (string | number | null)[][] = [];
    
    // Header row
    projectionData.push(['10 YEAR CASH FLOW PROJECTIONS']);
    projectionData.push([report.property_address]);
    projectionData.push([]);
    
    // Column headers
    const headers = ['Metric', 'Today', ...Array.from({ length: 10 }, (_, i) => `Year ${i + 1}`)];
    projectionData.push(headers);
    
    // Data rows with per-year overridden values
    projectionData.push(['Capital Growth %', ...projections.map(p => p.year === 0 ? '' : p.capitalGrowthRate)]);
    projectionData.push(['CPI Growth %', ...projections.map(p => p.year === 0 ? '' : p.cpiGrowthRate)]);
    projectionData.push(['Property Value $', ...projections.map(p => p.propertyMarketValue)]);
    projectionData.push(['Loan Amount $', ...projections.map(p => p.loanAmount)]);
    projectionData.push([]);
    projectionData.push(['STATISTICS']);
    projectionData.push(['Equity $', ...projections.map(p => p.equityInProperty)]);
    projectionData.push(['LVR %', ...projections.map(p => p.loanToValueRatio)]);
    projectionData.push(['Rental Income $', ...projections.map(p => p.year === 0 ? `${baseFinancialData.weeklyRent}pw` : p.rentalIncome)]);
    projectionData.push(['Gross Yield %', ...projections.map(p => p.year === 0 ? '' : p.grossYield)]);
    projectionData.push(['Net Yield %', ...projections.map(p => p.year === 0 ? '' : p.netYield)]);
    projectionData.push([]);
    projectionData.push(['CASH DEDUCTIONS']);
    projectionData.push(['Property Expenses $', ...projections.map(p => p.year === 0 ? 0 : p.propertyExpenses)]);
    projectionData.push(['Land Tax $', ...projections.map(p => p.year === 0 ? '' : p.landTax)]);
    projectionData.push(['Interest Rate %', ...projections.map(p => p.year === 0 ? '' : p.interestRate)]);
    projectionData.push(['Interest Payments $', ...projections.map(p => p.year === 0 ? 0 : p.interestPayments)]);
    projectionData.push(['Principal Payments $', ...projections.map(p => p.principalPayments)]);
    projectionData.push(['Pre-Tax Cash Flow p/a $', ...projections.map(p => p.year === 0 ? '' : p.preTaxCashFlowPA)]);
    projectionData.push(['Pre-Tax Cash Flow p/w $', ...projections.map(p => p.year === 0 ? '' : p.preTaxCashFlowPW)]);
    projectionData.push([]);
    projectionData.push(['NON-CASH DEDUCTIONS']);
    projectionData.push(['Depreciation $', ...projections.map(p => p.year === 0 ? '' : p.depreciation)]);
    projectionData.push([]);
    projectionData.push(['SUMMARY']);
    projectionData.push(['Total Deductions $', ...projections.map(p => p.year === 0 ? '' : p.totalDeductions)]);
    projectionData.push(['Net Profit/Loss $', ...projections.map(p => p.year === 0 ? '' : p.netProfitLoss)]);
    projectionData.push(['Tax Refund $', ...projections.map(p => p.year === 0 ? '' : p.taxRefund)]);
    projectionData.push(['After-Tax Cash Flow p/a $', ...projections.map(p => p.year === 0 ? '' : p.afterTaxCashFlowPA)]);
    projectionData.push(['After-Tax Cash Flow p/w $', ...projections.map(p => p.year === 0 ? '' : p.afterTaxCashFlowPW)]);

    // Create second worksheet
    const ws2 = XLSX.utils.aoa_to_sheet(projectionData);
    
    // Set column widths
    ws2['!cols'] = [
      { wch: 25 }, // Metric column
      ...Array(11).fill({ wch: 15 }) // Year columns
    ];
    
    XLSX.utils.book_append_sheet(wb, ws2, '10 Year Projections');

    // Download
    const fileName = `Cash_Flow_Analysis_${report.property_address.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    XLSX.writeFile(wb, fileName);

    toast({
      title: "Export Successful",
      description: "Cash flow analysis has been exported to Excel.",
    });
  };

  // Export single report 10-year cash flow as PDF with charts
  // When returnBlob is true, returns the PDF blob instead of triggering a download
  const exportSingleReportPDF = useCallback(async (options?: { returnBlob?: boolean; chartOverrides?: { cashFlowTrends: boolean; yieldChart: boolean; comparisonChart: boolean } }): Promise<Blob | void> => {
    if (!report || !baseFinancialData) return;

    try {
      // Load active template configuration
      const templateConfig = await loadActiveCashFlowTemplate();
      console.log(`📋 Using Cash Flow template: ${templateConfig.name}`);

      const pdf = new jsPDF('p', 'mm', 'a4'); // Portrait orientation for better fit
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const footerHeight = 32; // Reserved space for footer - increased to prevent overlap
      const contentMaxY = pageHeight - footerHeight; // Maximum Y position for content
      let yPos = 0;

      // ========== COVER PAGE ==========
      // Use the configured cover template image as background
      const goldColor = { r: 201, g: 165, b: 90 }; // #c9a55a
      
      try {
        // Add cover template image as full page background
        const coverImageUrl = '/templates/npc-cashflow-cover.jpg';
        pdf.addImage(coverImageUrl, 'JPEG', 0, 0, pageWidth, pageHeight);
      } catch (e) {
        // Fallback: draw simple dark background if image fails
        pdf.setFillColor(26, 26, 26);
        pdf.rect(0, 0, pageWidth, pageHeight, 'F');
        
        // Gold accent bar at top
        pdf.setFillColor(goldColor.r, goldColor.g, goldColor.b);
        pdf.rect(0, 0, pageWidth, 8, 'F');
        
        // Company name fallback (uses configured template branding)
        pdf.setFontSize(28);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(goldColor.r, goldColor.g, goldColor.b);
        pdf.text(templateConfig.companyName || 'PROPERTY', pageWidth / 2, 100, { align: 'center' });
        pdf.text(templateConfig.companyNameLine2 || 'CONSULTING', pageWidth / 2, 115, { align: 'center' });
        
        pdf.setFontSize(12);
        pdf.setFont('helvetica', 'normal');
        pdf.text('YOUR DEDICATED PROPERTY PARTNER', pageWidth / 2, 135, { align: 'center' });
        
        // Bottom gold bar
        pdf.setFillColor(goldColor.r, goldColor.g, goldColor.b);
        pdf.rect(0, pageHeight - 8, pageWidth, 8, 'F');
      }

      // Add new page for content
      pdf.addPage();

      // Brand colors (gold primary)
      const primaryColor = { r: 202, g: 138, b: 4 }; // Gold #ca8a04
      const darkText = { r: 30, g: 30, b: 30 };
      const grayText = { r: 100, g: 100, b: 100 };
      const lightGray = { r: 248, g: 248, b: 248 };
      const mediumGray = { r: 220, g: 220, b: 220 }; // Slightly darker for better contrast
      const tableHeaderBg = { r: 45, g: 55, b: 72 }; // Slate gray
      const sectionBg = { r: 254, g: 249, b: 235 }; // Warmer cream #fef9eb
      const negativeRed = { r: 185, g: 28, b: 28 }; // Darker red for negatives #B91C1C

      // Use chartOverrides if provided (from Send to Client), otherwise use the component's toggle state
      const activeChartToggles = options?.chartOverrides || chartExportToggles;
      
      // Capture charts first (only if toggles are enabled)
      let cashFlowChartImage: string | null = null;
      let yieldChartImage: string | null = null;
      let comparisonChartImage: string | null = null;
      
      if (activeChartToggles.cashFlowTrends && cashFlowChartRef.current) {
        try {
          const canvas = await html2canvas(cashFlowChartRef.current, {
            backgroundColor: '#ffffff',
            scale: 2,
          });
          cashFlowChartImage = canvas.toDataURL('image/png');
        } catch (e) {
          console.warn('Failed to capture cash flow chart:', e);
        }
      }
      
      if (activeChartToggles.yieldChart && yieldChartRef.current) {
        try {
          const canvas = await html2canvas(yieldChartRef.current, {
            backgroundColor: '#ffffff',
            scale: 2,
          });
          yieldChartImage = canvas.toDataURL('image/png');
        } catch (e) {
          console.warn('Failed to capture yield chart:', e);
        }
      }
      
      if (activeChartToggles.comparisonChart && comparisonChartRef.current) {
        try {
          const canvas = await html2canvas(comparisonChartRef.current, {
            backgroundColor: '#ffffff',
            scale: 2,
          });
          comparisonChartImage = canvas.toDataURL('image/png');
        } catch (e) {
          console.warn('Failed to capture comparison chart:', e);
        }
      }

      // ========== HEADER SECTION ==========
      // Start content directly without the top banner
      yPos = margin;

      // Document title section
      pdf.setTextColor(darkText.r, darkText.g, darkText.b);
      pdf.setFontSize(20);
      pdf.setFont('helvetica', 'bold');
      pdf.text('10-Year Cash Flow Analysis', margin, yPos);
      yPos += 8;

      // Property address with subtle underline
      pdf.setFontSize(13);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(grayText.r, grayText.g, grayText.b);
      // Clean the address - remove "Copy" suffix and trailing underscores/numbers
      const cleanedAddress = report.property_address.replace(/[_\s]?Copy[_\s]?\d*$/i, '').trim();
      pdf.text(cleanedAddress, margin, yPos);
      yPos += 5;

      // Decorative line under address
      pdf.setDrawColor(primaryColor.r, primaryColor.g, primaryColor.b);
      pdf.setLineWidth(0.5);
      pdf.line(margin, yPos, margin + 120, yPos);
      yPos += 6;

      // Generation date
      pdf.setFontSize(8);
      pdf.setTextColor(grayText.r, grayText.g, grayText.b);
      pdf.text(`Generated: ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`, margin, yPos);
      pdf.setTextColor(darkText.r, darkText.g, darkText.b);
      yPos += 10;

      // ========== KEY METRICS CARDS ==========
      const cardWidth = (pageWidth - margin * 2 - 15) / 4;
      const cardHeight = 14;
      const cardY = yPos;

      const keyMetricsData = [
        { label: 'Purchase Price', value: formatCurrency(baseFinancialData.purchasePrice) },
        { label: 'Weekly Rent', value: formatCurrency(baseFinancialData.weeklyRent) },
        { label: 'Interest Rate', value: `${baseFinancialData.interestRate}%` },
        { label: 'Capital Growth', value: `${baseFinancialData.capitalGrowth}%` },
      ];

      keyMetricsData.forEach((metric, idx) => {
        const cardX = margin + idx * (cardWidth + 5);
        
        // Card background
        pdf.setFillColor(lightGray.r, lightGray.g, lightGray.b);
        pdf.roundedRect(cardX, cardY, cardWidth, cardHeight, 2, 2, 'F');
        
        // Card border
        pdf.setDrawColor(mediumGray.r, mediumGray.g, mediumGray.b);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(cardX, cardY, cardWidth, cardHeight, 2, 2, 'S');
        
        // Metric label
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(grayText.r, grayText.g, grayText.b);
        pdf.text(metric.label, cardX + 4, cardY + 5);
        
        // Metric value
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        pdf.text(metric.value, cardX + 4, cardY + 11);
      });

      yPos = cardY + cardHeight + 8;

      // ========== INPUTS SUMMARY SECTION ==========
      if (includeInputsSummaryInExport) {
        // Section header with accent line
        pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
        pdf.rect(margin, yPos, 3, 5, 'F');
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        pdf.text('Input Summary', margin + 6, yPos + 4);
        yPos += 8;

        // Summary table with two columns
        const inputsColWidth = (pageWidth - margin * 2) / 2 - 5;
        const inputRowHeight = 4.2;
        let rowCount = 0;

        const drawInputRow = (label: string, value: string, label2?: string, value2?: string) => {
          if (yPos > pageHeight - 25) {
            pdf.addPage();
            yPos = margin;
          }
          
          // Alternating row background
          if (rowCount % 2 === 0) {
            pdf.setFillColor(lightGray.r, lightGray.g, lightGray.b);
            pdf.rect(margin, yPos - 3, pageWidth - margin * 2, inputRowHeight, 'F');
          }

          pdf.setFontSize(7);
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(grayText.r, grayText.g, grayText.b);
          pdf.text(label, margin + 2, yPos);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(darkText.r, darkText.g, darkText.b);
          pdf.text(value, margin + 52, yPos);
          
          if (label2 && value2) {
            pdf.setFont('helvetica', 'normal');
            pdf.setTextColor(grayText.r, grayText.g, grayText.b);
            pdf.text(label2, margin + inputsColWidth + 10, yPos);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(darkText.r, darkText.g, darkText.b);
            pdf.text(value2, margin + inputsColWidth + 62, yPos);
          }
          yPos += inputRowHeight;
          rowCount++;
        };

        // Draw inputs in two columns
        drawInputRow('Purchase Price:', formatCurrency(baseFinancialData.purchasePrice), 'Weekly Rent:', formatCurrency(baseFinancialData.weeklyRent));
        drawInputRow('Land Price:', formatCurrency(baseFinancialData.landPrice), 'Gross Rental Yield:', projections.length > 1 ? `${projections[1].grossYield.toFixed(2)}%` : '-');
        drawInputRow('Build Price:', formatCurrency(baseFinancialData.buildPrice || (baseFinancialData.purchasePrice - baseFinancialData.landPrice)), 'Council Rates (p.a.):', formatCurrency(baseFinancialData.councilRates));
        drawInputRow('Deposit Amount:', formatCurrency(baseFinancialData.depositValue), 'Water Rates (p.a.):', formatCurrency(baseFinancialData.waterRates));
        drawInputRow('Loan Amount:', formatCurrency(baseFinancialData.loanAmount || (baseFinancialData.purchasePrice * (baseFinancialData.loanToValueRatio / 100))), 'Property Management:', `${baseFinancialData.propertyManagementFees}%`);
        drawInputRow('Interest Rate:', `${baseFinancialData.interestRate.toFixed(2)}%`, 'Landlord Insurance:', formatCurrency(baseFinancialData.buildingLandlordInsurance));
        drawInputRow('Capital Growth Rate:', `${baseFinancialData.capitalGrowth}%`, 'Letting Fees:', formatCurrency(baseFinancialData.lettingFees));
        drawInputRow('CPI Growth Rate:', `${baseFinancialData.cpiGrowthRate}%`, 'Repairs & Maintenance:', formatCurrency(baseFinancialData.repairsMaintenance));
        drawInputRow('Tax Rate (MTR):', `${baseFinancialData.taxRate}%`, 'Body Corporate:', formatCurrency(baseFinancialData.bodyCorporateFees));
        drawInputRow('Depreciation (Yr 1):', formatCurrency(baseFinancialData.depreciation), 'Stamp Duty:', formatCurrency(baseFinancialData.stampDuty));
        drawInputRow('', '', 'Conveyancing:', formatCurrency(baseFinancialData.solicitorFees));
        if (baseFinancialData.lmiAmount > 0) {
          drawInputRow('', '', 'LMI:', formatCurrency(baseFinancialData.lmiAmount));
        }

        // ===== Total Upfront Costs + Total Overall Expenditure to Completion =====
        yPos += 4;

        // Build row data for both sections
        const _purchasePrice = baseFinancialData.purchasePrice;
        const _depositValue = baseFinancialData.depositValue || (_purchasePrice * (1 - (baseFinancialData.loanToValueRatio || 80) / 100));
        const _depositPct = _purchasePrice > 0 ? Math.round((_depositValue / _purchasePrice) * 100) : 0;
        const _stampDuty = baseFinancialData.stampDuty || 0;
        const _solicitorFees = baseFinancialData.solicitorFees || 0;
        const _agentFee = baseFinancialData.agentFee || 0;
        const _lmiAmount = baseFinancialData.lmiAmount || 0;

        let upfrontRows: { label: string; value: number }[] = [];
        let overallExtraRows: { label: string; value: number }[] = [];
        let totalUpfront = 0;
        let totalOverall = 0;

        if (isNewBuild && constructionProgressSchedule) {
          const landDeposit = constructionProgressSchedule.upfrontCosts.tenPercentLand;
          const buildDeposit = constructionProgressSchedule.upfrontCosts.fivePercentBuild;
          const constructionProgressTotal = constructionProgressSchedule.buildPrice;
          const stagedInterest = constructionProgressSchedule.totals.totalCombinedRepayment;
          upfrontRows = [
            { label: '10% Land Deposit', value: landDeposit },
            { label: '5% Build Contract Deposit', value: buildDeposit },
            { label: 'Stamp Duty', value: _stampDuty },
            { label: 'Solicitor / Conveyancer Cost', value: _solicitorFees },
            { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
            ...(_lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: _lmiAmount }] : []),
          ];
          totalUpfront = landDeposit + buildDeposit + _stampDuty + _solicitorFees + stagedInterest + _lmiAmount;
          overallExtraRows = [
            { label: 'Purchase Price (Land)', value: constructionProgressSchedule.landPrice },
            { label: 'Stamp Duty', value: _stampDuty },
            { label: 'Solicitor / Conveyancer Cost', value: _solicitorFees },
            { label: 'Build Price', value: constructionProgressTotal },
            { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
          ];
          totalOverall = constructionProgressSchedule.landPrice + _stampDuty + _solicitorFees + constructionProgressTotal + stagedInterest;
        } else {
          upfrontRows = [
            { label: `Deposit (${_depositPct}% — from your funds)`, value: _depositValue },
            { label: 'Stamp Duty', value: _stampDuty },
            { label: 'Solicitor / Conveyancer Cost', value: _solicitorFees },
            { label: 'Agent Fee', value: _agentFee },
            ...(_lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: _lmiAmount }] : []),
          ];
          totalUpfront = _depositValue + _stampDuty + _solicitorFees + _agentFee + _lmiAmount;
          overallExtraRows = [
            { label: 'Purchase Price', value: _purchasePrice },
            { label: 'Stamp Duty', value: _stampDuty },
            { label: 'Solicitor / Conveyancer Cost', value: _solicitorFees },
            { label: 'Agent Fee', value: _agentFee },
          ];
          totalOverall = _purchasePrice + _stampDuty + _solicitorFees + _agentFee;
        }

        const brkTableWidth = pageWidth - margin * 2;
        const brkColLabel = brkTableWidth * 0.65;

        const drawSectionTitle = (title: string) => {
          pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
          pdf.rect(margin, yPos, 3, 5, 'F');
          pdf.setFontSize(9);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(darkText.r, darkText.g, darkText.b);
          pdf.text(title, margin + 6, yPos + 4);
          yPos += 8;
        };

        const drawTableHeader = () => {
          pdf.setFillColor(240, 240, 240);
          pdf.rect(margin, yPos, brkTableWidth, 5, 'F');
          pdf.setFontSize(7);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(grayText.r, grayText.g, grayText.b);
          pdf.text('Item', margin + 3, yPos + 3.5);
          pdf.text('Amount', margin + brkColLabel + 3, yPos + 3.5);
          yPos += 5.5;
        };

        const drawBrkRow = (label: string, amount: string, options?: { bold?: boolean; bg?: { r: number; g: number; b: number }; textColor?: { r: number; g: number; b: number } }) => {
          if (options?.bg) {
            pdf.setFillColor(options.bg.r, options.bg.g, options.bg.b);
            pdf.rect(margin, yPos - 0.5, brkTableWidth, 5, 'F');
          }
          pdf.setFontSize(7);
          pdf.setFont('helvetica', options?.bold ? 'bold' : 'normal');
          const tc = options?.textColor || darkText;
          pdf.setTextColor(tc.r, tc.g, tc.b);
          pdf.text(label, margin + 3, yPos + 3);
          pdf.text(amount, margin + brkColLabel + 3, yPos + 3);
          yPos += 5;
        };

        // Pagination check
        const totalRows = upfrontRows.length + overallExtraRows.length + 4; // section titles + headers + totals
        const breakdownEstHeight = totalRows * 5.5 + 30;
        if (yPos + breakdownEstHeight > pageHeight - margin) {
          pdf.addPage();
          yPos = margin + 10;
        }

        pdf.setDrawColor(220, 220, 220);
        pdf.setLineWidth(0.2);

        // ----- Total Upfront Costs section -----
        drawSectionTitle('Total Upfront Costs');
        drawTableHeader();
        upfrontRows.forEach(r => drawBrkRow(r.label, formatCurrency(r.value)));
        drawBrkRow('Total Upfront Costs', formatCurrency(totalUpfront), { bold: true, bg: { r: 235, g: 235, b: 235 } });

        yPos += 4;

        // ----- Total Overall Expenditure to Completion section -----
        drawSectionTitle('Total Overall Expenditure to Completion');
        drawTableHeader();
        overallExtraRows.forEach(r => drawBrkRow(r.label, formatCurrency(r.value)));

        // Highlight box for grand total
        yPos += 4;
        pdf.setFillColor(254, 243, 199);
        pdf.roundedRect(margin, yPos - 3, brkTableWidth, 7, 1, 1, 'F');
        pdf.setDrawColor(245, 158, 11);
        pdf.setLineWidth(0.4);
        pdf.roundedRect(margin, yPos - 3, brkTableWidth, 7, 1, 1, 'S');
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(146, 64, 14);
        pdf.text('Total Overall Expenditure to Completion:', margin + 4, yPos + 1);
        pdf.text(formatCurrency(totalOverall), margin + 80, yPos + 1);
        yPos += 10;
      }

      // ========== CONSTRUCTION PROGRESS SCHEDULE ==========
      // Render inline directly after the expenditure breakdown on the same (first) page.
      // No page break here — the 10-Year Projections table immediately below will
      // force its own fresh page.
      if (isNewBuild && includeConstructionScheduleInExport && constructionProgressSchedule && constructionProgressSchedule.buildPrice > 0) {
        yPos += 4;

        // Section header with accent line
        pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
        pdf.rect(margin, yPos, 3, 5, 'F');
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        pdf.text('Construction Progress Payment Schedule', margin + 6, yPos + 4);
        yPos += 8;

        // Project Summary cards
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(grayText.r, grayText.g, grayText.b);
        pdf.text(`Land Cost: ${formatCurrency(constructionProgressSchedule.landPrice)}   •   Build Contract: ${formatCurrency(constructionProgressSchedule.buildPrice)}   •   Total Project: ${formatCurrency(constructionProgressSchedule.totalProject)}`, margin, yPos);
        yPos += 6;

        // Table header
        pdf.setFontSize(6);
        pdf.setFillColor(tableHeaderBg.r, tableHeaderBg.g, tableHeaderBg.b);
        pdf.rect(margin, yPos - 3, pageWidth - margin * 2, 5, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFont('helvetica', 'bold');
        const scheduleHeaders = ['Stage', 'Description', '%', 'Stage Pricing', 'Land Int.', 'Build Int.', 'Combined', 'Mo'];
        const scheduleColWidths = [28, 55, 12, 22, 18, 18, 22, 10];
        let xPos = margin;
        scheduleHeaders.forEach((header, idx) => {
          pdf.text(header, xPos + 1, yPos);
          xPos += scheduleColWidths[idx];
        });
        yPos += 5;

        // Build stages rows with zebra striping
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        constructionProgressSchedule.stages.forEach((stage, idx) => {
          // Page break suppressed: construction schedule must remain on a single page.
          // Stage counts (typically <= 12 rows) comfortably fit on one A4 page.

          
          // Zebra striping
          if (idx % 2 === 0) {
            pdf.setFillColor(lightGray.r, lightGray.g, lightGray.b);
            pdf.rect(margin, yPos - 3, pageWidth - margin * 2, 4, 'F');
          }
          
          xPos = margin;
          const rowData = [
            stage.stage,
            stage.description.substring(0, 35) + (stage.description.length > 35 ? '...' : ''),
            stage.percentage > 0 ? `${stage.percentage}%` : '',
            formatCurrency(stage.buildAmount),
            formatCurrency(stage.landInterest),
            stage.buildInterest > 0 ? formatCurrency(stage.buildInterest) : '',
            formatCurrency(stage.totalMonthlyInterest),
            String(stage.month)
          ];
          rowData.forEach((cell, idx) => {
            pdf.text(cell, xPos + 1, yPos);
            xPos += scheduleColWidths[idx];
          });
          yPos += 4;
        });

        // Totals row — ensure it isn't cut off at the page bottom
        if (yPos + 8 > pageHeight - margin) {
          pdf.addPage();
          yPos = margin + 5;
        }
        pdf.setFillColor(sectionBg.r, sectionBg.g, sectionBg.b);
        pdf.rect(margin, yPos - 3, pageWidth - margin * 2, 5, 'F');
        pdf.setFont('helvetica', 'bold');
        xPos = margin;
        const totalsRow = [
          '',
          '',
          '100%',
          formatCurrency(constructionProgressSchedule.landPrice + constructionProgressSchedule.buildPrice),
          'Total',
          '',
          formatCurrency(constructionProgressSchedule.totals.totalCombinedRepayment),
          ''
        ];
        totalsRow.forEach((cell, idx) => {
          pdf.text(cell, xPos + 1, yPos);
          xPos += scheduleColWidths[idx];
        });
        yPos += 10;
      }

      // ========== 10-YEAR PROJECTIONS TABLE ==========
      // ALWAYS start the 10-year projections table on its own dedicated page
      // so the entire table is never split across page boundaries.
      pdf.addPage();
      yPos = margin + 5;

      // Section header with accent line
      pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
      pdf.rect(margin, yPos, 3, 5, 'F');
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(darkText.r, darkText.g, darkText.b);
      pdf.text('10-Year Projections', margin + 6, yPos + 4);
      yPos += 8;


      // Table configuration - compact for portrait orientation
      const colWidths = [34, ...Array(11).fill((pageWidth - margin * 2 - 34) / 11)]; // Slightly wider first column
      const rowHeight = 5; // Increased from 4.5 for better readability
      const sectionRowHeight = 6; // Taller section headers
      let tableRowCount = 0;
      
      // Helper to draw a row with enhanced styling and page boundary checking
      const drawRow = (cells: string[], isHeader = false, isSection = false, highlightValue = false) => {
        const currentRowHeight = isSection ? sectionRowHeight : rowHeight;
        
        // Page break suppressed: the 10-Year Projections table must always
        // render as a single contiguous block on its dedicated page.
        // (Row sizing is calibrated to fit all rows + sections on one A4 page.)

        
        if (isSection) {
          // Section header row - remove slash from section names
          const sectionName = cells[0].replace(/[\/\\|]/g, '').trim();
          yPos += 1; // Extra padding before section
          pdf.setFillColor(sectionBg.r, sectionBg.g, sectionBg.b);
          pdf.rect(margin, yPos - 3.5, pageWidth - margin * 2, sectionRowHeight, 'F');
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(6.5);
          pdf.setTextColor(primaryColor.r, primaryColor.g, primaryColor.b);
          pdf.text(sectionName, margin + 3, yPos + 0.5);
          tableRowCount = 0;
          yPos += sectionRowHeight;
          return; // Don't add more to yPos
        } else if (isHeader) {
          // Table header row - Remove "Metric" from first column
          pdf.setFillColor(tableHeaderBg.r, tableHeaderBg.g, tableHeaderBg.b);
          pdf.rect(margin, yPos - 3, pageWidth - margin * 2, rowHeight, 'F');
          pdf.setTextColor(255, 255, 255);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(6);
          
          let xPos = margin;
          cells.forEach((cell, idx) => {
            const cellWidth = colWidths[idx];
            // Skip "Metric" in first column header
            const displayCell = idx === 0 ? '' : cell;
            if (idx === 0) {
              pdf.text(displayCell, xPos + 2, yPos);
            } else {
              pdf.text(displayCell, xPos + cellWidth - 1, yPos, { align: 'right' });
            }
            xPos += cellWidth;
          });
          pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        } else {
          // Data row with zebra striping
          if (tableRowCount % 2 === 1) {
            pdf.setFillColor(lightGray.r, lightGray.g, lightGray.b);
            pdf.rect(margin, yPos - 3, pageWidth - margin * 2, rowHeight, 'F');
          }
          pdf.setTextColor(darkText.r, darkText.g, darkText.b);
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(6);
          
          let xPos = margin;
          cells.forEach((cell, idx) => {
            const cellWidth = colWidths[idx];
            if (idx === 0) {
              pdf.text(cell, xPos + 2, yPos);
            } else {
              // Highlight negative values in bold red
              if (highlightValue && cell.startsWith('-')) {
                pdf.setTextColor(negativeRed.r, negativeRed.g, negativeRed.b);
                pdf.setFont('helvetica', 'bold');
              }
              pdf.text(cell, xPos + cellWidth - 1, yPos, { align: 'right' });
              pdf.setTextColor(darkText.r, darkText.g, darkText.b);
              pdf.setFont('helvetica', 'normal');
            }
            xPos += cellWidth;
          });
          tableRowCount++;
        }

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(6);
        yPos += rowHeight;
      };

      // ========== SMART PAGE BREAK LOGIC ==========
      // Pre-calculate total height needed for projections table + summary box
      // This helps us decide if we need to start the table on a new page
      const summaryBoxHeight = 16;
      const summarySpacing = 4;
      
      // Calculate approximate table height:
      // - 1 header row + 5 data rows + 4 section rows + remaining data rows
      // Total rows: header(1) + data(5) + section(STATISTICS) + data(5) + section(CASH) + data(7) + section(NON-CASH) + data(1) + section(SUMMARY) + data(5) = ~24 rows + 4 sections
      const totalDataRows = 23; // Regular data rows
      const totalSectionRows = 4; // Section header rows
      const headerRowHeight = rowHeight;
      const estimatedTableHeight = headerRowHeight + (totalDataRows * rowHeight) + (totalSectionRows * (sectionRowHeight + 1));
      const estimatedTotalHeight = estimatedTableHeight + summarySpacing + summaryBoxHeight;
      
      // Calculate year 10 values early for summary
      const year10 = projections[10];
      const totalCashFlow = projections.slice(1).reduce((sum, p) => sum + p.afterTaxCashFlowPA, 0);
      const capitalGain = year10.propertyMarketValue - baseFinancialData.purchasePrice;
      
      // If everything won't fit on remaining space of page 1, check if it fits at all on a fresh page
      const remainingSpaceOnPage = contentMaxY - yPos;
      const freshPageSpace = contentMaxY - margin - 5;
      
      // If table + summary won't fit in remaining space but will fit on a fresh page, continue
      // The drawRow function will handle individual row page breaks
      // Key: We just need to ensure summary box can stay with at least some of the table
      
      // Draw table - headers without "Metric"
      const headers = ['', 'Today', 'Yr 1', 'Yr 2', 'Yr 3', 'Yr 4', 'Yr 5', 'Yr 6', 'Yr 7', 'Yr 8', 'Yr 9', 'Yr 10'];
      drawRow(headers, true);

      // Helper to safely get projection data - ensures all 10 years have values
      const getYearData = (yearIndex: number) => projections[yearIndex] || projections[projections.length - 1];
      const years1to10 = Array.from({ length: 10 }, (_, i) => getYearData(i + 1));

      drawRow(['Capital Growth %', '', ...years1to10.map(p => p.capitalGrowthRate.toFixed(1))]);
      drawRow(['CPI Growth %', '', ...years1to10.map(p => p.cpiGrowthRate.toFixed(1))]);
      drawRow(['Property Value $', formatCurrency(projections[0].propertyMarketValue), ...years1to10.map(p => formatCurrency(p.propertyMarketValue))]);
      drawRow(['Purchase Price $', formatCurrency(baseFinancialData.purchasePrice), ...Array(10).fill('')]);
      drawRow(['Loan Amount $', formatCurrency(projections[0].loanAmount), ...years1to10.map(p => formatCurrency(p.loanAmount))]);
      
      drawRow(['STATISTICS'], false, true);
      drawRow(['Equity $', formatCurrency(projections[0].equityInProperty), ...years1to10.map(p => formatCurrency(p.equityInProperty))]);
      drawRow(['LVR %', projections[0].loanToValueRatio.toFixed(1), ...years1to10.map(p => p.loanToValueRatio.toFixed(1))]);
      drawRow(['Rental Income $', `${formatCurrency(baseFinancialData.weeklyRent)}pw`, ...years1to10.map(p => formatCurrency(p.rentalIncome))]);
      drawRow(['Gross Yield %', '', ...years1to10.map(p => p.grossYield.toFixed(2))]);
      drawRow(['Net Yield %', '', ...years1to10.map(p => p.netYield.toFixed(2))]);
      
      drawRow(['CASH DEDUCTIONS'], false, true);
      drawRow(['Property Expenses $', '$0', ...years1to10.map(p => formatCurrency(p.propertyExpenses))]);
      drawRow(['Land Tax $', '', ...years1to10.map(p => formatCurrency(p.landTax))]);
      drawRow(['Interest Rate %', '', ...years1to10.map(p => p.interestRate.toFixed(2))]);
      drawRow(['Interest Payments $', '$0', ...years1to10.map(p => formatCurrency(p.interestPayments))]);
      drawRow(['Principal Payments $', formatCurrency(projections[0].principalPayments), ...years1to10.map(p => formatCurrency(p.principalPayments))]);
      drawRow(['Pre-Tax Cash Flow p/a $', '', ...years1to10.map(p => formatCurrency(p.preTaxCashFlowPA))], false, false, true);
      drawRow(['Pre-Tax Cash Flow p/w $', '', ...years1to10.map(p => formatCurrency(p.preTaxCashFlowPW))], false, false, true);
      
      drawRow(['NON-CASH DEDUCTIONS'], false, true);
      drawRow(['Depreciation $', '', ...years1to10.map(p => formatCurrency(p.depreciation))]);
      
      // Mid-table page break suppressed - table must stay on single page.

      
      drawRow(['SUMMARY'], false, true);
      drawRow(['Total Deductions $', '', ...years1to10.map(p => formatCurrency(p.totalDeductions))]);
      drawRow(['Net Profit/Loss $', '', ...years1to10.map(p => formatCurrency(p.netProfitLoss))], false, false, true);
      drawRow(['Tax Refund $', '', ...years1to10.map(p => formatCurrency(p.taxRefund))]);
      drawRow(['After-Tax Cash Flow p/a $', '', ...years1to10.map(p => formatCurrency(p.afterTaxCashFlowPA))], false, false, true);
      drawRow(['After-Tax Cash Flow p/w $', '', ...years1to10.map(p => formatCurrency(p.afterTaxCashFlowPW))], false, false, true);

      // ========== 10-YEAR SUMMARY CARDS ==========
      yPos += summarySpacing + 4;
      
      // Increased height for card layout with label + value
      const summaryCardHeight = 22;
      
      // Final check - if summary cards would overflow, add page
      if (yPos + summaryCardHeight + 8 > contentMaxY) {
        pdf.addPage();
        yPos = margin + 10;
      }

      // Section title
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(45, 55, 72); // Dark slate text
      pdf.text('10-Year Investment Summary', margin, yPos);
      yPos += 6;

      // Card styling - dark blue background with white text
      const darkBlue = { r: 45, g: 55, b: 72 }; // #2d3748 - dark slate blue
      const summaryContentWidth = pageWidth - margin * 2;
      const summaryCardGap = 3;
      const summaryCardWidth = (summaryContentWidth - (summaryCardGap * 3)) / 4;

      // Summary data for 4 cards
      const summaryCards = [
        { label: 'Property Value', value: formatCurrency(year10.propertyMarketValue) },
        { label: 'Total Equity', value: formatCurrency(year10.equityInProperty) },
        { label: 'Capital Gain', value: formatCurrency(capitalGain) },
        { label: 'Total After-Tax Cash Flow', value: formatCurrency(totalCashFlow) }
      ];

      // Draw each card
      summaryCards.forEach((card, index) => {
        const cardX = margin + (index * (summaryCardWidth + summaryCardGap));
        
        // Card background - dark blue with rounded corners
        pdf.setFillColor(darkBlue.r, darkBlue.g, darkBlue.b);
        pdf.roundedRect(cardX, yPos, summaryCardWidth, summaryCardHeight, 2, 2, 'F');
        
        // Label - small white text at top
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(200, 200, 210); // Light gray for label
        pdf.text(card.label, cardX + 4, yPos + 7);
        
        // Value - larger white bold text below
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(255, 255, 255); // White for value
        pdf.text(card.value, cardX + 4, yPos + 16);
      });
      
      yPos += summaryCardHeight;

      // ========== CHARTS & VISUAL ANALYSIS PAGE ==========

      // Helper: draw an annotation/insight box below a chart
      const drawInsightBox = (text: string, xPos: number, boxWidth: number) => {
        const insightPadding = 4;
        const lines = pdf.splitTextToSize(text, boxWidth - insightPadding * 2);
        const boxHeight = lines.length * 3.5 + insightPadding * 2;
        
        // Subtle background with left accent
        pdf.setFillColor(254, 249, 235); // warm cream
        pdf.roundedRect(xPos, yPos, boxWidth, boxHeight, 1.5, 1.5, 'F');
        pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
        pdf.rect(xPos, yPos + 1, 2, boxHeight - 2, 'F');
        
        pdf.setFontSize(6.5);
        pdf.setFont('helvetica', 'italic');
        pdf.setTextColor(80, 70, 50);
        pdf.text(lines, xPos + insightPadding + 2, yPos + insightPadding + 2);
        
        yPos += boxHeight + 4;
      };

      // Helper: draw a chart section title with caption
      const drawChartTitle = (title: string, caption: string) => {
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        pdf.text(title, margin, yPos);
        yPos += 4;
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(grayText.r, grayText.g, grayText.b);
        pdf.text(caption, margin, yPos);
        yPos += 5;
      };

      // Helper: draw a programmatic line chart using jsPDF when html2canvas fails
      const drawProgrammaticTrendsChart = (
        chartX: number, chartY: number, chartW: number, chartH: number,
        data: YearlyProjection[]
      ) => {
        const years = data.filter(p => p.year >= 1);
        if (years.length === 0) return;

        const innerPadding = { top: 14, bottom: 20, left: 32, right: 10 };
        const plotX = chartX + innerPadding.left;
        const plotY = chartY + innerPadding.top;
        const plotW = chartW - innerPadding.left - innerPadding.right;
        const plotH = chartH - innerPadding.top - innerPadding.bottom;

        // Background with subtle shadow effect
        pdf.setFillColor(252, 252, 253);
        pdf.roundedRect(chartX, chartY, chartW, chartH, 3, 3, 'F');
        pdf.setDrawColor(220, 220, 225);
        pdf.setLineWidth(0.4);
        pdf.roundedRect(chartX, chartY, chartW, chartH, 3, 3, 'S');

        // Series definitions with improved colors
        const series = [
          { label: 'Property Value', color: { r: 37, g: 99, b: 235 }, getData: (p: YearlyProjection) => p.propertyMarketValue },
          { label: 'Equity', color: { r: 16, g: 185, b: 129 }, getData: (p: YearlyProjection) => p.equityInProperty },
          { label: 'Loan Balance', color: { r: 239, g: 68, b: 68 }, getData: (p: YearlyProjection) => p.loanAmount },
          { label: 'Cash Flow (p.a.)', color: { r: 139, g: 92, b: 246 }, getData: (p: YearlyProjection) => p.afterTaxCashFlowPA },
        ];

        // Calculate global min/max across all series
        let globalMin = Infinity, globalMax = -Infinity;
        for (const s of series) {
          for (const p of years) {
            const v = s.getData(p);
            if (v < globalMin) globalMin = v;
            if (v > globalMax) globalMax = v;
          }
        }
        // Add 5% padding to range
        const rawRange = globalMax - globalMin || 1;
        globalMin -= rawRange * 0.05;
        globalMax += rawRange * 0.05;
        const range = globalMax - globalMin;

        // Draw horizontal grid lines with labels
        pdf.setDrawColor(235, 235, 240);
        pdf.setLineWidth(0.15);
        for (let i = 0; i <= 5; i++) {
          const gy = plotY + plotH - (i / 5) * plotH;
          pdf.line(plotX, gy, plotX + plotW, gy);
          const val = globalMin + (i / 5) * range;
          pdf.setFontSize(5.5);
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(130, 130, 140);
          const label = Math.abs(val) >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : Math.abs(val) >= 1000 ? `$${(val / 1000).toFixed(0)}K` : `$${val.toFixed(0)}`;
          pdf.text(label, plotX - 3, gy + 1.5, { align: 'right' });
        }

        // Draw x-axis labels
        const stepX = plotW / (years.length - 1 || 1);
        years.forEach((p, i) => {
          pdf.setFontSize(5.5);
          pdf.setTextColor(130, 130, 140);
          pdf.text(`Yr ${p.year}`, plotX + i * stepX, plotY + plotH + 6, { align: 'center' });
        });

        // Draw each series as a line with thicker stroke
        for (const s of series) {
          pdf.setDrawColor(s.color.r, s.color.g, s.color.b);
          pdf.setLineWidth(0.9);
          for (let i = 1; i < years.length; i++) {
            const x1 = plotX + (i - 1) * stepX;
            const x2 = plotX + i * stepX;
            const y1 = plotY + plotH - ((s.getData(years[i - 1]) - globalMin) / range) * plotH;
            const y2 = plotY + plotH - ((s.getData(years[i]) - globalMin) / range) * plotH;
            pdf.line(x1, y1, x2, y2);
          }
          // Draw dots at each data point
          for (let i = 0; i < years.length; i++) {
            const cx = plotX + i * stepX;
            const cy = plotY + plotH - ((s.getData(years[i]) - globalMin) / range) * plotH;
            pdf.setFillColor(255, 255, 255);
            pdf.circle(cx, cy, 1.2, 'F');
            pdf.setFillColor(s.color.r, s.color.g, s.color.b);
            pdf.circle(cx, cy, 0.9, 'F');
          }
          // End-point data label (Yr 10 value)
          const lastYear = years[years.length - 1];
          const lastVal = s.getData(lastYear);
          const lastCx = plotX + (years.length - 1) * stepX;
          const lastCy = plotY + plotH - ((lastVal - globalMin) / range) * plotH;
          pdf.setFontSize(5);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(s.color.r, s.color.g, s.color.b);
          const endLabel = Math.abs(lastVal) >= 1000000 ? `$${(lastVal / 1000000).toFixed(1)}M` : Math.abs(lastVal) >= 1000 ? `$${(lastVal / 1000).toFixed(0)}K` : `$${lastVal.toFixed(0)}`;
          pdf.text(endLabel, lastCx + 2, lastCy - 2);
        }

        // Legend bar at bottom
        let legendX = plotX;
        const legendY = chartY + chartH - 5;
        pdf.setFontSize(5.5);
        for (const s of series) {
          // Color circle instead of rectangle
          pdf.setFillColor(s.color.r, s.color.g, s.color.b);
          pdf.circle(legendX + 1.5, legendY - 0.5, 1.5, 'F');
          pdf.setTextColor(60, 60, 70);
          pdf.setFont('helvetica', 'normal');
          pdf.text(s.label, legendX + 4.5, legendY, { align: 'left' });
          legendX += pdf.getTextWidth(s.label) + 12;
        }
      };

      // Helper: draw a programmatic yield chart
      const drawProgrammaticYieldChart = (
        chartX: number, chartY: number, chartW: number, chartH: number,
        data: YearlyProjection[]
      ) => {
        const years = data.filter(p => p.year >= 1);
        if (years.length === 0) return;

        const innerPadding = { top: 14, bottom: 20, left: 28, right: 10 };
        const plotX = chartX + innerPadding.left;
        const plotY = chartY + innerPadding.top;
        const plotW = chartW - innerPadding.left - innerPadding.right;
        const plotH = chartH - innerPadding.top - innerPadding.bottom;

        pdf.setFillColor(252, 252, 253);
        pdf.roundedRect(chartX, chartY, chartW, chartH, 3, 3, 'F');
        pdf.setDrawColor(220, 220, 225);
        pdf.setLineWidth(0.4);
        pdf.roundedRect(chartX, chartY, chartW, chartH, 3, 3, 'S');

        const yieldSeries = [
          { label: 'Gross Yield %', color: { r: 16, g: 185, b: 129 }, getData: (p: YearlyProjection) => p.grossYield },
          { label: 'Net Yield %', color: { r: 239, g: 68, b: 68 }, getData: (p: YearlyProjection) => p.netYield },
        ];

        let yMin = Infinity, yMax = -Infinity;
        for (const s of yieldSeries) {
          for (const p of years) {
            const v = s.getData(p);
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
          }
        }
        // Add padding
        const rawYRange = yMax - yMin || 1;
        yMin -= rawYRange * 0.1;
        yMax += rawYRange * 0.1;
        const yRange = yMax - yMin;
        const stepX = plotW / (years.length - 1 || 1);

        // Grid
        pdf.setDrawColor(235, 235, 240);
        pdf.setLineWidth(0.15);
        for (let i = 0; i <= 4; i++) {
          const gy = plotY + plotH - (i / 4) * plotH;
          pdf.line(plotX, gy, plotX + plotW, gy);
          const val = yMin + (i / 4) * yRange;
          pdf.setFontSize(5.5);
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(130, 130, 140);
          pdf.text(`${val.toFixed(1)}%`, plotX - 3, gy + 1.5, { align: 'right' });
        }

        years.forEach((p, i) => {
          pdf.setFontSize(5.5);
          pdf.setTextColor(130, 130, 140);
          pdf.text(`Yr ${p.year}`, plotX + i * stepX, plotY + plotH + 6, { align: 'center' });
        });

        for (const s of yieldSeries) {
          pdf.setDrawColor(s.color.r, s.color.g, s.color.b);
          pdf.setLineWidth(0.9);
          for (let i = 1; i < years.length; i++) {
            const x1 = plotX + (i - 1) * stepX;
            const x2 = plotX + i * stepX;
            const y1 = plotY + plotH - ((s.getData(years[i - 1]) - yMin) / yRange) * plotH;
            const y2 = plotY + plotH - ((s.getData(years[i]) - yMin) / yRange) * plotH;
            pdf.line(x1, y1, x2, y2);
          }
          for (let i = 0; i < years.length; i++) {
            const cx = plotX + i * stepX;
            const cy = plotY + plotH - ((s.getData(years[i]) - yMin) / yRange) * plotH;
            pdf.setFillColor(255, 255, 255);
            pdf.circle(cx, cy, 1.2, 'F');
            pdf.setFillColor(s.color.r, s.color.g, s.color.b);
            pdf.circle(cx, cy, 0.9, 'F');
          }
          // End-point label
          const lastYear = years[years.length - 1];
          const lastVal = s.getData(lastYear);
          const lastCx = plotX + (years.length - 1) * stepX;
          const lastCy = plotY + plotH - ((lastVal - yMin) / yRange) * plotH;
          pdf.setFontSize(5);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(s.color.r, s.color.g, s.color.b);
          pdf.text(`${lastVal.toFixed(2)}%`, lastCx + 2, lastCy - 2);
        }

        let legendX = plotX;
        const legendY = chartY + chartH - 5;
        pdf.setFontSize(5.5);
        for (const s of yieldSeries) {
          pdf.setFillColor(s.color.r, s.color.g, s.color.b);
          pdf.circle(legendX + 1.5, legendY - 0.5, 1.5, 'F');
          pdf.setTextColor(60, 60, 70);
          pdf.setFont('helvetica', 'normal');
          pdf.text(s.label, legendX + 4.5, legendY, { align: 'left' });
          legendX += pdf.getTextWidth(s.label) + 12;
        }
      };

      // Determine if we should show charts (either captured or fallback)
      const shouldShowTrends = activeChartToggles.cashFlowTrends;
      const shouldShowYield = activeChartToggles.yieldChart;
      const shouldShowComparison = activeChartToggles.comparisonChart && comparisonChartImage;
      const hasAnyChart = shouldShowTrends || shouldShowYield || shouldShowComparison;
      
      if (hasAnyChart) {
        pdf.addPage();
        yPos = 0;
        
        // Professional header bar
        pdf.setFillColor(45, 55, 72); // Dark slate
        pdf.rect(0, 0, pageWidth, 14, 'F');
        pdf.setFillColor(primaryColor.r, primaryColor.g, primaryColor.b);
        pdf.rect(0, 14, pageWidth, 1.5, 'F'); // Gold accent line
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(255, 255, 255);
        pdf.text('Visual & Technical Analysis', margin, 9);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(200, 200, 210);
        pdf.text('Projected trends and performance metrics over the 10-year investment horizon', margin, 13);
        
        yPos = 22;
        const chartWidth = pageWidth - margin * 2;
        
        // Pre-compute insight data for annotations
        const yr1 = projections[1];
        const yr10Data = projections[10] || projections[projections.length - 1];
        const propertyGrowthPct = ((yr10Data.propertyMarketValue - baseFinancialData.purchasePrice) / baseFinancialData.purchasePrice * 100).toFixed(1);
        const equityGrowthPct = yr1?.equityInProperty > 0 ? ((yr10Data.equityInProperty - yr1.equityInProperty) / yr1.equityInProperty * 100).toFixed(1) : 'N/A';
        const loanReductionPct = projections[0]?.loanAmount > 0 ? ((1 - yr10Data.loanAmount / projections[0].loanAmount) * 100).toFixed(1) : '0';
        
        // Cash Flow Trends Chart
        if (shouldShowTrends) {
          const chartHeight = 75;
          drawChartTitle(
            '10-Year Cash Flow Trends',
            'Tracks property value appreciation, equity growth, loan reduction, and annual after-tax cash flow over the projection period.'
          );
          
          if (cashFlowChartImage) {
            pdf.setDrawColor(220, 220, 225);
            pdf.setLineWidth(0.4);
            pdf.roundedRect(margin, yPos, chartWidth, chartHeight, 3, 3, 'S');
            pdf.addImage(cashFlowChartImage, 'PNG', margin + 2, yPos + 2, chartWidth - 4, chartHeight - 4);
          } else {
            drawProgrammaticTrendsChart(margin, yPos, chartWidth, chartHeight, projections);
          }
          yPos += chartHeight + 3;
          
          // Insight annotation — detailed financial narrative
          const yr1CashFlow = yr1?.afterTaxCashFlowPA || 0;
          const yr10CashFlow = yr10Data.afterTaxCashFlowPA;
          const cashFlowImproved = yr10CashFlow > yr1CashFlow;
          const cashFlowDelta = formatCurrency(Math.abs(yr10CashFlow - yr1CashFlow));
          const breakEvenYr = projections.filter(p => p.year >= 1).find((p, i, arr) => i > 0 && arr[i - 1].afterTaxCashFlowPA < 0 && p.afterTaxCashFlowPA >= 0);
          const crossoverYr = projections.filter(p => p.year >= 1).find(p => p.equityInProperty >= p.loanAmount);
          
          let trendInsight = `Property Value Growth: The property is projected to appreciate by ${propertyGrowthPct}% over the 10-year horizon, growing from ${formatCurrency(baseFinancialData.purchasePrice)} to ${formatCurrency(yr10Data.propertyMarketValue)}. This represents an average annual compound growth aligned with the configured capital growth assumptions.\n\n`;
          trendInsight += `Equity Accumulation: Equity increases by ${equityGrowthPct}% (from ${formatCurrency(yr1?.equityInProperty || 0)} to ${formatCurrency(yr10Data.equityInProperty)}), driven by both capital appreciation and principal repayments reducing the outstanding loan balance by ${loanReductionPct}%.\n\n`;
          trendInsight += `Cash Flow Trajectory: After-tax cash flow ${cashFlowImproved ? 'improves' : 'declines'} by ${cashFlowDelta} over the period (Year 1: ${formatCurrency(yr1CashFlow)} → Year 10: ${formatCurrency(yr10CashFlow)} p.a.).`;
          if (breakEvenYr) trendInsight += ` The investment reaches cash-flow positive in Year ${breakEvenYr.year}, marking the transition from negatively-geared to self-sustaining.`;
          if (crossoverYr) trendInsight += ` Equity surpasses the remaining loan balance in Year ${crossoverYr.year}, a key wealth-building milestone indicating the investor holds majority ownership of the asset.`;
          
          drawInsightBox(trendInsight, margin, chartWidth);
        }
        
        // Yield Chart
        if (shouldShowYield) {
          if (yPos > contentMaxY - 85) {
            pdf.addPage();
            yPos = margin + 5;
          }
          
          const chartHeight = 65;
          const yr1Gross = yr1?.grossYield?.toFixed(2) || '-';
          const yr10Gross = yr10Data?.grossYield?.toFixed(2) || '-';
          const yr1Net = yr1?.netYield?.toFixed(2) || '-';
          const yr10Net = yr10Data?.netYield?.toFixed(2) || '-';
          
          drawChartTitle(
            'Yield Analysis',
            'Compares gross and net rental yield percentages relative to current market value, illustrating yield compression as property values grow.'
          );
          
          if (yieldChartImage) {
            pdf.setDrawColor(220, 220, 225);
            pdf.setLineWidth(0.4);
            pdf.roundedRect(margin, yPos, chartWidth, chartHeight, 3, 3, 'S');
            pdf.addImage(yieldChartImage, 'PNG', margin + 2, yPos + 2, chartWidth - 4, chartHeight - 4);
          } else {
            drawProgrammaticYieldChart(margin, yPos, chartWidth, chartHeight, projections);
          }
          yPos += chartHeight + 3;
          
          // Yield insight — detailed
          const grossDelta = (parseFloat(yr10Gross) - parseFloat(yr1Gross)).toFixed(2);
          const netDelta = (parseFloat(yr10Net) - parseFloat(yr1Net)).toFixed(2);
          const avgSpread = projections.filter(p => p.year >= 1).reduce((s, p) => s + (p.grossYield - p.netYield), 0) / 10;
          
          let yieldInsight = `Gross Yield: Moves from ${yr1Gross}% (Year 1) to ${yr10Gross}% (Year 10), a shift of ${grossDelta} percentage points. This compression occurs because property value appreciates faster than rental income, which is a hallmark of capital-growth-oriented investment properties.\n\n`;
          yieldInsight += `Net Yield: Shifts from ${yr1Net}% to ${yr10Net}% (${netDelta}pp change). Net yield accounts for property expenses including council rates, insurance, maintenance, and management fees, providing a more accurate picture of actual return on asset value.\n\n`;
          yieldInsight += `Expense Drag: The average spread between gross and net yield is ${avgSpread.toFixed(2)} percentage points, representing the proportion of rental income consumed by holding costs. A narrowing spread over time indicates improving operational efficiency as rental growth outpaces expense inflation.`;
          
          drawInsightBox(yieldInsight, margin, chartWidth);
        }
        
        // Comparison Chart
        if (shouldShowComparison && comparisonChartImage) {
          if (yPos > contentMaxY - 80) {
            pdf.addPage();
            yPos = margin + 5;
          }
          
          const chartHeight = 65;
          drawChartTitle(
            'Multi-Property Comparison',
            'Side-by-side performance analysis of selected properties across key financial indicators for comparative assessment.'
          );
          
          pdf.setDrawColor(220, 220, 225);
          pdf.setLineWidth(0.4);
          pdf.roundedRect(margin, yPos, chartWidth, chartHeight, 3, 3, 'S');
          pdf.addImage(comparisonChartImage, 'PNG', margin + 2, yPos + 2, chartWidth - 4, chartHeight - 4);
          yPos += chartHeight + 3;
          
          drawInsightBox('Multi-Property Comparison: This chart presents a side-by-side analysis of property value trajectories across selected investment properties. By overlaying growth curves, investors can visually identify which assets offer superior capital appreciation potential, assess relative risk profiles, and make data-driven portfolio allocation decisions. Properties with steeper upward curves indicate stronger projected growth, while convergence or divergence patterns reveal market segment dynamics.', margin, chartWidth);
        }
      }

      // ========== CONTACT / DISCLAIMER PAGE (Last Page) ==========
      const globalSettings = await fetchGlobalReportSettings();
      drawJsPDFDisclaimerPage(pdf, globalSettings.contactDetails, globalSettings.disclaimer);

      // ========== FOOTER (on content pages only, skip cover and contact pages) ==========
      const totalPages = pdf.getNumberOfPages();
      const coverPageIndex = 1;
      const contactPageIndex = totalPages;
      
      for (let i = 1; i <= totalPages; i++) {
        pdf.setPage(i);
        
        // Skip cover page (first) and contact page (last)
        if (i === coverPageIndex || i === contactPageIndex) {
          continue;
        }
        
        // Footer separator line and disclaimer — skip on first content page
        // so the construction schedule table renders without overlap
        if (i !== coverPageIndex + 1) {
          pdf.setDrawColor(mediumGray.r, mediumGray.g, mediumGray.b);
          pdf.setLineWidth(0.5);
          pdf.line(margin, contentMaxY + 2, pageWidth - margin, contentMaxY + 2);

          pdf.setFontSize(6.5);
          pdf.setFont('helvetica', 'italic');
          pdf.setTextColor(grayText.r, grayText.g, grayText.b);
          const disclaimerLinesFooter = pdf.splitTextToSize(templateConfig.disclaimer, pageWidth - margin * 2.5);
          pdf.text(disclaimerLinesFooter, pageWidth / 2, contentMaxY + 8, { align: 'center' });
        }

        
        // Contact info and page number at very bottom
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(darkText.r, darkText.g, darkText.b);
        pdf.text(`${templateConfig.contactEmail}  •  ${templateConfig.website}`, pageWidth / 2, pageHeight - 6, { align: 'center' });
        
        // Page number (content pages start from 1, excluding cover)
        const contentPageNum = i - 1; // Exclude cover page from count
        const totalContentPages = totalPages - 2; // Exclude cover and contact pages
        pdf.setFontSize(7);
        pdf.setTextColor(grayText.r, grayText.g, grayText.b);
        pdf.text(`Page ${contentPageNum} of ${totalContentPages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
      }

      // If returnBlob requested, return the blob without saving to disk
      if (options?.returnBlob) {
        return pdf.output('blob');
      }

      // Save PDF - use cleaned address for filename
      const cleanedAddressForFile = report.property_address.replace(/[_\s]?Copy[_\s]?\d*$/i, '').trim();
      const fileName = `Cash_Flow_10Year_${cleanedAddressForFile.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      pdf.save(fileName);

      toast({
        title: "PDF Exported",
        description: "10-year cash flow analysis PDF has been downloaded.",
      });
    } catch (error) {
      console.error('Error exporting PDF:', error);
      toast({
        title: "Export Failed",
        description: "Failed to export PDF. Please try again.",
        variant: "destructive"
      });
    }
  }, [report, baseFinancialData, projections, includeInputsSummaryInExport, includeConstructionScheduleInExport, constructionProgressSchedule, isNewBuild, chartExportToggles, excludeLandTaxFromCashFlow, toast]);

  // Generate PDF and upload to storage (for Send to Client)
  const generateAndUploadCashFlowPDF = useCallback(async (chartOverrides?: { cashFlowTrends: boolean; yieldChart: boolean; comparisonChart: boolean }): Promise<string | null> => {
    if (!report || !baseFinancialData) return null;

    try {
      // Use the full PDF generator in blob mode, with optional chart overrides from Send to Client
      const pdfBlob = await exportSingleReportPDF({ returnBlob: true, chartOverrides });
      if (!pdfBlob || !(pdfBlob instanceof Blob)) {
        console.error('PDF generation returned no blob');
        return null;
      }

      const cleanedAddress = report.property_address.replace(/[_\s]?Copy[_\s]?\d*$/i, '').trim();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `cashflow-analysis/${report.id}/${timestamp}_Cash_Flow_${cleanedAddress.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      const file = new File([pdfBlob], fileName.split('/').pop() || 'cashflow.pdf', { type: 'application/pdf' });

      const uploadResult = await secureStorageUpload('investment-reports', fileName, file, {
        contentType: 'application/pdf',
      });

      if (uploadResult?.success && uploadResult.path) {
        setCashFlowStoragePath(uploadResult.path);
        return uploadResult.path;
      }
      return null;
    } catch (error) {
      console.error('Error generating cash flow PDF for upload:', error);
      return null;
    }
  }, [report, baseFinancialData, exportSingleReportPDF]);

  /**
   * The typeset PDF — built here, rendered by WeasyPrint, stored and signed.
   *
   * The projection that crosses the wire is the one on screen, unsaved
   * overrides included, because that is the ten years the adviser just
   * reviewed. See `requestCashFlowPdf` for why the server does not recompute
   * it.
   *
   * `exportSingleReportPDF` is passed as the fallback and is *only* reached
   * when the route is not deployed. It stays in the menu in its own right.
   */
  /**
   * The comparison as the render route wants it, or null when there is not one.
   *
   * Built at press time rather than held in state, for the reason
   * `requestCashFlowPdf` gives about the single-property document: the
   * projections on screen include overrides the adviser has not saved, and those
   * are the ten years they just reviewed.
   *
   * The written analysis rides along if there is one and is simply absent if
   * there is not. Unlike `exportAiAnalysisPDF`, this path does not require it.
   */
  const buildWireComparison = useCallback((): WireComparison | null => {
    if (!report || projections.length < 2) return null;
    const peers = allComparisonProjections
      .filter(({ projections: peerYears }) => peerYears.length > 1)
      .map(({ report: peerReport, projections: peerYears }) => ({
        report: peerReport,
        projections: peerYears,
      }));
    if (!peers.length) return null;

    const currentYear = new Date().getFullYear();
    return toWireComparison({
      primary: { report, projections },
      peers,
      investorProfile,
      analysis: aiAnalysis,
      firstCalendarYear: currentYear + 1,
      currentYear,
    });
  }, [report, projections, allComparisonProjections, investorProfile, aiAnalysis]);

  const comparisonUnavailableReason = comparisonReports.length === 0
    ? 'Add at least one comparison property first.'
    : undefined;

  const exportServerCashFlowPDF = useCallback(async () => {
    if (!report || !baseFinancialData || !projections.length) return;
    if (isExportingServerPdf) return;

    setIsExportingServerPdf(true);
    try {
      const wire = toWireProjection({
        projections,
        base: baseFinancialData,
        firstCalendarYear: new Date().getFullYear() + 1,
        notes: baseFinancialData.includeDepreciationInCashFlow
          ? []
          : ['Depreciation is excluded from this projection at the adviser\'s direction.'],
      });

      // The template path always renders the series on screen. When it is the
      // stored series, `matchStoredScenario` names the scenario and the
      // document says "Moderate"; when the adviser has overridden anything,
      // the same wire this composer call sends is handed to the adapter as
      // `payload` and the document says "Adviser-reviewed" — never a scenario
      // label the series does not satisfy. Before the payload channel existed
      // the choice applied only in the matched case, which for this format is
      // the exception: the modal recomputes ten years live, so a chosen
      // template silently fell back to the standard layout on almost every
      // download.
      const storedScenario = matchStoredScenario(wire, report);
      const templated = await tryTemplateDocument('cashflow', report.id, {
        variant: storedScenario,
        // ALWAYS the series on screen, never a re-read.
        //
        // The payload used to be sent only when the screen and the store
        // disagreed. That left the matched case depending on the adapter
        // re-reading `investment_reports` — a read that can be refused (RLS
        // under this app's custom auth, a module permission, an unreachable
        // broker) and whose refusal is indistinguishable from "this record
        // cannot be templated", so the document silently came out of the
        // standard composer. Everything the template needs is already here, so
        // nothing is re-read: the ten years, the address for the title, and
        // the scenario name when `matchStoredScenario` proved one.
        payload: {
          wire,
          propertyAddress: report.property_address ?? null,
          scenario: storedScenario,
        },
      });
      if (templated) {
        saveTemplateDocument(templated);
        logActivityDirect({
          actionType: 'report_pdf_downloaded',
          entityType: 'investment_report',
          entityId: report.id,
          entityName: report.property_address,
          metadata: { format: 'pdf', source: 'cash_flow_template', scenario: storedScenario },
        });
        toast({
          title: 'Cash Flow Analysis ready',
          description: 'Your download should begin shortly.',
        });
        return;
      }

      const result = await requestCashFlowPdf(
        { reportId: report.id, projection: wire },
        async () => {
          const blob = await exportSingleReportPDF({ returnBlob: true });
          if (!blob || !(blob instanceof Blob)) return null;
          // The legacy generator hands back bytes rather than a link, so the
          // download happens here and the caller is told which one it got.
          const url = URL.createObjectURL(blob);
          const fileName = `Cash_Flow_Analysis_${(report.property_address || 'report').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return { url, fileName, bytes: blob.size };
        },
      );

      if (result.source === 'server') {
        // A signed link, so the file is fetched and saved rather than opened —
        // a PDF that opens in a tab is a PDF the client has to find again.
        const res = await fetch(result.url);
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = result.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }

      logActivityDirect({
        actionType: 'report_pdf_downloaded',
        entityType: 'investment_report',
        entityId: report.id,
        entityName: report.property_address,
        metadata: { format: 'pdf', source: `cash_flow_${result.source}`, pages: result.pageCount },
      });

      // Said only to somebody it is news for: this person chose a template for
      // this format, and did not get it. The reason is specific and worth
      // hearing — their projection is not the stored one, so a template, which
      // renders what is stored, would have printed different figures from the
      // ones on screen. Without this the choice looks broken.
      const chosenTemplateUnused = !storedScenario
        && cashFlowTemplateChoice.state?.status === 'selected';
      const notes = [
        result.source === 'server'
          ? (result.brandGaps.length
            ? `Your download should begin shortly. Note: ${result.brandGaps.join('; ')}.`
            : 'Your download should begin shortly.')
          : 'The server renderer is not deployed yet, so the in-browser generator was used.',
        chosenTemplateUnused
          ? 'Your chosen template was not used: this projection includes adjustments, '
            + 'and a template prints the saved projection instead.'
          : null,
      ].filter(Boolean);

      toast({
        title: result.source === 'server' ? 'Cash Flow Analysis ready' : 'Generated with the legacy layout',
        description: notes.join(' '),
      });
    } catch (error) {
      console.error('[CashFlowAnalysisModal] server PDF failed', error);
      toast({
        title: 'Could not generate the PDF',
        description: error instanceof Error ? error.message : 'Try the legacy layout, or retry shortly.',
        variant: 'destructive',
      });
    } finally {
      setIsExportingServerPdf(false);
    }
  }, [
    report, baseFinancialData, projections, isExportingServerPdf, exportSingleReportPDF, toast,
    cashFlowTemplateChoice.state?.status,
  ]);

  // Print-friendly view in new window
  const openPrintView = useCallback(() => {
    if (!report || !baseFinancialData) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast({
        title: "Popup Blocked",
        description: "Please allow popups to open the print view.",
        variant: "destructive"
      });
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>10-Year Cash Flow Analysis - ${report.property_address}</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          h2 { font-size: 18px; color: #666; margin-bottom: 16px; }
          .meta { color: #888; font-size: 12px; margin-bottom: 24px; }
          .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
          .metric { background: #f5f5f5; padding: 16px; border-radius: 8px; }
          .metric-label { font-size: 12px; color: #666; margin-bottom: 4px; }
          .metric-value { font-size: 24px; font-weight: bold; }
          .metric-sub { font-size: 11px; color: #888; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 24px; }
          th, td { padding: 6px 8px; text-align: right; border-bottom: 1px solid #eee; }
          th { background: #3b82f6; color: white; font-weight: 600; }
          td:first-child, th:first-child { text-align: left; font-weight: 500; }
          .section-header { background: #f0f0f0; font-weight: bold; }
          .text-green { color: #16a34a; }
          .text-red { color: #dc2626; }
          .equity-row td:not(:first-child) { color: #16a34a; }
          .summary { background: #f8fafc; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
          .summary h3 { font-size: 14px; margin-bottom: 8px; }
          .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
          .summary-item { text-align: center; }
          .summary-label { font-size: 11px; color: #666; }
          .summary-value { font-size: 18px; font-weight: bold; color: #3b82f6; }
          .disclaimer { font-size: 10px; color: #888; margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; }
          @media print { 
            body { padding: 0; }
            .no-print { display: none; }
            table { page-break-inside: avoid; }
          }
          .print-btn { position: fixed; top: 20px; right: 20px; background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 500; }
          .print-btn:hover { background: #2563eb; }
        </style>
      </head>
      <body>
        <button class="print-btn no-print" onclick="window.print()">Print / Save as PDF</button>
        
        <h1>10-Year Cash Flow Analysis</h1>
        <h2>${report.property_address}</h2>
        <p class="meta">Generated: ${new Date().toLocaleDateString('en-AU')}</p>
        
        <div class="metrics">
          <div class="metric">
            <div class="metric-label">Property Value</div>
            <div class="metric-value">${formatCurrency(baseFinancialData.marketValueNow)}</div>
            <div class="metric-sub">Current market value</div>
          </div>
          <div class="metric">
            <div class="metric-label">Purchase Price</div>
            <div class="metric-value">${formatCurrency(baseFinancialData.purchasePrice)}</div>
            <div class="metric-sub">Original purchase price</div>
          </div>
          <div class="metric">
            <div class="metric-label">Loan Amount</div>
            <div class="metric-value">${formatCurrency(baseFinancialData.loanAmount)}</div>
            <div class="metric-sub">${baseFinancialData.loanToValueRatio}% LVR</div>
          </div>
          <div class="metric">
            <div class="metric-label">Weekly Rent</div>
            <div class="metric-value">${formatCurrency(baseFinancialData.weeklyRent)}</div>
            <div class="metric-sub">${formatCurrency(baseFinancialData.weeklyRent * 52)} p.a.</div>
          </div>
          <div class="metric">
            <div class="metric-label">Year 10 Value</div>
            <div class="metric-value">${formatCurrency(projections[10]?.propertyMarketValue || 0)}</div>
            <div class="metric-sub">Projected @ ${baseFinancialData.capitalGrowth}% growth</div>
          </div>
        </div>
        
        ${includeInputsSummaryInExport ? `
        <!-- Summary -->
        <div class="summary" style="margin-bottom: 24px;">
          <h3 style="margin-bottom: 4px; text-align: center; font-size: 16px; font-weight: bold; border-bottom: 2px solid #ccc; padding-bottom: 6px;">${isNewBuild ? 'New Build' : 'Existing Property'}</h3>
          <h4 style="margin-bottom: 12px; text-align: center; font-size: 14px; font-weight: bold; letter-spacing: 1px;">SUMMARY</h4>
          <table style="margin-bottom: 0; font-size: 11px;">
            <tbody>
              <tr><td style="font-weight: 500; width: 50%;">Purchase Price</td><td style="text-align: right;">${formatCurrency(baseFinancialData.purchasePrice)}</td></tr>
              ${isNewBuild ? `
              <tr><td style="font-weight: 500;">Land Price</td><td style="text-align: right;">${formatCurrency(baseFinancialData.landPrice)}</td></tr>
              <tr><td style="font-weight: 500;">Build Price</td><td style="text-align: right;">${formatCurrency(baseFinancialData.buildPrice || (baseFinancialData.purchasePrice - baseFinancialData.landPrice))}</td></tr>
              ` : `
              <tr><td style="font-weight: 500;">Deposit Value</td><td style="text-align: right;">${formatCurrency(baseFinancialData.depositValue || (baseFinancialData.purchasePrice * (1 - baseFinancialData.loanToValueRatio / 100)))}</td></tr>
              `}
              <tr><td style="font-weight: 500;">Loan to Value ratio</td><td style="text-align: right;">${baseFinancialData.loanToValueRatio}%</td></tr>
              <tr><td style="font-weight: 500;">Interest Rate</td><td style="text-align: right;">${baseFinancialData.interestRate.toFixed(2)}%</td></tr>
              <tr><td style="font-weight: 500;">Capital Growth</td><td style="text-align: right;">${baseFinancialData.capitalGrowth}%</td></tr>
              <tr><td style="font-weight: 500;">Weekly Rent</td><td style="text-align: right;">${formatCurrency(baseFinancialData.weeklyRent)}</td></tr>
              <tr><td style="font-weight: 500;">Stamp Duty</td><td style="text-align: right;">${formatCurrency(baseFinancialData.stampDuty)}</td></tr>
              <tr><td style="font-weight: 500;">Body Corporate / Strata Fees</td><td style="text-align: right;">${formatCurrency(baseFinancialData.bodyCorporateFees)}</td></tr>
              <tr><td style="font-weight: 500;">Council Rate Charges</td><td style="text-align: right;">${formatCurrency(baseFinancialData.councilRates)}</td></tr>
              <tr><td style="font-weight: 500;">Water Rate Charges (Other)</td><td style="text-align: right;">${formatCurrency(baseFinancialData.waterRates)}</td></tr>
              <tr><td style="font-weight: 500;">Solicitor Fees</td><td style="text-align: right;">${formatCurrency(baseFinancialData.solicitorFees)}</td></tr>
              <tr><td style="font-weight: 500;">Building & Landlord Insurance</td><td style="text-align: right;">${formatCurrency(baseFinancialData.buildingLandlordInsurance)}</td></tr>
              <tr><td style="font-weight: 500;">Property Management Fees</td><td style="text-align: right;">${baseFinancialData.propertyManagementFees}%</td></tr>
              <tr><td style="font-weight: 500;">Repairs & Maintenance</td><td style="text-align: right;">${formatCurrency(baseFinancialData.repairsMaintenance)}</td></tr>
              <tr><td style="font-weight: 500;">Letting Fees (1 Week Rent)</td><td style="text-align: right;">${formatCurrency(baseFinancialData.lettingFees || baseFinancialData.weeklyRent)}</td></tr>
              ${baseFinancialData.lmiAmount > 0 ? `<tr><td style="font-weight: 500;">LMI (Lenders Mortgage Insurance)</td><td style="text-align: right;">${formatCurrency(baseFinancialData.lmiAmount)}</td></tr>` : ''}
            </tbody>
          </table>
          ${(() => {
            const depositValue = baseFinancialData.depositValue || (baseFinancialData.purchasePrice * (1 - (baseFinancialData.loanToValueRatio || 80) / 100));
            const depositPct = baseFinancialData.purchasePrice > 0 ? Math.round((depositValue / baseFinancialData.purchasePrice) * 100) : 0;
            const stampDuty = baseFinancialData.stampDuty || 0;
            const solicitorFees = baseFinancialData.solicitorFees || 0;
            const agentFee = baseFinancialData.agentFee || 0;
            const lmiAmount = baseFinancialData.lmiAmount || 0;
            let upfrontRows: { label: string; value: number }[] = [];
            let overallExtraRows: { label: string; value: number }[] = [];
            let totalUpfront = 0;
            let totalOverall = 0;
            if (isNewBuild && constructionProgressSchedule) {
              const landDeposit = constructionProgressSchedule.upfrontCosts.tenPercentLand;
              const buildDeposit = constructionProgressSchedule.upfrontCosts.fivePercentBuild;
              const constructionProgressTotal = constructionProgressSchedule.buildPrice;
              const stagedInterest = constructionProgressSchedule.totals.totalCombinedRepayment;
              upfrontRows = [
                { label: '10% Land Deposit', value: landDeposit },
                { label: '5% Build Contract Deposit', value: buildDeposit },
                { label: 'Stamp Duty', value: stampDuty },
                { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
                ...(lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: lmiAmount }] : []),
              ];
              totalUpfront = landDeposit + buildDeposit + stampDuty + solicitorFees + stagedInterest + lmiAmount;
              overallExtraRows = [
                { label: 'Purchase Price (Land)', value: constructionProgressSchedule.landPrice },
                { label: 'Stamp Duty', value: stampDuty },
                { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                { label: 'Build Price', value: constructionProgressTotal },
                { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
              ];
              totalOverall = constructionProgressSchedule.landPrice + stampDuty + solicitorFees + constructionProgressTotal + stagedInterest;
            } else {
              upfrontRows = [
                { label: `Deposit (${depositPct}% — from your funds)`, value: depositValue },
                { label: 'Stamp Duty', value: stampDuty },
                { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                { label: 'Agent Fee', value: agentFee },
                ...(lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: lmiAmount }] : []),
              ];
              totalUpfront = depositValue + stampDuty + solicitorFees + agentFee + lmiAmount;
              overallExtraRows = [
                { label: 'Purchase Price', value: baseFinancialData.purchasePrice },
                { label: 'Stamp Duty', value: stampDuty },
                { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                { label: 'Agent Fee', value: agentFee },
              ];
              totalOverall = baseFinancialData.purchasePrice + stampDuty + solicitorFees + agentFee;
            }
            const rowsHtml = (rows: { label: string; value: number }[]) => rows.map(r =>
              `<tr><td style="font-weight: 500;">${r.label}</td><td style="text-align: right;">${formatCurrency(r.value)}</td></tr>`
            ).join('');
            return `
              <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid #ccc;">
                <h4 style="font-size: 12px; font-weight: bold; margin-bottom: 8px;">Total Upfront Costs</h4>
                <table style="margin-bottom: 0; font-size: 11px;">
                  <tbody>
                    ${rowsHtml(upfrontRows)}
                    <tr style="background: #e5e7eb;"><td style="font-weight: 600;">Total Upfront Costs</td><td style="text-align: right; font-weight: 600;">${formatCurrency(totalUpfront)}</td></tr>
                  </tbody>
                </table>
              </div>
              <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid #ccc;">
                <h4 style="font-size: 12px; font-weight: bold; margin-bottom: 8px;">Total Overall Expenditure to Completion</h4>
                <table style="margin-bottom: 0; font-size: 11px;">
                  <tbody>
                    ${rowsHtml(overallExtraRows)}
                    <tr style="background: #dbeafe;"><td style="font-weight: bold; color: #2563eb;">Total Overall Expenditure to Completion</td><td style="text-align: right; font-weight: bold; color: #2563eb;">${formatCurrency(totalOverall)}</td></tr>
                  </tbody>
                </table>
              </div>
            `;
          })()}
        </div>
        ` : ''}
        
        ${isNewBuild && includeConstructionScheduleInExport && constructionProgressSchedule && constructionProgressSchedule.buildPrice > 0 ? `
        <!-- Construction Progress Payment Schedule (New Builds Only) -->
        <div class="summary" style="margin-bottom: 24px;">
          <h3 style="margin-bottom: 12px;">Construction Progress Payment Schedule</h3>
          <div style="display: flex; gap: 24px; margin-bottom: 16px; padding: 12px; background: #f0f4f8; border-radius: 6px;">
            <div><span style="font-size: 11px; color: #666;">Land Cost</span><br><strong>${formatCurrency(constructionProgressSchedule.landPrice)}</strong></div>
            <div><span style="font-size: 11px; color: #666;">Build Contract</span><br><strong>${formatCurrency(constructionProgressSchedule.buildPrice)}</strong></div>
            <div><span style="font-size: 11px; color: #666;">Total Project</span><br><strong>${formatCurrency(constructionProgressSchedule.totalProject)}</strong></div>
          </div>
          <p style="font-size: 12px; font-weight: 600; margin-bottom: 8px;">Build Contract Breakdown (${constructionProgressSchedule.durationMonths} Month Construction)</p>
          <table style="margin-bottom: 0; font-size: 11px;">
            <thead>
              <tr>
                <th style="text-align: left;">Stage</th>
                <th style="text-align: left;">Description</th>
                <th style="text-align: center;">Total Build Contract</th>
                <th style="text-align: right;">Stage Pricing</th>
                <th style="text-align: right;">Land Interest (Monthly)</th>
                <th style="text-align: right;">Build Interest (Monthly)</th>
                <th style="text-align: right;">Combined Repayment</th>
                <th style="text-align: center;">Month</th>
              </tr>
            </thead>
            <tbody>
              ${constructionProgressSchedule.stages.map((stage, idx) => `
              <tr style="${idx === 0 ? 'background: #f5f5f5;' : ''}">
                <td style="text-align: left; font-weight: 500;">${stage.stage}</td>
                <td style="text-align: left; color: #666; font-size: 10px;">${stage.description}</td>
                <td style="text-align: center;">${stage.percentage > 0 ? `${stage.percentage}%` : ''}</td>
                <td style="text-align: right;">${formatCurrency(stage.buildAmount)}</td>
                <td style="text-align: right;">${formatCurrency(stage.landInterest)}</td>
                <td style="text-align: right;">${stage.buildInterest > 0 ? formatCurrency(stage.buildInterest) : ''}</td>
                <td style="text-align: right; font-weight: 500;">${formatCurrency(stage.totalMonthlyInterest)}</td>
                <td style="text-align: center;">${stage.month}</td>
              </tr>
              `).join('')}
              <tr style="background: #f0f0f0; font-weight: bold; border-top: 2px solid #ccc;">
                <td></td>
                <td></td>
                <td style="text-align: center;">100%</td>
                <td style="text-align: right;">${formatCurrency(constructionProgressSchedule.landPrice + constructionProgressSchedule.buildPrice)}</td>
                <td style="text-align: right;">Total</td>
                <td></td>
                <td style="text-align: right;">${formatCurrency(constructionProgressSchedule.totals.totalCombinedRepayment)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          <p style="font-size: 10px; color: #888; margin-top: 8px;">* Interest calculated at ${constructionProgressSchedule.interestRate}% p.a. Land interest is constant; build interest increases as stages are drawn.</p>
        </div>
        ` : ''}
        
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Today</th>
              ${Array.from({ length: 10 }, (_, i) => `<th>Yr ${i + 1}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Capital Growth %</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${p.capitalGrowthRate.toFixed(1)}%</td>`).join('')}
            </tr>
            <tr>
              <td>CPI Growth %</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${p.cpiGrowthRate.toFixed(1)}%</td>`).join('')}
            </tr>
            <tr>
              <td>Property Value $</td>
              <td>${formatCurrency(projections[0].propertyMarketValue)}</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.propertyMarketValue)}</td>`).join('')}
            </tr>
            <tr>
              <td>Purchase Price $</td>
              <td>${formatCurrency(baseFinancialData.purchasePrice)}</td>
              ${Array(10).fill('<td></td>').join('')}
            </tr>
            <tr>
              <td>Loan Amount $</td>
              <td>${formatCurrency(projections[0].loanAmount)}</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.loanAmount)}</td>`).join('')}
            </tr>
            <tr class="section-header"><td colspan="12">STATISTICS</td></tr>
            <tr class="equity-row">
              <td>Equity $</td>
              <td class="text-green">${formatCurrency(projections[0].equityInProperty)}</td>
              ${projections.slice(1).map(p => `<td class="text-green">${formatCurrency(p.equityInProperty)}</td>`).join('')}
            </tr>
            <tr>
              <td>LVR %</td>
              <td>${projections[0].loanToValueRatio.toFixed(1)}%</td>
              ${projections.slice(1).map(p => `<td>${p.loanToValueRatio.toFixed(1)}%</td>`).join('')}
            </tr>
            <tr>
              <td>Rental Income $</td>
              <td>${formatCurrency(baseFinancialData.weeklyRent)}pw</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.rentalIncome)}</td>`).join('')}
            </tr>
            <tr>
              <td>Gross Yield %</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${p.grossYield.toFixed(2)}%</td>`).join('')}
            </tr>
            <tr>
              <td>Net Yield %</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${p.netYield.toFixed(2)}%</td>`).join('')}
            </tr>
            <tr class="section-header"><td colspan="12">CASH DEDUCTIONS</td></tr>
            <tr>
              <td>Property Expenses $</td>
              <td>$0</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.propertyExpenses)}</td>`).join('')}
            </tr>
            <tr>
              <td>Land Tax $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.landTax)}</td>`).join('')}
            </tr>
            <tr>
              <td>Interest Rate %</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${p.interestRate.toFixed(2)}%</td>`).join('')}
            </tr>
            <tr>
              <td>Interest Payments $</td>
              <td>$0</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.interestPayments)}</td>`).join('')}
            </tr>
            <tr>
              <td>Principal Payments $</td>
              <td>$0</td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.principalPayments)}</td>`).join('')}
            </tr>
            <tr>
              <td>Pre-Tax Cash Flow p/a $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="${p.preTaxCashFlowPA < 0 ? 'text-red' : 'text-green'}">${formatCurrency(p.preTaxCashFlowPA)}</td>`).join('')}
            </tr>
            <tr>
              <td>Pre-Tax Cash Flow p/w $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="${p.preTaxCashFlowPW < 0 ? 'text-red' : 'text-green'}">${formatCurrency(p.preTaxCashFlowPW)}</td>`).join('')}
            </tr>
            <tr class="section-header"><td colspan="12">NON-CASH DEDUCTIONS</td></tr>
            <tr>
              <td>Depreciation $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.depreciation)}</td>`).join('')}
            </tr>
            <tr class="section-header"><td colspan="12">SUMMARY</td></tr>
            <tr>
              <td>Total Deductions $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td>${formatCurrency(p.totalDeductions)}</td>`).join('')}
            </tr>
            <tr>
              <td>Net Profit/Loss $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="${p.netProfitLoss < 0 ? 'text-red' : 'text-green'}">${formatCurrency(p.netProfitLoss)}</td>`).join('')}
            </tr>
            <tr>
              <td>Tax Refund $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="text-green">${formatCurrency(p.taxRefund)}</td>`).join('')}
            </tr>
            <tr style="background: #eff6ff; font-weight: bold;">
              <td>After-Tax Cash Flow p/a $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="${p.afterTaxCashFlowPA < 0 ? 'text-red' : 'text-green'}">${formatCurrency(p.afterTaxCashFlowPA)}</td>`).join('')}
            </tr>
            <tr style="background: #eff6ff; font-weight: bold;">
              <td>After-Tax Cash Flow p/w $</td>
              <td></td>
              ${projections.slice(1).map(p => `<td class="${p.afterTaxCashFlowPW < 0 ? 'text-red' : 'text-green'}">${formatCurrency(p.afterTaxCashFlowPW)}</td>`).join('')}
            </tr>
          </tbody>
        </table>
        
        <div class="summary">
          <h3>10-Year Investment Summary</h3>
          <div class="summary-grid">
            <div class="summary-item">
              <div class="summary-label">Year 10 Property Value</div>
              <div class="summary-value text-green">${formatCurrency(projections[10]?.propertyMarketValue || 0)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Year 10 Equity</div>
              <div class="summary-value text-green">${formatCurrency(projections[10]?.equityInProperty || 0)}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Total After-Tax Cash Flow</div>
              <div class="summary-value ${projections.slice(1).reduce((sum, p) => sum + p.afterTaxCashFlowPA, 0) < 0 ? 'text-red' : 'text-green'}">${formatCurrency(projections.slice(1).reduce((sum, p) => sum + p.afterTaxCashFlowPA, 0))}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">Capital Gain</div>
              <div class="summary-value text-green">${formatCurrency((projections[10]?.propertyMarketValue || 0) - baseFinancialData.purchasePrice)}</div>
            </div>
          </div>
        </div>
        
        <p class="disclaimer">
          This analysis is for informational purposes only and does not constitute financial advice. 
          Projections are estimates based on assumed growth rates and may not reflect actual future performance.
          Please consult with a qualified financial advisor before making investment decisions.
        </p>
      </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  }, [report, baseFinancialData, projections, includeInputsSummaryInExport, includeConstructionScheduleInExport, constructionProgressSchedule, isNewBuild, toast]);

  if (!report || !baseFinancialData) return null;

  return (
    <>
    <CashFlowPresentationShell
      presentation={presentation}
      isOpen={isOpen}
      onClose={onClose}
      header={(
          <CashFlowCommandHeader
            presentation={presentation}
            onBack={isPagePresentation ? onClose : undefined}
            backLabel={backLabel}
            propertyAddress={report.property_address}
            isNewBuild={isNewBuild}
            hasChanges={hasChanges}
            hasOverrides={Object.keys(yearlyOverrides).length > 0}
            isSaving={isSaving}
            comparisonMode={comparisonMode}
            comparisonCount={comparisonReports.length + 1}
            onResetAll={() => setShowResetConfirm(true)}
            onSaveChanges={handleSaveOverrides}
            exportMenu={(
              <CashFlowExportMenu
                includeAllChartsInExport={includeAllChartsInExport}
                chartExportToggles={chartExportToggles}
                onGlobalChartsToggle={handleGlobalChartsToggle}
                onChartToggle={handleChartToggle}
                onExportExcel={handleExportExcel}
                onExportServerPdf={exportServerCashFlowPDF}
                isExportingServerPdf={isExportingServerPdf}
                onExportPdf={exportSingleReportPDF}
                onPrintView={openPrintView}
                onSendToClient={() => setSendToClientOpen(true)}
                filename={`Cash_Flow_10Year_${(report?.property_address || 'report').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`}
              />
            )}
          />
        )}
      footer={(
          isPagePresentation ? (
            <div className="flex justify-end gap-2 py-4">
              <Button variant="outline" onClick={onClose} className="min-h-10 rounded-xl">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {backLabel}
              </Button>
            </div>
          ) : (
            <div className="px-6 py-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Close</Button>
            </div>
          )
        )}
      >
        <div className="space-y-6">
          <CashFlowKpiStrip
            baseFinancialData={baseFinancialData}
            projections={projections}
            formatCurrency={formatCurrency}
          />

            <CashFlowControlPanel
              comparisonMode={comparisonMode}
              comparisonsAvailable={cashflowComparisonsEnabled}
              onComparisonModeChange={setComparisonMode}
              selectedComparisonReportIds={selectedComparisonReportIds}
              availableReports={availableReports}
              onToggleComparisonReport={handleToggleComparisonReport}
              loadingReports={loadingReports}
              investorProfile={investorProfile}
              onInvestorProfileChange={setInvestorProfile}
              excludeLandTaxFromCashFlow={excludeLandTaxFromCashFlow}
              onExcludeLandTaxChange={(checked) => {
                setExcludeLandTaxFromCashFlow(checked);
                setHasChanges(true);
              }}
              hasChanges={hasChanges}
            />

            <CashFlowChartsWorkspace>
            {/* Cash Flow Trends Chart */}
            <Card className="overflow-hidden border-border/80 bg-background/95 shadow-lg ring-1 ring-border/5">
              <CardHeader className="border-b bg-gradient-to-r from-muted via-background to-muted/70 pb-4 dark:from-background/40 dark:via-background dark:to-background/30">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="rounded-xl bg-primary/10 p-2 text-primary">
                        <BarChart3 className="h-4 w-4" />
                      </span>
                      10-Year Cash Flow Trends
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Toggle metrics, inspect break-even points, and export the active trend chart.
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 xl:items-end">
                    <div className="flex flex-wrap gap-2 text-xs">
                      {[
                        { key: 'propertyValue' as const, label: 'Property Value', color: 'hsl(var(--primary))' },
                        { key: 'equity' as const, label: 'Equity', color: '#22c55e' },
                        { key: 'loanBalance' as const, label: 'Loan Balance', color: '#ef4444' },
                        { key: 'rentalIncome' as const, label: 'Rental Income', color: '#f59e0b' },
                        { key: 'cashFlow' as const, label: 'Cash Flow', color: '#8b5cf6' },
                      ].map(({ key, label, color }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setChartMetrics(prev => ({ ...prev, [key]: !prev[key] }))}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 shadow-sm transition-all hover:-translate-y-0.5 ${chartMetrics[key] ? 'border-primary/30 bg-primary/10 text-foreground ring-1 ring-primary/10' : 'border-border bg-background text-muted-foreground hover:bg-muted'}`}
                        >
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                          {label}
                        </button>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => exportChartAsPNG(cashFlowChartRef, 'cash-flow-trends')}
                      className="h-8 w-full justify-center gap-2 rounded-xl sm:w-auto"
                    >
                      <Image className="h-4 w-4" />
                      Export PNG
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                {(() => {
                  const chartData = projections.filter(p => p.year >= 1).map((p, i, arr) => {
                    const prev = i > 0 ? arr[i - 1] : null;
                    return {
                      year: `Yr ${p.year}`,
                      'Property Value': p.propertyMarketValue,
                      'Rental Income': p.rentalIncome,
                      'Cash Flow (After Tax)': p.afterTaxCashFlowPA,
                      'Equity': p.equityInProperty,
                      'Loan Balance': p.loanAmount,
                      _yoy_propertyValue: prev ? ((p.propertyMarketValue - prev.propertyMarketValue) / prev.propertyMarketValue * 100) : 0,
                      _yoy_equity: prev ? ((p.equityInProperty - prev.equityInProperty) / (prev.equityInProperty || 1) * 100) : 0,
                      _yoy_rental: prev ? ((p.rentalIncome - prev.rentalIncome) / (prev.rentalIncome || 1) * 100) : 0,
                      _yoy_cashFlow: prev ? (p.afterTaxCashFlowPA - prev.afterTaxCashFlowPA) : 0,
                    };
                  });

                  // Find break-even year (cash flow turns positive)
                  const breakEvenYear = projections.filter(p => p.year >= 1).find((p, i, arr) => {
                    if (i === 0) return p.afterTaxCashFlowPA >= 0;
                    return arr[i - 1].afterTaxCashFlowPA < 0 && p.afterTaxCashFlowPA >= 0;
                  });

                  // Find equity-debt crossover
                  const crossoverYear = projections.filter(p => p.year >= 1).find(p => p.equityInProperty >= p.loanAmount);

                  return (
                    <>
                      <div ref={cashFlowChartRef} className="h-[320px] w-full rounded-3xl border bg-white p-3 shadow-inner sm:h-[380px] xl:h-[420px]" style={{ backgroundColor: '#ffffff' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart
                            data={chartData}
                            margin={{ top: 10, right: 30, left: 20, bottom: 10 }}
                          >
                            <defs>
                              <linearGradient id="fillPropertyValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15}/>
                                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                              </linearGradient>
                              <linearGradient id="fillEquity" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15}/>
                                <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.15} stroke="#d1d5db" />
                            <XAxis 
                              dataKey="year" 
                              tick={{ fontSize: 11, fill: '#6b7280' }}
                              axisLine={{ stroke: '#e5e7eb' }}
                              tickLine={false}
                            />
                            <YAxis 
                              tick={{ fontSize: 11, fill: '#6b7280' }} 
                              tickFormatter={(value) => {
                                if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
                                if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
                                return `$${value}`;
                              }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <Tooltip 
                              content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null;
                                return (
                                  <div className="bg-popover border border-border rounded-lg p-3 shadow-lg text-xs space-y-1.5">
                                    <p className="font-semibold text-sm mb-2">{label}</p>
                                    {payload.map((entry: any, idx: number) => {
                                      const yoyKey = entry.dataKey === 'Property Value' ? '_yoy_propertyValue' :
                                        entry.dataKey === 'Equity' ? '_yoy_equity' :
                                        entry.dataKey === 'Rental Income' ? '_yoy_rental' : null;
                                      const yoyVal = yoyKey ? entry.payload?.[yoyKey] : null;
                                      return (
                                        <div key={idx} className="flex items-center justify-between gap-4">
                                          <span className="flex items-center gap-1.5">
                                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                                            {entry.name}
                                          </span>
                                          <span className="font-medium">
                                            ${Number(entry.value).toLocaleString('en-AU')}
                                            {yoyVal !== null && yoyVal !== 0 && (
                                              <span className={`ml-1.5 ${yoyVal > 0 ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                                                {yoyVal > 0 ? '↑' : '↓'}{Math.abs(yoyVal).toFixed(1)}%
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              }}
                            />
                            <Legend 
                              wrapperStyle={{ fontSize: '11px', paddingTop: '18px' }}
                              iconType="circle"
                              iconSize={8}
                            />
                            {/* Break-even vertical line */}
                            {chartMetrics.cashFlow && breakEvenYear && (
                              <ReferenceLine 
                                x={`Yr ${breakEvenYear.year}`} 
                                stroke="#22c55e" 
                                strokeDasharray="4 4" 
                                strokeWidth={1.5}
                                label={{ 
                                  value: `Break-even: Yr ${breakEvenYear.year}`, 
                                  position: 'top', 
                                  fontSize: 10, 
                                  fill: '#22c55e',
                                  fontWeight: 600
                                }}
                              />
                            )}
                            {/* Crossover annotation */}
                            {chartMetrics.equity && chartMetrics.loanBalance && crossoverYear && (
                              <ReferenceLine 
                                x={`Yr ${crossoverYear.year}`} 
                                stroke="#06b6d4" 
                                strokeDasharray="4 4" 
                                strokeWidth={1.5}
                                label={{ 
                                  value: `Equity > Debt: Yr ${crossoverYear.year}`, 
                                  position: 'insideTopRight', 
                                  fontSize: 10, 
                                  fill: '#06b6d4',
                                  fontWeight: 600
                                }}
                              />
                            )}
                            {/* Area fills */}
                            {chartMetrics.propertyValue && (
                              <Area type="monotone" dataKey="Property Value" fill="url(#fillPropertyValue)" stroke="none" />
                            )}
                            {chartMetrics.equity && (
                              <Area type="monotone" dataKey="Equity" fill="url(#fillEquity)" stroke="none" />
                            )}
                            {/* Lines */}
                            {chartMetrics.propertyValue && (
                              <Line 
                                type="monotone" 
                                dataKey="Property Value" 
                                stroke="hsl(var(--primary))" 
                                strokeWidth={2.5}
                                dot={{ r: 4, fill: 'hsl(var(--primary))', strokeWidth: 0 }}
                                activeDot={{ r: 6, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                              />
                            )}
                            {chartMetrics.equity && (
                              <Line 
                                type="monotone" 
                                dataKey="Equity" 
                                stroke="#22c55e" 
                                strokeWidth={2.5}
                                dot={{ r: 4, fill: '#22c55e', strokeWidth: 0 }}
                                activeDot={{ r: 6, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                              />
                            )}
                            {chartMetrics.loanBalance && (
                              <Line 
                                type="monotone" 
                                dataKey="Loan Balance" 
                                stroke="#ef4444" 
                                strokeWidth={2}
                                strokeDasharray="8 4"
                                dot={{ r: 3, fill: '#ef4444', strokeWidth: 0 }}
                                activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                              />
                            )}
                            {chartMetrics.rentalIncome && (
                              <Line 
                                type="monotone" 
                                dataKey="Rental Income" 
                                stroke="#f59e0b" 
                                strokeWidth={2}
                                strokeDasharray="6 3"
                                dot={{ r: 3, fill: '#f59e0b', strokeWidth: 0 }}
                                activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                              />
                            )}
                            {chartMetrics.cashFlow && (
                              <Line 
                                type="monotone" 
                                dataKey="Cash Flow (After Tax)" 
                                stroke="#8b5cf6" 
                                strokeWidth={2}
                                strokeDasharray="6 3"
                                dot={{ r: 3, fill: '#8b5cf6', strokeWidth: 0 }}
                                activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                              />
                            )}
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                      {/* Sparkline KPI Cards */}
                      {projections.length > 1 && (() => {
                        const yr1 = projections.find(p => p.year === 1);
                        const yr10 = projections.find(p => p.year === 10);
                        if (!yr1 || !yr10) return null;
                        const totalGrowth = yr1.propertyMarketValue > 0 
                          ? (((yr10.propertyMarketValue - yr1.propertyMarketValue) / yr1.propertyMarketValue) * 100).toFixed(1) 
                          : '0';
                        const values = projections.filter(p => p.year >= 1);
                        
                        const kpis = [
                          { 
                            label: 'Property Value', 
                            yr1: `$${yr1.propertyMarketValue.toLocaleString('en-AU')}`, 
                            yr10: `$${yr10.propertyMarketValue.toLocaleString('en-AU')}`,
                            change: `+${totalGrowth}%`,
                            positive: true,
                            sparkData: values.map(v => v.propertyMarketValue),
                            color: 'hsl(var(--primary))'
                          },
                          { 
                            label: 'Equity', 
                            yr1: `$${yr1.equityInProperty.toLocaleString('en-AU')}`, 
                            yr10: `$${yr10.equityInProperty.toLocaleString('en-AU')}`,
                            change: `+$${(yr10.equityInProperty - yr1.equityInProperty).toLocaleString('en-AU')}`,
                            positive: true,
                            sparkData: values.map(v => v.equityInProperty),
                            color: '#22c55e'
                          },
                          { 
                            label: 'Loan Balance', 
                            yr1: `$${yr1.loanAmount.toLocaleString('en-AU')}`, 
                            yr10: `$${yr10.loanAmount.toLocaleString('en-AU')}`,
                            change: `-$${(yr1.loanAmount - yr10.loanAmount).toLocaleString('en-AU')}`,
                            positive: yr10.loanAmount < yr1.loanAmount,
                            sparkData: values.map(v => v.loanAmount),
                            color: '#ef4444'
                          },
                          { 
                            label: 'Cash Flow', 
                            yr1: `$${yr1.afterTaxCashFlowPA.toLocaleString('en-AU')}`, 
                            yr10: `$${yr10.afterTaxCashFlowPA.toLocaleString('en-AU')}`,
                            change: yr10.afterTaxCashFlowPA >= 0 ? 'Positive' : 'Negative',
                            positive: yr10.afterTaxCashFlowPA >= 0,
                            sparkData: values.map(v => v.afterTaxCashFlowPA),
                            color: '#8b5cf6'
                          },
                        ];

                        return (
                          <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2 xl:grid-cols-4">
                            {kpis.map(kpi => {
                              const min = Math.min(...kpi.sparkData);
                              const max = Math.max(...kpi.sparkData);
                              const range = max - min || 1;
                              const points = kpi.sparkData.map((v, i) => 
                                `${(i / (kpi.sparkData.length - 1)) * 60},${24 - ((v - min) / range) * 20}`
                              ).join(' ');
                              return (
                                <div key={kpi.label} className="space-y-1 rounded-xl border bg-muted/30 p-3">
                                  <p className="text-[10px] text-muted-foreground font-medium">{kpi.label}</p>
                                  <div className="flex items-end justify-between">
                                    <div>
                                      <p className="text-xs font-bold">{kpi.yr10}</p>
                                      <p className={`text-[10px] font-semibold ${kpi.positive ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                                        {kpi.change}
                                      </p>
                                    </div>
                                    <svg width="60" height="24" className="opacity-60">
                                      <polyline
                                        fill="none"
                                        stroke={kpi.color}
                                        strokeWidth="1.5"
                                        points={points}
                                      />
                                    </svg>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                      {/* Chart Insight — collapsible in dashboard modal */}
                      {projections.length > 1 && (() => {
                        const yr1d = projections.find(p => p.year === 1);
                        const yr10d = projections.find(p => p.year === 10);
                        if (!yr1d || !yr10d || !baseFinancialData) return null;
                        const propGrowth = ((yr10d.propertyMarketValue - baseFinancialData.purchasePrice) / baseFinancialData.purchasePrice * 100).toFixed(1);
                        const eqGrowth = yr1d.equityInProperty > 0 ? ((yr10d.equityInProperty - yr1d.equityInProperty) / yr1d.equityInProperty * 100).toFixed(1) : 'N/A';
                        const loanRed = projections[0]?.loanAmount > 0 ? ((1 - yr10d.loanAmount / projections[0].loanAmount) * 100).toFixed(1) : '0';
                        const bey = projections.filter(p => p.year >= 1).find((p, i, arr) => i > 0 && arr[i - 1].afterTaxCashFlowPA < 0 && p.afterTaxCashFlowPA >= 0);
                        const coy = projections.filter(p => p.year >= 1).find(p => p.equityInProperty >= p.loanAmount);
                        return (
                          <Collapsible open={showCashFlowInsight} onOpenChange={setShowCashFlowInsight}>
                            <CollapsibleTrigger asChild>
                              <button className="w-full flex items-center justify-between p-3 bg-brand-50 dark:bg-brand-950/30 border border-brand-200 dark:border-brand-800/40 rounded-xl hover:bg-brand-100 dark:hover:bg-brand-950/50 transition-colors text-xs font-semibold text-brand-800 dark:text-brand-300">
                                <span className="flex items-center gap-1.5">
                                  <TrendingUp className="h-3.5 w-3.5" />
                                  Cash Flow Trend Analysis
                                </span>
                                <span className="flex items-center gap-1 text-[10px] font-normal text-brand-600 dark:text-brand-400">
                                  {showCashFlowInsight ? 'Hide' : 'View'} Analysis
                                  {showCashFlowInsight ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </span>
                              </button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="p-3 bg-brand-50 dark:bg-brand-950/30 border border-t-0 border-brand-200 dark:border-brand-800/40 rounded-b-lg -mt-[1px]">
                                <div className="text-xs text-brand-900/80 dark:text-brand-200/70 space-y-2 leading-relaxed">
                                  <p><strong>Property Value Growth:</strong> Projected to appreciate by {propGrowth}% over 10 years (from ${baseFinancialData.purchasePrice.toLocaleString('en-AU')} to ${yr10d.propertyMarketValue.toLocaleString('en-AU')}), reflecting configured capital growth assumptions.</p>
                                  <p><strong>Equity Accumulation:</strong> Equity increases by {eqGrowth}% (${yr1d.equityInProperty.toLocaleString('en-AU')} → ${yr10d.equityInProperty.toLocaleString('en-AU')}), driven by capital appreciation and principal repayments reducing the loan by {loanRed}%.</p>
                                  <p><strong>Cash Flow:</strong> After-tax cash flow moves from ${yr1d.afterTaxCashFlowPA.toLocaleString('en-AU')}/yr (Year 1) to ${yr10d.afterTaxCashFlowPA.toLocaleString('en-AU')}/yr (Year 10).
                                    {bey && ` The investment becomes cash-flow positive in Year ${bey.year}.`}
                                    {coy && ` Equity exceeds remaining debt in Year ${coy.year} — a key wealth milestone.`}
                                  </p>
                                </div>
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })()}
                    </>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Yield Percentages Chart */}
            <Card className="overflow-hidden border-border/80 bg-background/95 shadow-lg ring-1 ring-border/5">
              <CardHeader className="border-b bg-gradient-to-r from-muted via-background to-muted/70 pb-4 dark:from-background/40 dark:via-background dark:to-background/30">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="rounded-xl bg-primary/10 p-2 text-primary">
                        <Percent className="h-4 w-4" />
                      </span>
                      Yield Percentages Over 10 Years
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">Gross yield, net yield, and expense spread over the projection horizon.</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportChartAsPNG(yieldChartRef, 'yield-percentages')}
                    className="h-8 w-full justify-center gap-2 rounded-xl sm:w-auto"
                  >
                    <Image className="h-4 w-4" />
                    Export PNG
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                {(() => {
                  const yieldData = projections.filter(p => p.year >= 1).map((p, i, arr) => {
                    const prev = i > 0 ? arr[i - 1] : null;
                    return {
                      year: `Yr ${p.year}`,
                      'Gross Yield %': p.grossYield,
                      'Net Yield %': p.netYield,
                      'Expense Spread': p.grossYield - p.netYield,
                      _yoy_gross: prev ? (p.grossYield - prev.grossYield) : 0,
                      _yoy_net: prev ? (p.netYield - prev.netYield) : 0,
                    };
                  });

                  return (
                    <>
                      <div ref={yieldChartRef} className="h-[280px] w-full rounded-3xl border bg-white p-3 shadow-inner sm:h-[320px]" style={{ backgroundColor: '#ffffff' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart
                            data={yieldData}
                            margin={{ top: 10, right: 30, left: 20, bottom: 10 }}
                          >
                            <defs>
                              <linearGradient id="yieldSpread" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.12}/>
                                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.03}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.15} stroke="#d1d5db" />
                            <XAxis 
                              dataKey="year" 
                              tick={{ fontSize: 11, fill: '#6b7280' }}
                              axisLine={{ stroke: '#e5e7eb' }}
                              tickLine={false}
                            />
                            <YAxis 
                              tick={{ fontSize: 11, fill: '#6b7280' }} 
                              tickFormatter={(value) => `${value}%`}
                              domain={['auto', 'auto']}
                              axisLine={false}
                              tickLine={false}
                            />
                            <Tooltip 
                              content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null;
                                const gross = payload.find((p: any) => p.dataKey === 'Gross Yield %');
                                const net = payload.find((p: any) => p.dataKey === 'Net Yield %');
                                const yoyGross = gross?.payload?._yoy_gross;
                                const yoyNet = net?.payload?._yoy_net;
                                const spread = gross && net ? (Number(gross.value) - Number(net.value)).toFixed(2) : '0';
                                return (
                                  <div className="bg-popover border border-border rounded-lg p-3 shadow-lg text-xs space-y-1.5">
                                    <p className="font-semibold text-sm mb-2">{label}</p>
                                    {gross && (
                                      <div className="flex items-center justify-between gap-4">
                                        <span className="flex items-center gap-1.5">
                                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#06b6d4' }} />
                                          Gross Yield
                                        </span>
                                        <span className="font-medium">
                                          {Number(gross.value).toFixed(2)}%
                                          {yoyGross !== 0 && (
                                            <span className={`ml-1.5 ${yoyGross > 0 ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                                              {yoyGross > 0 ? '↑' : '↓'}{Math.abs(yoyGross).toFixed(2)}pp
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    )}
                                    {net && (
                                      <div className="flex items-center justify-between gap-4">
                                        <span className="flex items-center gap-1.5">
                                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#ec4899' }} />
                                          Net Yield
                                        </span>
                                        <span className="font-medium">
                                          {Number(net.value).toFixed(2)}%
                                          {yoyNet !== 0 && (
                                            <span className={`ml-1.5 ${yoyNet > 0 ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                                              {yoyNet > 0 ? '↑' : '↓'}{Math.abs(yoyNet).toFixed(2)}pp
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between gap-4 pt-1 border-t border-border/50">
                                      <span className="flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
                                        Expense Drag
                                      </span>
                                      <span className="font-medium text-brand-500">{spread}pp</span>
                                    </div>
                                  </div>
                                );
                              }}
                            />
                            <Legend 
                              wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }}
                              iconType="circle"
                              iconSize={8}
                            />
                            {/* Shaded spread band between gross and net */}
                            <Area 
                              type="monotone" 
                              dataKey="Gross Yield %" 
                              fill="url(#yieldSpread)" 
                              stroke="none"
                              legendType="none"
                            />
                            <Line 
                              type="monotone" 
                              dataKey="Gross Yield %" 
                              stroke="#06b6d4" 
                              strokeWidth={2.5}
                              dot={{ r: 4, fill: '#06b6d4', strokeWidth: 0 }}
                              activeDot={{ r: 6, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                            />
                            <Line 
                              type="monotone" 
                              dataKey="Net Yield %" 
                              stroke="#ec4899" 
                              strokeWidth={2.5}
                              dot={{ r: 4, fill: '#ec4899', strokeWidth: 0 }}
                              activeDot={{ r: 6, strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                      {/* Yield summary with sparklines */}
                      {projections.length > 1 && (() => {
                        const yr1 = projections.find(p => p.year === 1);
                        const yr10 = projections.find(p => p.year === 10);
                        if (!yr1 || !yr10) return null;
                        const values = projections.filter(p => p.year >= 1);
                        const avgSpread = values.reduce((s, v) => s + (v.grossYield - v.netYield), 0) / values.length;
                        
                        const yieldKpis = [
                          { label: 'Gross Yield', value: `${yr10.grossYield.toFixed(2)}%`, sub: `from ${yr1.grossYield.toFixed(2)}%`, sparkData: values.map(v => v.grossYield), color: '#06b6d4' },
                          { label: 'Net Yield', value: `${yr10.netYield.toFixed(2)}%`, sub: `from ${yr1.netYield.toFixed(2)}%`, sparkData: values.map(v => v.netYield), color: '#ec4899' },
                          { label: 'Avg Expense Drag', value: `${avgSpread.toFixed(2)}pp`, sub: 'Gross − Net spread', sparkData: values.map(v => v.grossYield - v.netYield), color: '#f59e0b' },
                        ];

                        return (
                          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t">
                            {yieldKpis.map(kpi => {
                              const min = Math.min(...kpi.sparkData);
                              const max = Math.max(...kpi.sparkData);
                              const range = max - min || 1;
                              const points = kpi.sparkData.map((v, i) => 
                                `${(i / (kpi.sparkData.length - 1)) * 60},${24 - ((v - min) / range) * 20}`
                              ).join(' ');
                              return (
                                <div key={kpi.label} className="bg-muted/40 rounded-lg p-2.5 space-y-1">
                                  <p className="text-[10px] text-muted-foreground font-medium">{kpi.label}</p>
                                  <div className="flex items-end justify-between">
                                    <div>
                                      <p className="text-xs font-bold">{kpi.value}</p>
                                      <p className="text-[10px] text-muted-foreground">{kpi.sub}</p>
                                    </div>
                                    <svg width="60" height="24" className="opacity-60">
                                      <polyline fill="none" stroke={kpi.color} strokeWidth="1.5" points={points} />
                                    </svg>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                      {/* Yield Insight — collapsible in dashboard modal */}
                      {projections.length > 1 && (() => {
                        const yr1y = projections.find(p => p.year === 1);
                        const yr10y = projections.find(p => p.year === 10);
                        if (!yr1y || !yr10y) return null;
                        const grossDelta = (yr10y.grossYield - yr1y.grossYield).toFixed(2);
                        const netDelta = (yr10y.netYield - yr1y.netYield).toFixed(2);
                        const vals = projections.filter(p => p.year >= 1);
                        const avgSprd = (vals.reduce((s, p) => s + (p.grossYield - p.netYield), 0) / vals.length).toFixed(2);
                        return (
                          <Collapsible open={showYieldInsight} onOpenChange={setShowYieldInsight}>
                            <CollapsibleTrigger asChild>
                              <button className="mt-3 w-full flex items-center justify-between p-2.5 bg-info/10 dark:bg-info/30 border border-info/30 dark:border-info/40 rounded-lg hover:bg-info/15 dark:hover:bg-info/50 transition-colors text-xs font-semibold text-info dark:text-info">
                                <span className="flex items-center gap-1.5">
                                  <Percent className="h-3.5 w-3.5" />
                                  Yield Analysis Insight
                                </span>
                                <span className="flex items-center gap-1 text-[10px] font-normal text-info dark:text-info">
                                  {showYieldInsight ? 'Hide' : 'View'} Analysis
                                  {showYieldInsight ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                </span>
                              </button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="p-3 bg-info/10 dark:bg-info/30 border border-t-0 border-info/30 dark:border-info/40 rounded-b-lg -mt-[1px]">
                                <div className="text-xs text-info/80 dark:text-info/70 space-y-2 leading-relaxed">
                                  <p><strong>Gross Yield:</strong> Moves from {yr1y.grossYield.toFixed(2)}% (Year 1) to {yr10y.grossYield.toFixed(2)}% (Year 10), a shift of {grossDelta}pp. This compression occurs because property value appreciates faster than rental income — a hallmark of growth-oriented assets.</p>
                                  <p><strong>Net Yield:</strong> Shifts from {yr1y.netYield.toFixed(2)}% to {yr10y.netYield.toFixed(2)}% ({netDelta}pp change). Net yield accounts for holding costs including council rates, insurance, maintenance, and management fees.</p>
                                  <p><strong>Expense Drag:</strong> Average spread between gross and net yield is {avgSprd}pp, representing the proportion of rental income consumed by holding costs. A narrowing spread indicates improving operational efficiency.</p>
                                </div>
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })()}
                    </>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Comparison Chart - Side by Side (Up to 5 Properties) */}
            {comparisonMode && comparisonReports.length > 0 && allComparisonProjections.length > 0 && (
              <Card className="overflow-hidden border-primary/30 bg-background/95 shadow-lg ring-1 ring-primary/10">
                <CardHeader className="border-b bg-gradient-to-r from-primary/10 via-background to-muted/70 pb-4 dark:to-background/30">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base flex items-center gap-2">
                        <span className="rounded-xl bg-primary/10 p-2 text-primary">
                          <GitCompare className="h-4 w-4" />
                        </span>
                        Property Comparison: Cash Flow ({comparisonReports.length + 1} Properties)
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">Side-by-side projected value and after-tax cash-flow performance.</p>
                    </div>
                    <div className="flex flex-col gap-2 sm:items-end">
                      <Badge variant="outline" className="w-fit text-xs">
                        Comparing {comparisonReports.length + 1} properties
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => exportChartAsPNG(comparisonChartRef, 'property-comparison')}
                        className="h-8 w-full justify-center gap-2 rounded-xl sm:w-auto"
                      >
                        <Image className="h-4 w-4" />
                        Export PNG
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-4">
                  <div ref={comparisonChartRef} className="h-[320px] w-full rounded-3xl border bg-white p-3 shadow-inner sm:h-[380px] xl:h-[420px]" style={{ backgroundColor: '#ffffff' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={projections.filter(p => p.year >= 1).map((p, i) => {
                          const dataPoint: any = {
                            year: `Year ${p.year}`,
                            [`${report?.property_address.split(',')[0]} Value`]: p.propertyMarketValue,
                          };
                          allComparisonProjections.forEach(({ report: compReport, projections: compProjs }, idx) => {
                            dataPoint[`${compReport.property_address.split(',')[0]} Value`] = compProjs[i + 1]?.propertyMarketValue || 0;
                          });
                          return dataPoint;
                        })}
                        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="year" className="text-xs" tick={{ fontSize: 11 }} />
                        <YAxis 
                          className="text-xs" 
                          tick={{ fontSize: 11 }} 
                          tickFormatter={(value) => {
                            if (Math.abs(value) >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
                            if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
                            return `$${value}`;
                          }}
                        />
                        <Tooltip 
                          formatter={(value: number) => [`$${value.toLocaleString('en-AU')}`, undefined]}
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--background))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '6px',
                            fontSize: '11px'
                          }}
                        />
                        <Legend wrapperStyle={{ fontSize: '9px' }} />
                        <Line 
                          type="monotone" 
                          dataKey={`${report?.property_address.split(',')[0]} Value`}
                          stroke={COMPARISON_COLORS[0].value} 
                          strokeWidth={2}
                          dot={{ r: 2 }}
                        />
                        {allComparisonProjections.map(({ report: compReport }, idx) => (
                          <Line 
                            key={compReport.id}
                            type="monotone" 
                            dataKey={`${compReport.property_address.split(',')[0]} Value`}
                            stroke={COMPARISON_COLORS[idx + 1]?.value || '#888'}
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            dot={{ r: 2 }}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  
                  {/* Winner Indicator Cards */}
                  {(() => {
                    const primaryAddr = report?.property_address.split(',')[0] || 'Primary';
                    const allProps = [
                      { name: primaryAddr, yr10Value: projections[10]?.propertyMarketValue || 0, yr10Equity: projections[10]?.equityInProperty || 0, yr10Yield: projections[10]?.grossYield || 0, totalCashFlow: projections.filter(p => p.year >= 1).reduce((s, p) => s + p.afterTaxCashFlowPA, 0), color: COMPARISON_COLORS[0].value },
                      ...allComparisonProjections.map(({ report: cr, projections: cp }, idx) => ({
                        name: cr.property_address.split(',')[0],
                        yr10Value: cp[10]?.propertyMarketValue || 0,
                        yr10Equity: cp[10]?.equityInProperty || 0,
                        yr10Yield: cp[10]?.grossYield || 0,
                        totalCashFlow: cp.filter((_: any, i: number) => i >= 1).reduce((s: number, p: any) => s + (p.afterTaxCashFlowPA || 0), 0),
                        color: COMPARISON_COLORS[idx + 1]?.value || '#888',
                      }))
                    ];
                    
                    const categories = [
                      { label: 'Highest Growth', icon: '📈', getValue: (p: any) => p.yr10Value, format: (v: number) => `$${v.toLocaleString('en-AU')}` },
                      { label: 'Most Equity', icon: '🏠', getValue: (p: any) => p.yr10Equity, format: (v: number) => `$${v.toLocaleString('en-AU')}` },
                      { label: 'Best Yield', icon: '💰', getValue: (p: any) => p.yr10Yield, format: (v: number) => `${v.toFixed(2)}%` },
                      { label: 'Best Cash Flow', icon: '💵', getValue: (p: any) => p.totalCashFlow, format: (v: number) => `$${v.toLocaleString('en-AU')}` },
                    ];

                    return (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 pt-3 border-t">
                        {categories.map(cat => {
                          const winner = [...allProps].sort((a, b) => cat.getValue(b) - cat.getValue(a))[0];
                          return (
                            <div key={cat.label} className="bg-muted/40 rounded-lg p-2.5 text-center space-y-1">
                              <p className="text-[10px] text-muted-foreground font-medium">{cat.icon} {cat.label}</p>
                              <p className="text-xs font-bold truncate" style={{ color: winner.color }}>{winner.name}</p>
                              <p className="text-[10px] font-semibold text-success-foreground">{cat.format(cat.getValue(winner))}</p>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  
                  {/* Advanced Investment Metrics Comparison */}
                  <div className="mt-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold">Investment Metrics Comparison ({comparisonReports.length + 1} Properties)</h4>
                      <div className="flex items-center gap-2">
                        {/*
                          Beside the existing export, not instead of it. This one
                          typesets every property's full projection server-side;
                          the one next to it rasterises the charts on this screen
                          and prints eight metric rows. They are different
                          documents and both are worth having.
                        */}
                        <CashFlowComparisonDownloadButton
                          build={buildWireComparison}
                          unavailableReason={comparisonUnavailableReason}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => exportComparisonPDF()}
                          className="gap-2"
                        >
                          <FileText className="h-4 w-4" />
                          Export PDF
                        </Button>
                        <FlattenPdfIconButton
                          getPdfBlob={async () => {
                            const b = await exportComparisonPDF({ returnBlob: true });
                            if (!b) throw new Error('Failed to generate comparison PDF');
                            return b;
                          }}
                          filename={`cash-flow-comparison-${comparisonReports.length + 1}-properties-${new Date().toISOString().split('T')[0]}.pdf`}
                        />
                      </div>
                    </div>
                    
                    {/* Metrics Table */}
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="min-w-[140px] sticky left-0 bg-background">Metric</TableHead>
                            <TableHead className="text-center min-w-[120px]">
                              <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: COMPARISON_COLORS[0].value }} />
                              {report?.property_address.split(',')[0].substring(0, 15)}
                            </TableHead>
                            {allComparisonMetrics.map(({ report: compReport }, idx) => (
                              <TableHead key={compReport.id} className="text-center min-w-[120px]">
                                <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: COMPARISON_COLORS[idx + 1]?.value || '#888' }} />
                                {compReport.property_address.split(',')[0].substring(0, 15)}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[
                            { label: '10-Year ROI', key: 'roi', format: (v: number) => `${v?.toFixed(1)}%`, higherBetter: true },
                            { label: 'Annualized ROI', key: 'annualizedRoi', format: (v: number) => `${v?.toFixed(2)}%`, higherBetter: true },
                            { label: 'Total Return', key: 'totalReturn', format: (v: number) => `$${(v || 0).toLocaleString('en-AU')}`, higherBetter: true },
                            { label: 'Break-Even Year', key: 'breakEvenYear', format: (v: number) => v ? `Year ${v}` : 'N/A', higherBetter: false },
                            { label: 'Cash-on-Cash (Y1)', key: 'cashOnCash', format: (v: number) => `${v?.toFixed(2)}%`, higherBetter: true },
                            { label: 'Equity Multiple', key: 'equityMultiple', format: (v: number) => `${v?.toFixed(2)}x`, higherBetter: true },
                            { label: 'Capital Gain', key: 'capitalGain', format: (v: number) => `$${(v || 0).toLocaleString('en-AU')}`, higherBetter: true },
                            { label: 'Total Cash Flow', key: 'totalCashFlow', format: (v: number) => `$${(v || 0).toLocaleString('en-AU')}`, higherBetter: true },
                          ].map(({ label, key, format, higherBetter }) => {
                            const allValues = [
                              (primaryMetrics as any)?.[key] || (key === 'breakEvenYear' ? 99 : 0),
                              ...allComparisonMetrics.map(({ metrics }) => (metrics as any)?.[key] || (key === 'breakEvenYear' ? 99 : 0))
                            ];
                            const bestValue = higherBetter 
                              ? Math.max(...allValues.filter(v => v !== 99 && v !== null))
                              : Math.min(...allValues.filter(v => v !== 99 && v !== null));
                            
                            return (
                              <TableRow key={key}>
                                <TableCell className="font-medium sticky left-0 bg-background">{label}</TableCell>
                                <TableCell className={`text-center ${(primaryMetrics as any)?.[key] === bestValue ? 'text-success font-semibold' : ''}`}>
                                  {format((primaryMetrics as any)?.[key])}
                                </TableCell>
                                {allComparisonMetrics.map(({ report: compReport, metrics }) => (
                                  <TableCell key={compReport.id} className={`text-center ${(metrics as any)?.[key] === bestValue ? 'text-success font-semibold' : ''}`}>
                                    {format((metrics as any)?.[key])}
                                  </TableCell>
                                ))}
                              </TableRow>
                            );
                          })}
                          <TableRow className="bg-muted/30">
                            <TableCell className="font-medium sticky left-0 bg-muted/30">Year 10 Property Value</TableCell>
                            <TableCell className="text-center">
                              ${(projections[10]?.propertyMarketValue || 0).toLocaleString('en-AU')}
                            </TableCell>
                            {allComparisonProjections.map(({ report: compReport, projections: compProjs }) => (
                              <TableCell key={compReport.id} className="text-center">
                                ${(compProjs[10]?.propertyMarketValue || 0).toLocaleString('en-AU')}
                              </TableCell>
                            ))}
                          </TableRow>
                          <TableRow className="bg-muted/30">
                            <TableCell className="font-medium sticky left-0 bg-muted/30">Year 10 Equity</TableCell>
                            <TableCell className="text-center">
                              ${(projections[10]?.equityInProperty || 0).toLocaleString('en-AU')}
                            </TableCell>
                            {allComparisonProjections.map(({ report: compReport, projections: compProjs }) => (
                              <TableCell key={compReport.id} className="text-center">
                                ${(compProjs[10]?.equityInProperty || 0).toLocaleString('en-AU')}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Property Recommendation Engine */}
            {comparisonMode && comparisonReports.length > 0 && propertyRecommendation && (
              <Card className="border-brand-500/30 bg-brand-500/5">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Target className="h-4 w-4 text-brand-600" />
                      Investment Recommendation Engine
                    </CardTitle>
                    <Select value={investorProfile} onValueChange={(v) => setInvestorProfile(v as any)}>
                      <SelectTrigger className="w-[180px] h-8">
                        <SelectValue placeholder="Select Profile" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="growth">
                          <div className="flex items-center gap-2">
                            <TrendingUp className="h-3 w-3 text-info-foreground" />
                            Growth Focused
                          </div>
                        </SelectItem>
                        <SelectItem value="income">
                          <div className="flex items-center gap-2">
                            <DollarSign className="h-3 w-3 text-success-foreground" />
                            Income Focused
                          </div>
                        </SelectItem>
                        <SelectItem value="balanced">
                          <div className="flex items-center gap-2">
                            <Zap className="h-3 w-3 text-accent-foreground" />
                            Balanced
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Profile Description */}
                  <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                    {investorProfile === 'growth' && (
                      <span><strong>Growth Focused:</strong> Prioritizes capital appreciation, ROI, and equity growth over immediate cash flow.</span>
                    )}
                    {investorProfile === 'income' && (
                      <span><strong>Income Focused:</strong> Prioritizes positive cash flow, high rental yields, and early break-even.</span>
                    )}
                    {investorProfile === 'balanced' && (
                      <span><strong>Balanced:</strong> Seeks optimal mix of capital growth and income generation.</span>
                    )}
                  </div>

                  {/* Winner Announcement */}
                  <div className="flex items-start gap-4 p-4 rounded-lg border-2 border-brand-500/40 bg-gradient-to-r from-brand-500/10 to-transparent">
                    <Award className={`h-10 w-10 ${propertyRecommendation.confidence === 'high' ? 'text-brand-500' : propertyRecommendation.confidence === 'moderate' ? 'text-brand-400' : 'text-brand-300'}`} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold text-lg">
                          {propertyRecommendation.winner}
                        </h4>
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${
                            propertyRecommendation.confidence === 'high' 
                              ? 'border-success/30 text-success' 
                              : propertyRecommendation.confidence === 'moderate'
                              ? 'border-brand-500 text-brand-600'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          {propertyRecommendation.confidence} confidence
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        Best suited for {investorProfile === 'growth' ? 'growth-focused' : investorProfile === 'income' ? 'income-focused' : 'balanced'} investors
                      </p>
                      
                      {/* Rankings */}
                      <div className="space-y-2 mb-3">
                        <div className="text-xs font-semibold">Property Rankings:</div>
                        <div className="flex flex-wrap gap-2">
                          {propertyRecommendation.rankings.map((r, idx) => (
                            <div 
                              key={r.name}
                              className={`text-center px-3 py-1 rounded ${idx === 0 ? 'bg-success/20 border border-success/40' : 'bg-muted/50'}`}
                            >
                              <div className="text-[10px] text-muted-foreground">#{r.rank}</div>
                              <div className="text-xs font-medium">{r.name}</div>
                              <div className="text-xs font-semibold">{r.score} pts</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Key Insights */}
                      {propertyRecommendation.insights.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-success mb-1">Key Insights:</div>
                          <ul className="text-xs space-y-1">
                            {propertyRecommendation.insights.map((insight, i) => (
                              <li key={i} className="flex items-start gap-1">
                                <span className="text-success-foreground mt-0.5">✓</span>
                                <span>{insight}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Disclaimer */}
                  <p className="text-[10px] text-muted-foreground italic">
                    This recommendation is based on projected data and the selected investor profile. Actual results may vary. 
                    Always conduct thorough due diligence before making investment decisions.
                  </p>
                </CardContent>
              </Card>
            )}

            </CashFlowChartsWorkspace>

            <CashFlowAiPanel active={comparisonMode && comparisonReports.length > 0}>
            {/* AI-Powered Comparison Analysis */}
            {comparisonMode && comparisonReports.length > 0 && (
              <Card className="overflow-hidden border-info/30 bg-gradient-to-br from-info/5 via-background to-background shadow-sm">
                <CardHeader className="border-b bg-info/5 pb-4">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <span className="rounded-xl bg-info/10 p-2 text-info">
                          <Zap className="h-4 w-4" />
                        </span>
                        AI Cash Flow Decision Support
                      </CardTitle>
                      <p className="max-w-2xl text-xs text-muted-foreground">
                        Generate a profile-aware comparison analysis across selected properties, rankings, and recommendations.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-xs">{comparisonReports.length + 1} properties selected</Badge>
                        {isLoadingAnalysis && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <RotateCcw className="h-3 w-3 animate-spin" />
                            Loading analysis
                          </Badge>
                        )}
                        {savedAnalysisId ? (
                          <Badge variant="secondary" className="text-xs gap-1">
                            <Save className="h-3 w-3" />
                            Saved analysis
                          </Badge>
                        ) : aiAnalysis ? (
                          <Badge variant="outline" className="border-warning/30 text-warning text-xs">Unsaved analysis</Badge>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 xl:items-end">
                      <Select value={investorProfile} onValueChange={(v) => setInvestorProfile(v as any)}>
                        <SelectTrigger className="h-9 w-full sm:w-[190px]">
                          <SelectValue placeholder="Investor profile" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="growth">Growth focused</SelectItem>
                          <SelectItem value="income">Income focused</SelectItem>
                          <SelectItem value="balanced">Balanced</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
                        {aiAnalysis && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={saveAiAnalysis}
                              disabled={isSavingAnalysis}
                              className="gap-1"
                            >
                              {isSavingAnalysis ? (
                                <RotateCcw className="h-3 w-3 animate-spin" />
                              ) : (
                                <Save className="h-3 w-3" />
                              )}
                              {savedAnalysisId ? 'Update' : 'Save'}
                            </Button>
                            {/*
                              The analysis panel gets it too, because this is
                              where an adviser is when they have just generated
                              one — and the typeset document is the only one of
                              the three that carries both the prose and the
                              figures it was written from.
                            */}
                            <CashFlowComparisonDownloadButton
                              build={buildWireComparison}
                              unavailableReason={comparisonUnavailableReason}
                              label="Typeset"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => exportAiAnalysisPDF()}
                              className="gap-1"
                            >
                              <Download className="h-3 w-3" />
                              Export PDF
                            </Button>
                            <FlattenPdfIconButton
                              getPdfBlob={async () => {
                                const b = await exportAiAnalysisPDF({ returnBlob: true });
                                if (!b) throw new Error('Failed to generate AI analysis PDF');
                                return b;
                              }}
                              filename={`ai-cash-flow-analysis-${new Date().toISOString().split('T')[0]}.pdf`}
                            />
                          </>
                        )}
                        <Button
                          size="sm"
                          onClick={generateAiAnalysis}
                          disabled={isGeneratingAiAnalysis || isLoadingAnalysis}
                          className="bg-info hover:bg-info"
                        >
                          {isGeneratingAiAnalysis ? (
                            <>
                              <RotateCcw className="h-3 w-3 mr-1 animate-spin" />
                              Analyzing...
                            </>
                          ) : (
                            <>
                              <Zap className="h-3 w-3 mr-1" />
                              {aiAnalysis ? 'Regenerate' : 'Generate AI Analysis'}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 p-4">
                  <div className="grid gap-2 rounded-2xl border bg-background/80 p-3 text-xs text-muted-foreground md:grid-cols-2">
                    <div>
                      <span className="font-medium text-foreground">Primary:</span> {report.property_address}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Comparing:</span> {comparisonReports.map(r => r.property_address.split(',')[0]).join(' • ')}
                    </div>
                  </div>

                  {!aiAnalysis && !isGeneratingAiAnalysis && (
                    <p className="text-sm text-muted-foreground">
                      Click "Generate AI Analysis" to get an in-depth AI-powered comparison of cash flow projections, 
                      investment potential, and personalized recommendations based on your investor profile.
                    </p>
                  )}
                  
                  {isGeneratingAiAnalysis && (
                    <div className="flex items-center justify-center py-8">
                      <div className="text-center">
                        <RotateCcw className="h-8 w-8 animate-spin mx-auto mb-2 text-info-foreground" />
                        <p className="text-sm text-muted-foreground">Analyzing cash flow projections...</p>
                      </div>
                    </div>
                  )}
                  
                  {aiAnalysis && (
                    <div className="max-h-[min(70vh,900px)] space-y-4 overflow-y-auto overscroll-contain rounded-3xl border border-brand-300/25 bg-background/95 dark:bg-background/95 p-3 shadow-2xl shadow-foreground/20 ring-1 ring-brand-400/15 sm:p-4 [scrollbar-gutter:stable]">
                      {/* Executive Summary */}
                      {aiAnalysis.executiveSummary && (
                        <div className="min-w-0 rounded-2xl border border-brand-300/30 bg-gradient-to-br from-card dark:from-background via-card dark:via-background to-card dark:to-background p-4 shadow-lg shadow-sm dark:shadow-black/20 ring-1 ring-brand-400/10 sm:p-5">
                          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-100"><Zap className="h-4 w-4 shrink-0 text-brand-300" /><span>Executive Summary</span></h4>
                          <p className="whitespace-normal text-sm leading-7 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.executiveSummary}</p>
                        </div>
                      )}
                      
                      {/* Final Rankings */}
                      {aiAnalysis.finalRankings && aiAnalysis.finalRankings.length > 0 && (
                        <div className="min-w-0 rounded-2xl border border-brand-300/25 bg-gradient-to-br from-card dark:from-background via-card dark:via-background to-info/40 p-4 shadow-lg shadow-sm dark:shadow-black/20 ring-1 ring-brand-400/10 sm:p-5">
                          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-100"><Zap className="h-4 w-4 shrink-0 text-brand-300" /><span>Property Rankings</span></h4>
                          <div className="space-y-2">
                            {aiAnalysis.finalRankings.map((ranking: any, idx: number) => (
                              <div key={idx} className={`min-w-0 rounded-xl p-3 ${idx === 0 ? 'bg-success/10 border border-success/30' : 'bg-background/60 border border-border/80'}`}>
                                <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
                                  <Badge variant={idx === 0 ? 'default' : 'outline'} className="text-xs">
                                    #{ranking.rank}
                                  </Badge>
                                  <span className="min-w-0 text-sm font-medium text-foreground dark:text-foreground [overflow-wrap:anywhere]">{ranking.address}</span>
                                  {ranking.score && (
                                    <Badge variant="secondary" className="text-xs ml-auto">
                                      Score: {typeof ranking.score === 'number' ? ranking.score.toFixed(1) : ranking.score}
                                    </Badge>
                                  )}
                                </div>
                                {ranking.verdict && (
                                  <p className="mt-1 whitespace-normal text-xs leading-6 text-muted-foreground dark:text-foreground [overflow-wrap:anywhere]">{ranking.verdict}</p>
                                )}
                                {ranking.strengths && ranking.strengths.length > 0 && (
                                  <div className="mt-2">
                                    <span className="text-[10px] text-success font-medium">Strengths: </span>
                                    <span className="whitespace-normal text-[10px] leading-5 text-muted-foreground dark:text-foreground [overflow-wrap:anywhere]">{ranking.strengths.join(', ')}</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Investor Recommendations */}
                      {aiAnalysis.investorRecommendations && (
                        <div className="min-w-0 rounded-2xl border border-brand-300/25 bg-gradient-to-br from-card dark:from-background via-card dark:via-background to-card dark:to-background p-4 shadow-lg shadow-sm dark:shadow-black/20 ring-1 ring-brand-400/10 sm:p-5">
                          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-100"><Zap className="h-4 w-4 shrink-0 text-brand-300" /><span>Investor Profile Recommendations</span></h4>
                          <div className="grid min-w-0 gap-3 text-xs md:grid-cols-2">
                            {aiAnalysis.investorRecommendations.growthFocused && (
                              <div className="min-w-0 rounded-xl border border-info/20 bg-info/10 p-3">
                                <span className="font-medium text-info">Growth Focused:</span>
                                <p className="mt-2 whitespace-normal leading-6 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.investorRecommendations.growthFocused.reason}</p>
                              </div>
                            )}
                            {aiAnalysis.investorRecommendations.incomeFocused && (
                              <div className="min-w-0 rounded-xl border border-success/20 bg-success/10 p-3">
                                <span className="font-medium text-success">Income Focused:</span>
                                <p className="mt-2 whitespace-normal leading-6 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.investorRecommendations.incomeFocused.reason}</p>
                              </div>
                            )}
                            {aiAnalysis.investorRecommendations.balanced && (
                              <div className="min-w-0 rounded-xl border border-accent/20 bg-accent/10 p-3">
                                <span className="font-medium text-accent">Balanced:</span>
                                <p className="mt-2 whitespace-normal leading-6 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.investorRecommendations.balanced.reason}</p>
                              </div>
                            )}
                            {aiAnalysis.investorRecommendations.riskAverse && (
                              <div className="min-w-0 rounded-xl border border-brand-400/20 bg-brand-500/10 p-3">
                                <span className="font-medium text-brand-600">Risk Averse:</span>
                                <p className="mt-2 whitespace-normal leading-6 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.investorRecommendations.riskAverse.reason}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {/* Overall Recommendation */}
                      {aiAnalysis.overallRecommendation?.bestProperty && (
                        <div className="min-w-0 rounded-2xl border border-brand-300/35 bg-gradient-to-br from-success/50 via-card dark:via-background to-card dark:to-background p-4 shadow-lg shadow-sm dark:shadow-black/20 ring-1 ring-brand-400/10 sm:p-5">
                          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand-100"><Zap className="h-4 w-4 shrink-0 text-brand-300" /><span>Best Overall Property</span></h4>
                          <p className="whitespace-normal text-sm leading-7 text-foreground dark:text-foreground [overflow-wrap:anywhere]">{aiAnalysis.overallRecommendation.bestProperty.reason}</p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            <Card className="border-primary/20 bg-primary/5">
              <CardContent className="py-3">
                <p className="text-sm text-muted-foreground">
                  <strong>Tip:</strong> Click on any cell in Years 1-10 to edit values directly. Year 0 (Today) is the reference point and cannot be edited. 
                  Cells with <span className="text-primary font-semibold">blue highlighting</span> have been overridden.
                </p>
              </CardContent>
            </Card>

            </CashFlowAiPanel>

            {/* Inputs Summary Table - Collapsible */}
            <Collapsible open={inputsSummaryOpen} onOpenChange={setInputsSummaryOpen}>
              <Card>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        {inputsSummaryOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {isNewBuild ? 'New Build' : 'Existing Property'} - SUMMARY
                      </span>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <label className="flex items-center gap-2 text-xs font-normal text-muted-foreground cursor-pointer">
                          <Checkbox
                            checked={includeInputsSummaryInExport}
                            onCheckedChange={(checked) => setIncludeInputsSummaryInExport(checked === true)}
                          />
                          Include in PDF/Print
                        </label>
                      </div>
                    </CardTitle>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="pt-0">
                    {/* INPUTS Section */}
                    <div className="border-b-2 border-muted pb-2 mb-3">
                      <h4 className="text-sm font-bold text-center tracking-wide">INPUTS</h4>
                    </div>
                    <Table>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium w-1/2">Purchase Price</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.purchasePrice)}</TableCell>
                        </TableRow>
                        {isNewBuild && (
                          <>
                            <TableRow>
                              <TableCell className="font-medium">Land Price</TableCell>
                              <TableCell className="text-right">{formatCurrency(baseFinancialData.landPrice)}</TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell className="font-medium">Build Price</TableCell>
                              <TableCell className="text-right">{formatCurrency(baseFinancialData.buildPrice || (baseFinancialData.purchasePrice - baseFinancialData.landPrice))}</TableCell>
                            </TableRow>
                          </>
                        )}
                        {/* Only show Deposit Value for existing properties */}
                        {!isNewBuild && (
                          <TableRow>
                            <TableCell className="font-medium">Deposit Value</TableCell>
                            <TableCell className="text-right">{formatCurrency(baseFinancialData.depositValue || (baseFinancialData.purchasePrice * (1 - baseFinancialData.loanToValueRatio / 100)))}</TableCell>
                          </TableRow>
                        )}
                        <TableRow>
                          <TableCell className="font-medium">Loan to Value ratio</TableCell>
                          <TableCell className="text-right">{baseFinancialData.loanToValueRatio}%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Interest Rate</TableCell>
                          <TableCell className="text-right">{baseFinancialData.interestRate.toFixed(2)}%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Capital Growth</TableCell>
                          <TableCell className="text-right">{baseFinancialData.capitalGrowth}%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Weekly Rent</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.weeklyRent)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Stamp Duty</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.stampDuty)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Body Corporate / Strata Fees</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.bodyCorporateFees)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Council Rate Charges</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.councilRates)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Water Rate Charges (Other)</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.waterRates)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Solicitor Fees</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.solicitorFees)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Building & Landlord Insurance</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.buildingLandlordInsurance)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Property Management Fees</TableCell>
                          <TableCell className="text-right">{baseFinancialData.propertyManagementFees}%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Repairs & Maintenance</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.repairsMaintenance)}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Letting Fees (1 Week Rent)</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.lettingFees || baseFinancialData.weeklyRent)}</TableCell>
                        </TableRow>
                         <TableRow>
                          <TableCell className="font-medium">Land Tax (p.a.)</TableCell>
                          <TableCell className="text-right">{formatCurrency(baseFinancialData.landTax)}</TableCell>
                        </TableRow>
                        {baseFinancialData.lmiAmount > 0 && (
                          <TableRow className="bg-brand-50 dark:bg-brand-950/30">
                            <TableCell className="font-medium">LMI (Lenders Mortgage Insurance)</TableCell>
                            <TableCell className="text-right font-semibold">{formatCurrency(baseFinancialData.lmiAmount)}</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                    
                    {/* Cash Flow Analysis Inputs Section */}
                    <div className="mt-6 pt-4 border-t-2 border-muted">
                      <div className="border-b border-muted pb-2 mb-3">
                        <h4 className="text-sm font-bold">Cash Flow Analysis Inputs</h4>
                      </div>
                      <Table>
                        <TableBody>
                          <TableRow>
                            <TableCell className="font-medium w-1/2">Loan Amount</TableCell>
                            <TableCell className="text-right">{formatCurrency(baseFinancialData.loanAmount)}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Loan Type</TableCell>
                            <TableCell className="text-right">{baseFinancialData.loanType === 'interest_only' ? 'Interest Only' : 'Principal & Interest'}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Loan Term</TableCell>
                            <TableCell className="text-right">{baseFinancialData.loanTermYears} years</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Occupancy Rate</TableCell>
                            <TableCell className="text-right">{baseFinancialData.occupancyRate} weeks/year</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">CPI / Expense Growth Rate</TableCell>
                            <TableCell className="text-right">{baseFinancialData.cpiGrowthRate}%</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="font-medium">Tax Rate (Marginal)</TableCell>
                            <TableCell className="text-right">{baseFinancialData.taxRate}%</TableCell>
                          </TableRow>
                          <TableRow className={baseFinancialData.depreciation > 0 ? 'bg-brand-50 dark:bg-brand-950/30' : ''}>
                            <TableCell className="font-medium">
                              Annual Depreciation (Year 1)
                              {baseFinancialData.includeDepreciationInCashFlow ? '' : ' (Excluded)'}
                              {baseFinancialData.depreciationSchedule ? (
                                <Badge variant="outline" className="ml-2 text-xs">
                                  10-Year Schedule ({baseFinancialData.depreciationMethod?.toUpperCase() || 'DV'})
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {formatCurrency(baseFinancialData.depreciation)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                    
                    {/* Total Upfront Costs + Total Overall Expenditure to Completion */}
                    {(() => {
                      const depositValue = baseFinancialData.depositValue || (baseFinancialData.purchasePrice * (1 - (baseFinancialData.loanToValueRatio || 80) / 100));
                      const depositPct = baseFinancialData.purchasePrice > 0 ? Math.round((depositValue / baseFinancialData.purchasePrice) * 100) : 0;
                      const stampDuty = baseFinancialData.stampDuty || 0;
                      const solicitorFees = baseFinancialData.solicitorFees || 0;
                      const agentFee = baseFinancialData.agentFee || 0;
                      const lmiAmount = baseFinancialData.lmiAmount || 0;

                      let upfrontRows: { label: string; value: number }[] = [];
                      let overallExtraRows: { label: string; value: number }[] = [];
                      let totalUpfront = 0;
                      let totalOverall = 0;

                      if (isNewBuild && constructionProgressSchedule) {
                        const landDeposit = constructionProgressSchedule.upfrontCosts.tenPercentLand;
                        const buildDeposit = constructionProgressSchedule.upfrontCosts.fivePercentBuild;
                        const constructionProgressTotal = constructionProgressSchedule.buildPrice;
                        const stagedInterest = constructionProgressSchedule.totals.totalCombinedRepayment;
                        upfrontRows = [
                          { label: '10% Land Deposit', value: landDeposit },
                          { label: '5% Build Contract Deposit', value: buildDeposit },
                          { label: 'Stamp Duty', value: stampDuty },
                          { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                          { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
                          ...(lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: lmiAmount }] : []),
                        ];
                        totalUpfront = landDeposit + buildDeposit + stampDuty + solicitorFees + stagedInterest + lmiAmount;
                        overallExtraRows = [
                          { label: 'Purchase Price (Land)', value: constructionProgressSchedule.landPrice },
                          { label: 'Stamp Duty', value: stampDuty },
                          { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                          { label: 'Build Price', value: constructionProgressTotal },
                          { label: `Construction Progress Payment Interest (${constructionProgressSchedule.durationMonths} months)`, value: stagedInterest },
                        ];
                        totalOverall = constructionProgressSchedule.landPrice + stampDuty + solicitorFees + constructionProgressTotal + stagedInterest;
                      } else {
                        upfrontRows = [
                          { label: `Deposit (${depositPct}% — from your funds)`, value: depositValue },
                          { label: 'Stamp Duty', value: stampDuty },
                          { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                          { label: 'Agent Fee', value: agentFee },
                          ...(lmiAmount > 0 ? [{ label: 'LMI (Lenders Mortgage Insurance)', value: lmiAmount }] : []),
                        ];
                        totalUpfront = depositValue + stampDuty + solicitorFees + agentFee + lmiAmount;
                        overallExtraRows = [
                          { label: 'Purchase Price', value: baseFinancialData.purchasePrice },
                          { label: 'Stamp Duty', value: stampDuty },
                          { label: 'Solicitor / Conveyancer Cost', value: solicitorFees },
                          { label: 'Agent Fee', value: agentFee },
                        ];
                        totalOverall = baseFinancialData.purchasePrice + stampDuty + solicitorFees + agentFee;
                      }

                      return (
                        <>
                          <div className="mt-6 pt-4 border-t-2 border-muted">
                            <div className="border-b border-muted pb-2 mb-3">
                              <h4 className="text-sm font-bold">Total Upfront Costs</h4>
                            </div>
                            <Table>
                              <TableBody>
                                {upfrontRows.map((r, i) => (
                                  <TableRow key={`up-${i}`}>
                                    <TableCell className="font-medium w-1/2">{r.label}</TableCell>
                                    <TableCell className="text-right">{formatCurrency(r.value)}</TableCell>
                                  </TableRow>
                                ))}
                                <TableRow className="bg-muted/30">
                                  <TableCell className="font-semibold">Total Upfront Costs</TableCell>
                                  <TableCell className="text-right font-semibold">{formatCurrency(totalUpfront)}</TableCell>
                                </TableRow>
                              </TableBody>
                            </Table>
                          </div>

                          <div className="mt-6 pt-4 border-t-2 border-muted">
                            <div className="border-b border-muted pb-2 mb-3">
                              <h4 className="text-sm font-bold">Total Overall Expenditure to Completion</h4>
                            </div>
                            <Table>
                              <TableBody>
                                {overallExtraRows.map((r, i) => (
                                  <TableRow key={`ov-${i}`}>
                                    <TableCell className="font-medium w-1/2">{r.label}</TableCell>
                                    <TableCell className="text-right">{formatCurrency(r.value)}</TableCell>
                                  </TableRow>
                                ))}
                                <TableRow className="bg-primary/10">
                                  <TableCell className="font-bold text-primary">Total Overall Expenditure to Completion</TableCell>
                                  <TableCell className="text-right font-bold text-primary">{formatCurrency(totalOverall)}</TableCell>
                                </TableRow>
                              </TableBody>
                            </Table>
                          </div>
                        </>
                      );
                    })()}
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>

            <CashFlowConstructionPanel active={isNewBuild && !!constructionProgressSchedule && constructionProgressSchedule.buildPrice > 0}>
            {/* Construction Progress Payment Schedule - Collapsible (New Builds Only) */}
            {isNewBuild && constructionProgressSchedule && constructionProgressSchedule.buildPrice > 0 && (
              <Collapsible open={constructionScheduleOpen} onOpenChange={setConstructionScheduleOpen}>
                <Card className="overflow-hidden border-brand-200/70 bg-gradient-to-br from-brand-50/40 via-background to-background shadow-sm dark:border-brand-900/40 dark:from-brand-950/20">
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer border-b bg-brand-50/50 transition-colors hover:bg-brand-50 dark:bg-brand-950/20 dark:hover:bg-brand-950/30">
                      <CardTitle className="flex flex-col gap-3 text-base lg:flex-row lg:items-center lg:justify-between">
                        <span className="flex items-center gap-2">
                          <span className="rounded-xl bg-brand-500/10 p-2 text-brand-600">
                            {constructionScheduleOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </span>
                          <span>
                            Construction Progress Payment Schedule
                            <span className="block text-xs font-normal text-muted-foreground">New build staged drawdown and interest workflow</span>
                          </span>
                        </span>
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <label className="flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1.5 text-xs font-normal text-muted-foreground cursor-pointer">
                            <Checkbox
                              checked={includeConstructionScheduleInExport}
                              onCheckedChange={(checked) => setIncludeConstructionScheduleInExport(checked === true)}
                            />
                            Include in PDF/Print
                          </label>
                        </div>
                      </CardTitle>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="space-y-4 p-4">
                      {/* Preset Selection */}
                      <div className="flex flex-col gap-3 rounded-2xl border bg-background/80 p-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <span className="text-sm font-medium">Schedule Mode:</span>
                          <Select value={schedulePreset} onValueChange={(value: 'rapid' | 'even' | 'custom') => setSchedulePreset(value)}>
                            <SelectTrigger className="w-full sm:w-[220px]">
                              <SelectValue placeholder="Select mode" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="rapid">Rapid Build (Months 2-7)</SelectItem>
                              <SelectItem value="even">Even Distribution</SelectItem>
                              <SelectItem value="custom">Custom Positioning</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <span className="max-w-2xl text-xs text-muted-foreground">
                          {schedulePreset === 'rapid' && 'Stages are fixed at months 2-7. Additional months show interest-only rows.'}
                          {schedulePreset === 'even' && `Stages are evenly distributed across ${constructionProgressSchedule.durationMonths} months.`}
                          {schedulePreset === 'custom' && 'Customize which month each stage occurs. Click on the month column to edit.'}
                        </span>
                      </div>

                      {/* Custom Stage Month Selection (only in custom mode) */}
                      {schedulePreset === 'custom' && (
                        <div className="rounded-2xl border border-info/30 bg-info/10 p-4 dark:border-info/30 dark:bg-info/30">
                          <h5 className="text-sm font-medium mb-3 text-info dark:text-info-foreground">Custom Stage Positioning</h5>
                          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                            {[
                              { index: 0, label: 'Deposit' },
                              { index: 1, label: 'Slab/Base' },
                              { index: 2, label: 'Frame' },
                              { index: 3, label: 'Lock-up' },
                              { index: 4, label: 'Fixing' },
                              { index: 5, label: 'Completion' },
                            ].map(({ index, label }) => (
                              <div key={index} className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground">{label}</label>
                                <Select 
                                  value={String(customStageMonths[index] || (index + 2))}
                                  onValueChange={(value) => {
                                    setCustomStageMonths(prev => ({
                                      ...prev,
                                      [index]: parseInt(value, 10)
                                    }));
                                  }}
                                >
                                  <SelectTrigger className="h-8">
                                    <SelectValue placeholder="Month" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Array.from({ length: constructionProgressSchedule.durationMonths - 1 }, (_, i) => i + 2).map(month => (
                                      <SelectItem key={month} value={String(month)}>
                                        Month {month}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">
                            Note: Multiple stages can occur in the same month. Interest calculations update automatically.
                          </p>
                        </div>
                      )}

                      {/* Project Summary */}
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-2xl border bg-background/80 p-4">
                          <span className="text-xs text-muted-foreground">Land Cost</span>
                          <p className="mt-1 text-lg font-semibold">{formatCurrency(constructionProgressSchedule.landPrice)}</p>
                        </div>
                        <div className="rounded-2xl border bg-background/80 p-4">
                          <span className="text-xs text-muted-foreground">Build Contract</span>
                          <p className="mt-1 text-lg font-semibold">{formatCurrency(constructionProgressSchedule.buildPrice)}</p>
                        </div>
                        <div className="rounded-2xl border bg-primary/5 p-4">
                          <span className="text-xs text-muted-foreground">Total Project</span>
                          <p className="mt-1 text-lg font-semibold text-primary">{formatCurrency(constructionProgressSchedule.totalProject)}</p>
                        </div>
                      </div>

                      {/* Build Contract Breakdown */}
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                        <h4 className="text-sm font-semibold">Build Progress Table</h4>
                        <p className="text-xs text-muted-foreground">{constructionProgressSchedule.durationMonths} month construction schedule</p>
                      </div>
                      <div className="max-w-full overflow-x-auto rounded-2xl border bg-background [-webkit-overflow-scrolling:touch]">
                      <Table className="min-w-[980px]">
                        <TableHeader>
                          <TableRow className="bg-card dark:bg-background hover:bg-background">
                            <TableHead className="font-semibold text-foreground dark:text-white">Stage</TableHead>
                            <TableHead className="font-semibold text-foreground dark:text-white">Description</TableHead>
                            <TableHead className="text-center font-semibold text-foreground dark:text-white">Total Build Contract</TableHead>
                            <TableHead className="text-right font-semibold text-foreground dark:text-white">Stage Pricing</TableHead>
                            <TableHead className="text-right font-semibold text-foreground dark:text-white">Land Interest Charge (Monthly)</TableHead>
                            <TableHead className="text-right font-semibold text-foreground dark:text-white">Build Interest Charge (Monthly)</TableHead>
                            <TableHead className="text-right font-semibold text-foreground dark:text-white">Combined Repayment Breakdown</TableHead>
                            <TableHead className="text-center font-semibold text-foreground dark:text-white">Month</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {constructionProgressSchedule.stages.map((stage, idx) => (
                            <TableRow key={idx} className={idx === 0 ? 'bg-muted/20 hover:bg-muted/30' : 'hover:bg-muted/30'}>
                              <TableCell className="font-medium">{stage.stage || ''}</TableCell>
                              <TableCell className="text-muted-foreground text-sm">{stage.description || ''}</TableCell>
                              <TableCell className="text-center">{stage.percentage > 0 ? `${stage.percentage}%` : ''}</TableCell>
                              <TableCell className="text-right">{stage.buildAmount > 0 ? formatCurrency(stage.buildAmount) : ''}</TableCell>
                              <TableCell className="text-right">{formatCurrency(stage.landInterest)}</TableCell>
                              <TableCell className="text-right">{stage.buildInterest > 0 ? formatCurrency(stage.buildInterest) : ''}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(stage.totalMonthlyInterest)}</TableCell>
                              <TableCell className="text-center">{stage.month}</TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-muted/50 font-semibold border-t-2">
                            <TableCell></TableCell>
                            <TableCell></TableCell>
                            <TableCell className="text-center font-bold">100%</TableCell>
                            <TableCell className="text-right font-bold">{formatCurrency(constructionProgressSchedule.landPrice + constructionProgressSchedule.buildPrice)}</TableCell>
                            <TableCell className="text-right font-semibold">Total</TableCell>
                            <TableCell className="text-right"></TableCell>
                            <TableCell className="text-right font-bold">{formatCurrency(constructionProgressSchedule.totals.totalCombinedRepayment)}</TableCell>
                            <TableCell className="text-center"></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        * Interest calculated at {constructionProgressSchedule.interestRate}% p.a. Land interest is constant; build interest increases as stages are drawn.
                      </p>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            </CashFlowConstructionPanel>

            <CashFlowProjectionTable>
            {/* 10-Year Projection Table with Inline Editing */}
            <Card className="overflow-hidden border-border/80 bg-background/95 shadow-lg ring-1 ring-border/5">
              <CardHeader className="border-b bg-gradient-to-r from-muted via-background to-muted/70 pb-4 dark:from-background/40 dark:via-background dark:to-background/30">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <CardTitle className="text-base">10-Year Projection Overview</CardTitle>
                    <p className="text-xs text-muted-foreground">Click editable year cells to override assumptions. Edited cells are highlighted.</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
                    Edited override
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-w-full overflow-x-auto rounded-b-2xl overscroll-x-contain border-t bg-background [-webkit-overflow-scrolling:touch]">
                  <Table className="min-w-[1280px] border-separate border-spacing-0 text-sm">
                    <TableHeader className="sticky top-0 z-30 shadow-sm">
                      <TableRow className="bg-card dark:bg-background hover:bg-background">
                        <TableHead className="sticky left-0 z-30 min-w-[220px] bg-card dark:bg-background text-foreground dark:text-white shadow-[6px_0_12px_-12px_rgba(15,23,42,0.7)]">Overview</TableHead>
                        {projections.map(p => (
                          <TableHead key={p.year} className="min-w-[105px] bg-card dark:bg-background text-center text-foreground dark:text-white">
                            {p.year === 0 ? 'Today' : `Year ${p.year}`}
                            {p.year >= 1 && <span className="block text-[10px] font-normal text-muted-foreground dark:text-foreground">editable</span>}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Capital Growth Rate - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Capital Growth %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '' : renderEditableCell(
                              p.year,
                              'capitalGrowthRate',
                              p.capitalGrowthRate,
                              (v) => formatPercent(v)
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      {/* CPI Growth Rate - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">CPI Growth %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '' : renderEditableCell(
                              p.year,
                              'cpiGrowthRate',
                              p.cpiGrowthRate,
                              (v) => formatPercent(v)
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      {/* Property Value - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Property Value $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {renderEditableCell(
                              p.year,
                              'propertyMarketValue',
                              p.propertyMarketValue,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Loan Amount $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center">{p.loanAmount.toLocaleString('en-AU')}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/5 hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-primary/5 py-3 text-xs font-bold uppercase tracking-wide text-primary" colSpan={12}>Statistics</TableCell>
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Equity $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center text-success">{p.equityInProperty.toLocaleString('en-AU')}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">LVR %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center">{p.loanToValueRatio}</TableCell>
                        ))}
                      </TableRow>
                      
                      {/* Rental Income - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Rental Income $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? `${baseFinancialData.weeklyRent}pw` : renderEditableCell(
                              p.year,
                              'rentalIncome',
                              p.rentalIncome,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Gross Yield %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center">{p.year === 0 ? '' : p.grossYield}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Net Yield %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center">{p.year === 0 ? '' : p.netYield}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/5 hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-primary/5 py-3 text-xs font-bold uppercase tracking-wide text-primary" colSpan={12}>Cash Deductions</TableCell>
                      </TableRow>
                      
                      {/* Property Expenses - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Property Expenses $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '0' : renderEditableCell(
                              p.year,
                              'propertyExpenses',
                              p.propertyExpenses,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      {/* Land Tax - Editable (moved from Summary to Cash Deductions) */}
                      {!excludeLandTaxFromCashFlow && (
                        <TableRow className="transition-colors hover:bg-primary/5">
                          <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Land Tax $</TableCell>
                          {projections.map(p => (
                            <TableCell key={p.year} className="p-1 text-center align-middle">
                              {p.year === 0 ? '' : renderEditableCell(
                                p.year,
                                'landTax',
                                p.landTax,
                                (v) => v.toLocaleString('en-AU')
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      )}
                      
                      {/* Interest Rate - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Interest Rate %</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '' : renderEditableCell(
                              p.year,
                              'interestRate',
                              p.interestRate,
                              (v) => formatPercent(v)
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      {/* Interest Payments - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Interest Payments $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '0' : renderEditableCell(
                              p.year,
                              'interestPayment',
                              p.interestPayments,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      {/* Principal Payments - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Principal Payments $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '0' : renderEditableCell(
                              p.year,
                              'principalPayment',
                              p.principalPayments,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Pre-Tax Cash Flow p/a $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className={`text-center ${p.preTaxCashFlowPA < 0 ? 'text-destructive-foreground' : 'text-success'}`}>
                            {p.year === 0 ? '' : p.preTaxCashFlowPA.toLocaleString('en-AU')}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Pre-Tax Cash Flow p/w $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className={`text-center ${p.preTaxCashFlowPW < 0 ? 'text-destructive-foreground' : 'text-success'}`}>
                            {p.year === 0 ? '' : p.preTaxCashFlowPW.toLocaleString('en-AU')}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/5 hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-primary/5 py-3 text-xs font-bold uppercase tracking-wide text-primary" colSpan={12}>Non-Cash Deductions</TableCell>
                      </TableRow>
                      
                      {/* Depreciation - Editable */}
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Depreciation $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="p-1 text-center align-middle">
                            {p.year === 0 ? '' : renderEditableCell(
                              p.year,
                              'depreciation',
                              p.depreciation,
                              (v) => v.toLocaleString('en-AU')
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/5 hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-primary/5 py-3 text-xs font-bold uppercase tracking-wide text-primary" colSpan={12}>Summary</TableCell>
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Total Deductions $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center">{p.year === 0 ? '' : p.totalDeductions.toLocaleString('en-AU')}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Net Profit/Loss $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className={`text-center ${p.netProfitLoss < 0 ? 'text-destructive-foreground' : 'text-success'}`}>
                            {p.year === 0 ? '' : p.netProfitLoss.toLocaleString('en-AU')}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="transition-colors hover:bg-primary/5">
                        <TableCell className="sticky left-0 z-10 bg-background font-medium shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">Tax Refund $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className="text-center text-success">{p.year === 0 ? '' : p.taxRefund.toLocaleString('en-AU')}</TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/10">
                        <TableCell className="sticky left-0 z-10 bg-primary/10 font-bold shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">After-Tax Cash Flow p/a $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className={`text-center font-bold ${p.afterTaxCashFlowPA < 0 ? 'text-destructive-foreground' : 'text-success'}`}>
                            {p.year === 0 ? '' : p.afterTaxCashFlowPA.toLocaleString('en-AU')}
                          </TableCell>
                        ))}
                      </TableRow>
                      
                      <TableRow className="bg-primary/10">
                        <TableCell className="sticky left-0 z-10 bg-primary/10 font-bold shadow-[6px_0_12px_-12px_rgba(15,23,42,0.45)]">After-Tax Cash Flow p/w $</TableCell>
                        {projections.map(p => (
                          <TableCell key={p.year} className={`text-center font-bold ${p.afterTaxCashFlowPW < 0 ? 'text-destructive-foreground' : 'text-success'}`}>
                            {p.year === 0 ? '' : p.afterTaxCashFlowPW.toLocaleString('en-AU')}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            </CashFlowProjectionTable>
        </div>
    </CashFlowPresentationShell>

    {/* Reset Confirmation Dialog */}
    <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset All Overrides?</AlertDialogTitle>
          <AlertDialogDescription>
            This will clear all custom override values across all years and revert to calculated defaults. 
            You'll still need to click "Save Changes" to persist the reset.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleResetOverrides}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Reset All
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Send to Client Modal */}
    {report && (
      <SendToClientModal
        isOpen={sendToClientOpen}
        onClose={() => setSendToClientOpen(false)}
        reportId={report.id}
        reportTitle={`Cash Flow Analysis - ${report.property_address}`}
        reportTier="cashflow"
        storagePath={cashFlowStoragePath}
        onGeneratePDF={generateAndUploadCashFlowPDF}
      />
    )}
  </>
  );
}
