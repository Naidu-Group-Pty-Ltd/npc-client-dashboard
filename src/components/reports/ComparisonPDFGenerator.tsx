import { PixelPerfectPDFGenerator } from './PixelPerfectPDFGenerator';
import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { toast } from 'sonner';

interface ComparisonData {
  id: string;
  property_count: number;
  property_addresses?: string[];
  property_states?: string[];
  report_title?: string;
  executive_summary: string | null;
  rankings: any;
  financial_comparison: any;
  location_comparison: any;
  risk_comparison: any;
  recommendations: any;
  red_flags: any;
  report_ids: string[];
  created_at: string;
}

interface ComparisonPDFGeneratorProps {
  comparison: ComparisonData;
}

export function ComparisonPDFGenerator({ comparison }: ComparisonPDFGeneratorProps) {
  const [formattedContent, setFormattedContent] = useState<string | null>(null);
  const [isFormatting, setIsFormatting] = useState(true);
  const formattedForId = useRef<string | null>(null);

  // Formatted once per ROW, never per render. This effect used to key on the
  // `comparison` object itself, and both mount sites hand this component a
  // rebuilt object whenever their parent re-renders — so every re-render
  // re-entered the formatting state, which (a) replaced the download button
  // with a spinner for the length of the call ("the Download button appears
  // and then disappears"), and (b) fired ANOTHER metered model call each time.
  // A stored row's id names its content; the same id never formats twice in
  // one mount, and a genuinely different comparison (a re-run stores a new
  // row) formats exactly once.
  useEffect(() => {
    if (formattedForId.current === comparison.id) return;
    formattedForId.current = comparison.id;
    formatComparisonReport();
  }, [comparison.id]);

  const formatComparisonReport = async () => {
    try {
      setIsFormatting(true);
      console.log('Calling format-comparison-report edge function...');

      const { data, error } = await invokeSecureFunction('format-comparison-report', {
        comparisonData: comparison
      });

      if (error) {
        console.error('Error formatting report:', error);
        toast.error('Failed to format comparison report');
        // Fallback to basic formatting
        setFormattedContent(generateBasicReportContent());
      } else if (data?.formattedContent) {
        console.log('Successfully formatted comparison report');
        setFormattedContent(data.formattedContent);
      } else {
        console.warn('No formatted content returned, using fallback');
        setFormattedContent(generateBasicReportContent());
      }
    } catch (error) {
      console.error('Error in formatComparisonReport:', error);
      toast.error('Error formatting report, using basic format');
      setFormattedContent(generateBasicReportContent());
    } finally {
      setIsFormatting(false);
    }
  };

  // Fallback basic formatting function
  const generateBasicReportContent = (): string => {
    const title = comparison.report_title || `Property Comparison Analysis - ${comparison.property_count} Properties`;
    const states = comparison.property_states?.join(', ') || 'Mixed States';
    
    let content = `# ${title}\n\n`;
    content += `**Properties Compared:** ${comparison.property_count}\n`;
    content += `**States:** ${states}\n`;
    content += `**Analysis Date:** ${new Date(comparison.created_at).toLocaleDateString()}\n\n`;
    
    if (comparison.property_addresses && comparison.property_addresses.length > 0) {
      content += `**Property Addresses:**\n`;
      comparison.property_addresses.forEach((address, index) => {
        content += `${index + 1}. ${address}\n`;
      });
      content += `\n`;
    }
    
    content += `---\n\n`;
    
    if (comparison.executive_summary) {
      content += '## Executive Summary\n\n';
      content += comparison.executive_summary + '\n\n';
    }

    if (comparison.rankings) {
      content += '## Overall Rankings\n\n';
      content += JSON.stringify(comparison.rankings, null, 2) + '\n\n';
    }

    if (comparison.financial_comparison) {
      content += '## Financial Analysis\n\n';
      content += JSON.stringify(comparison.financial_comparison, null, 2) + '\n\n';
    }

    if (comparison.location_comparison) {
      content += '## Location Intelligence\n\n';
      content += JSON.stringify(comparison.location_comparison, null, 2) + '\n\n';
    }

    if (comparison.risk_comparison) {
      content += '## Risk Assessment\n\n';
      content += JSON.stringify(comparison.risk_comparison, null, 2) + '\n\n';
    }

    if (comparison.recommendations) {
      content += '## Investment Recommendations\n\n';
      content += JSON.stringify(comparison.recommendations, null, 2) + '\n\n';
    }

    if (comparison.red_flags && Array.isArray(comparison.red_flags) && comparison.red_flags.length > 0) {
      content += '## Important Considerations\n\n';
      comparison.red_flags.forEach((flag: any) => {
        content += `- ${typeof flag === 'string' ? flag : JSON.stringify(flag)}\n`;
      });
      content += '\n';
    }

    return content;
  };

  // While the report is being formatted the CONTROL stays where it is: the
  // same button, disabled, saying what it is doing. The old full-width spinner
  // block replaced the button entirely, so in a toolbar this control read as a
  // download that appeared and then vanished — and the layout jumped around it.
  if (isFormatting || !formattedContent) {
    return (
      <Button disabled className="gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Preparing Client PDF…
      </Button>
    );
  }

  // Transform comparison data to match PixelPerfectPDFGenerator expectations
  const transformedReport = {
    id: comparison.id,
    address: comparison.report_title || `Comparison Analysis - ${comparison.property_count} Properties`,
    content: formattedContent, // Use the formatted content from Perplexity
    created_at: comparison.created_at || new Date().toISOString(),
    enhanced_data: {
      domainData: null,
      absData: null,
      rbaData: null,
      financialData: comparison.financial_comparison,
      locationData: comparison.location_comparison,
      investmentScore: comparison.rankings,
    }
  };

  return <PixelPerfectPDFGenerator report={transformedReport} skipDatabaseUpdate />;
}
