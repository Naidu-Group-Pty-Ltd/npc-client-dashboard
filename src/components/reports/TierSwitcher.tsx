import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Loader2, ChevronDown, Compass, FileText, Zap, Check, Calculator } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { useToast } from '@/hooks/use-toast';
import { TIER_INFO, type ReportTier } from './TierBadge';

interface TierSwitcherProps {
  reportId: string;
  currentTier: ReportTier;
  parentReportId?: string | null;
  onTierSwitch?: (newReportId: string, newTier: ReportTier) => void;
  disabled?: boolean;
}

interface SiblingReport {
  id: string;
  report_tier: ReportTier;
}

export function TierSwitcher({ 
  reportId, 
  currentTier, 
  parentReportId,
  onTierSwitch,
  disabled = false 
}: TierSwitcherProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingTier, setLoadingTier] = useState<ReportTier | null>(null);
  const [siblingReports, setSiblingReports] = useState<SiblingReport[]>([]);
  const { toast } = useToast();

  // Determine the compass report ID (parent for derived, self for compass)
  const compassReportId = currentTier === 'compass' ? reportId : parentReportId;

  const fetchSiblingReports = async () => {
    if (!compassReportId) return;

    try {
      // Fetch all reports that share the same parent (or are the parent)
      const { data, error } = await supabase
        .from('investment_reports')
        .select('id, report_tier')
        .or(`id.eq.${compassReportId},parent_report_id.eq.${compassReportId}`)
        .eq('status', 'completed');

      if (error) {
        console.error('Error fetching sibling reports:', error);
        return;
      }

      setSiblingReports((data || []) as SiblingReport[]);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleTierSelect = async (targetTier: ReportTier) => {
    if (targetTier === currentTier) return;
    
    // Check if this tier already exists
    const existingReport = siblingReports.find(r => r.report_tier === targetTier);
    
    if (existingReport) {
      // Switch to existing report
      onTierSwitch?.(existingReport.id, targetTier);
      toast({
        title: 'Report Switched',
        description: `Viewing ${TIER_INFO[targetTier].name}`,
      });
      return;
    }

    // Need to generate the tier
    if (targetTier === 'compass') {
      // Can't generate compass from derived - just switch to parent
      if (compassReportId) {
        onTierSwitch?.(compassReportId, 'compass');
      }
      return;
    }

    // Generate new condensed report
    if (!compassReportId) {
      toast({
        title: 'Cannot Generate',
        description: 'No parent Compass report found',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    setLoadingTier(targetTier);

    try {
      const { data, error } = await invokeSecureFunction('condense-investment-report', {
        parentReportId: compassReportId,
        targetTier,
      });

      if (error) throw error;

      if (data?.success && data?.reportId) {
        toast({
          title: 'Report Generated',
          description: `${TIER_INFO[targetTier].name} is ready`,
        });
        
        onTierSwitch?.(data.reportId, targetTier);
        
        // Refresh siblings
        fetchSiblingReports();
      } else {
        throw new Error(data?.error || 'Failed to generate report');
      }
    } catch (error) {
      console.error('Error generating tier:', error);
      toast({
        title: 'Generation Failed',
        description: error instanceof Error ? error.message : 'Failed to generate report tier',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
      setLoadingTier(null);
    }
  };

  const getTierIcon = (tier: ReportTier) => {
    switch (tier) {
      case 'compass': return Compass;
      case 'briefing': return FileText;
      case 'snapshot': return Zap;
      case 'financial': return Calculator;
      default: return Compass;
    }
  };

  const CurrentIcon = getTierIcon(currentTier);

  return (
    <DropdownMenu onOpenChange={(open) => open && fetchSiblingReports()}>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          disabled={disabled || isLoading}
          className="gap-2"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CurrentIcon className="h-4 w-4" />
          )}
          {TIER_INFO[currentTier].shortName}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Report Versions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        {(['compass', 'financial', 'briefing', 'snapshot'] as ReportTier[]).map((tier) => {
          const info = TIER_INFO[tier];
          const Icon = getTierIcon(tier);
          const isCurrentTier = tier === currentTier;
          const existingReport = siblingReports.find(r => r.report_tier === tier);
          const isGenerating = loadingTier === tier;

          return (
            <DropdownMenuItem
              key={tier}
              onClick={() => handleTierSelect(tier)}
              disabled={isGenerating}
              className="flex items-start gap-3 py-3 cursor-pointer"
            >
              <div className={`p-1.5 rounded ${info.color}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{info.name}</span>
                  {isCurrentTier && <Check className="h-3 w-3 text-success" />}
                </div>
                <p className="text-xs text-muted-foreground">
                  {info.description}
                </p>
                <p className="text-xs text-muted-foreground">
                  {existingReport ? '✓ Available' : isGenerating ? 'Generating...' : 'Click to generate'}
                </p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
