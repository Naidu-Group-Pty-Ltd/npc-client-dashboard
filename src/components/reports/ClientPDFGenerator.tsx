import { forwardRef } from 'react';
import { PixelPerfectPDFGenerator, type PixelPerfectPDFGeneratorHandle } from './PixelPerfectPDFGenerator';
import { reconcileStoredFinancials } from '@/lib/reports/investment/financialEngine.pure';
import { overlayOverridesForHistoricRow } from '@/lib/reports/investment/overrides.pure';

type ReportTier = 'compass' | 'briefing' | 'snapshot' | 'financial';

interface InvestmentReportData {
  id: string;
  property_address: string;
  report_content: string;
  demographics_data?: any;
  economic_data?: any;
  financial_calculations?: any;
  investment_score?: any;
  location_intelligence?: any;
  manual_overrides?: any;
  report_tier?: string;
  report_variant?: string | null;
  pdf_url?: string | null;
}

interface ClientPDFGeneratorProps {
  report: InvestmentReportData;
  includeSources?: boolean;
  includeScoring?: boolean;
  /** 'legacy' renders the quiet "Download (legacy layout)" presentation. */
  appearance?: 'primary' | 'legacy';
}

export const ClientPDFGenerator = forwardRef<PixelPerfectPDFGeneratorHandle, ClientPDFGeneratorProps>(({ report, includeSources = true, includeScoring = true, appearance = 'primary' }, ref) => {
  // Heal the stored projections, then overlay the overrides the way a legacy
  // renderer needs them for rows that predate recompute-on-update. Both rules
  // live with the engine — this component decides nothing about money.
  const mergedFinancialData = overlayOverridesForHistoricRow(
    reconcileStoredFinancials(report.financial_calculations || {}).fin || {},
    report.manual_overrides,
  );

  // Transform the report data to match PixelPerfectPDFGenerator expectations
  // Ensure address has a fallback to prevent .trim() errors in PDF generation
  const transformedReport = {
    id: report.id,
    address: report.property_address || 'Property Report',
    content: report.report_content || '',
    created_at: new Date().toISOString(),
    pdf_url: report.pdf_url,
    enhanced_data: {
      domainData: null,
      absData: report.demographics_data,
      rbaData: report.economic_data,
      financialData: mergedFinancialData,
      locationData: report.location_intelligence,
      investmentScore: report.investment_score,
    }
  };

  // Pass report tier to the PDF generator (defaults to 'compass' for backward compatibility)
  const reportTier = (report.report_variant || report.report_tier || 'compass') as ReportTier;

  return <PixelPerfectPDFGenerator ref={ref} report={transformedReport} includeSources={includeSources} includeScoring={includeScoring} reportTier={reportTier} appearance={appearance} />;
});

ClientPDFGenerator.displayName = 'ClientPDFGenerator';
