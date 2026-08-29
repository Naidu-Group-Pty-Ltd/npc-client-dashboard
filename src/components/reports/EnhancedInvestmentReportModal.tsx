import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FlattenPdfIconButton } from '@/components/common/FlattenPdfIconButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Loader2, Download, Copy, Check, Eye, TrendingUp, DollarSign, Home, Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { useToast } from '@/hooks/use-toast';
import { useNotifications } from '@/contexts/NotificationsContext';
import jsPDF from 'jspdf';
import { ReportGenerationStatus } from '@/components/billing/ReportGenerationStatus';
import { TokenCostEstimate } from '@/components/billing/TokenCostEstimate';
import { estimateTokens } from '@/lib/missionControl';

interface EnhancedInvestmentReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyAddress: string;
  propertyDetails?: {
    price?: number;
    weeklyRent?: number;
    propertyType?: string;
    beds?: number;
    baths?: number;
  };
}

export function EnhancedInvestmentReportModal({ 
  isOpen, 
  onClose, 
  propertyAddress, 
  propertyDetails 
}: EnhancedInvestmentReportModalProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [reportContent, setReportContent] = useState<string>('');
  const [enhancedData, setEnhancedData] = useState<any>(null);
  const [reportId, setReportId] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const [hasStartedGeneration, setHasStartedGeneration] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isGeneratingInBackground, setIsGeneratingInBackground] = useState(false);
  const { toast } = useToast();
  const { addNotification } = useNotifications();
  const navigate = useNavigate();

  const generateReport = async (runInBackground = false) => {
    setIsGenerating(true);
    setHasStartedGeneration(true);
    setProgress(0);
    
    if (runInBackground) {
      setIsGeneratingInBackground(true);
    }
    
    try {
      // Step 1: Generate main report (edge function already fetches all enhanced data)
      setProgress(25);
      
      console.log('Calling generate-investment-report with:', { propertyAddress, propertyDetails });
      
      const { data, error } = await invokeSecureFunction('generate-investment-report', {
        propertyAddress,
        propertyDetails
      });

      console.log('Edge function response:', { data, error });

      if (error) {
        console.error('Edge function error:', error);
        throw new Error(error.message || 'Failed to generate investment report');
      }

      if (!data) {
        console.error('No data returned from edge function');
        throw new Error('No data returned from edge function');
      }

      // Check if the response indicates an error
      if (data.success === false) {
        console.error('Report generation failed:', data.error);
        throw new Error(data.error || 'Report generation failed');
      }

      // Check if we have the required report content
      if (!data.reportContent) {
        console.error('No report content in response');
        throw new Error('No report content received');
      }

      setProgress(50);
      
      // Use the enhanced data returned from the edge function
      if (data.enhancedData) {
        setEnhancedData({
          demographics: data.enhancedData.demographics,
          economics: data.enhancedData.economics,
          financials: data.enhancedData.financials,
          location: data.enhancedData.locationIntelligence,
          investmentScore: data.enhancedData.investmentScore
        });
      }

      setProgress(90);
      
      // Save the report to the database
      let finalReportId = '';
      try {
        const { data: { user } } = await supabase.auth.getUser();
        
        if (!user) {
          throw new Error('User not authenticated');
        }

        // Check if a report with this exact address and content already exists recently
        const { data: existingReport } = await supabase
          .from('investment_reports')
          .select('id')
          .eq('property_address', propertyAddress)
          .eq('generated_by', user.id)
          .gte('created_at', new Date(Date.now() - 60000).toISOString()) // Within last 60 seconds
          .maybeSingle();

        if (existingReport) {
          console.log('Report already exists, skipping duplicate save');
          setReportId(existingReport.id);
          finalReportId = existingReport.id;
        } else {
          // Use secure edge function for insert (service_role required due to RLS)
          const { data: insertResult, error: insertError } = await invokeSecureFunction('manage-investment-reports', {
            action: 'insert',
            data: {
              property_address: propertyAddress,
              report_content: data.reportContent,
              sources_content: data.sourcesContent || null,
              location_intelligence: data.enhancedData?.locationIntelligence || null,
              investment_score: data.enhancedData?.investmentScore || null,
              financial_calculations: data.enhancedData?.financials || null,
              demographics_data: data.enhancedData?.demographics || null,
              economic_data: data.enhancedData?.economics || null,
              generated_by: user.id
            }
          });

          if (insertError || !insertResult?.success) {
            console.error('Failed to save report to database:', insertError || insertResult?.error);
            throw new Error(`Database error: ${insertError?.message || insertResult?.error || 'Unknown error'}`);
          }

          if (insertResult.report) {
            setReportId(insertResult.report.id);
            finalReportId = insertResult.report.id;
            console.log('Report saved successfully with ID:', insertResult.report.id);
          }
        }
      } catch (error) {
        console.error('Could not save report:', error);
        // Don't fail the entire generation if save fails, just log it
        console.warn('Report generated but not saved to database');
      }

      setProgress(100);
      setReportContent(data.reportContent);
      
      if (runInBackground) {
        // Notification is now handled server-side by the Edge Function to prevent duplicates
        // The BackgroundJobTracker will also detect completion, so we skip adding notification here
        console.log('📬 Skipping frontend notification - server-side notification will be created');
      } else {
        toast({
          title: "Enhanced Investment Report Generated",
          description: "Your comprehensive property analysis with location intelligence is ready.",
        });
      }
    } catch (error) {
      console.error('Report generation failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('Error details:', errorMessage);
      
      if (runInBackground) {
        addNotification({
          type: 'report_failed',
          title: 'Report Generation Failed',
          message: `Failed to generate report for ${propertyAddress}: ${errorMessage}`
        });
      } else {
        toast({
          title: "Generation Failed",
          description: errorMessage,
          variant: "destructive",
        });
      }
      setHasStartedGeneration(false);
    } finally {
      setIsGenerating(false);
      setProgress(0);
      setIsGeneratingInBackground(false);
    }
  };

  // Continue generation in background if modal is closed while generating
  useEffect(() => {
    if (!isOpen && isGenerating && !isGeneratingInBackground) {
      setIsGeneratingInBackground(true);
    }
  }, [isOpen, isGenerating, isGeneratingInBackground]);

  const fetchEnhancedData = async () => {
    try {
      const postcodeMatch = propertyAddress.match(/\b(\d{4})\b/);
      const stateMatch = propertyAddress.match(/\b(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b/i);
      const postcode = postcodeMatch ? postcodeMatch[1] : null;
      const state = stateMatch ? stateMatch[1].toUpperCase() : 'NSW';

      const [absResponse, rbaResponse, financialResponse, locationResponse, scoringResponse] = await Promise.all([
        invokeSecureFunction('abs-data-service', {
          postcode, state
        }),
        invokeSecureFunction('rba-data-service', {}),
        propertyDetails?.price ? invokeSecureFunction('financial-calculator-service', {
          propertyValue: propertyDetails.price,
          deposit: propertyDetails.price * 0.2,
          interestRate: 6.5,
          loanTerm: 30,
          weeklyRent: propertyDetails.weeklyRent || 500,
          state: state,
          propertyType: propertyDetails.propertyType || 'house'
        }) : Promise.resolve({ data: null, error: null }),
        invokeSecureFunction('location-intelligence-service', {
          address: propertyAddress,
          suburb: propertyAddress.split(',')[1]?.trim(),
          postcode,
          state
        }),
        propertyDetails?.price && propertyDetails?.weeklyRent ? invokeSecureFunction('investment-scoring-service', {
          propertyPrice: propertyDetails.price,
          weeklyRent: propertyDetails.weeklyRent,
          state: state,
          propertyType: propertyDetails.propertyType || 'house'
        }) : Promise.resolve({ data: null, error: null })
      ]);

      return {
        demographics: absResponse.data?.data,
        economics: rbaResponse.data?.data,
        financials: financialResponse.data?.data,
        location: locationResponse.data?.data,
        investmentScore: scoringResponse.data?.data
      };
    } catch (error) {
      console.error('Failed to fetch enhanced data:', error);
      return null;
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(reportContent);
      setIsCopied(true);
      toast({
        title: "Copied to Clipboard",
        description: "Investment report copied successfully.",
      });
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Failed to copy report to clipboard.",
        variant: "destructive",
      });
    }
  };

  const buildPdfDoc = () => {
    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 20;
    const maxWidth = pageWidth - (margin * 2);

    pdf.setFontSize(16);
    pdf.setFont(undefined, 'bold');
    pdf.text('Enhanced Property Investment Analysis', margin, 30);

    pdf.setFontSize(12);
    pdf.setFont(undefined, 'normal');
    pdf.text(`Property: ${propertyAddress}`, margin, 45);
    pdf.text(`Generated: ${new Date().toLocaleDateString('en-AU')}`, margin, 55);

    if (enhancedData?.financials) {
      pdf.setFontSize(10);
      pdf.setFont(undefined, 'bold');
      pdf.text('Key Financial Metrics:', margin, 70);
      pdf.setFont(undefined, 'normal');

      const metrics = [
        `Gross Yield: ${enhancedData.financials.keyMetrics?.grossRentalYield}%`,
        `Net Yield: ${enhancedData.financials.keyMetrics?.netRentalYield}%`,
        `Weekly Cash Flow: $${enhancedData.financials.keyMetrics?.weeklyNet}`,
        `LVR: ${enhancedData.financials.keyMetrics?.lvr}%`,
      ];

      metrics.forEach((metric, index) => {
        pdf.text(metric, margin, 80 + (index * 6));
      });
    }

    pdf.setFontSize(10);
    const lines = pdf.splitTextToSize(reportContent, maxWidth);

    let yPosition = enhancedData?.financials ? 110 : 70;
    const lineHeight = 6;

    lines.forEach((line: string) => {
      if (yPosition > pdf.internal.pageSize.getHeight() - 20) {
        pdf.addPage();
        yPosition = 20;
      }
      pdf.text(line, margin, yPosition);
      yPosition += lineHeight;
    });

    return pdf;
  };

  const pdfFilename = `enhanced-investment-report-${propertyAddress.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;

  const downloadPDF = () => {
    try {
      const pdf = buildPdfDoc();
      pdf.save(pdfFilename);

      toast({
        title: "Enhanced PDF Downloaded",
        description: "Investment report with financial data downloaded successfully.",
      });
    } catch (error) {
      toast({
        title: "Download Failed",
        description: "Failed to generate PDF. Please try again.",
        variant: "destructive",
      });
    }
  };

  const viewInGeneratedReports = () => {
    handleClose();
    navigate('/generated-reports');
    
    setTimeout(() => {
      if (reportId) {
        localStorage.setItem('openReportId', reportId);
        window.dispatchEvent(new CustomEvent('openReport', { detail: { reportId } }));
      }
    }, 100);
  };

  const handleClose = () => {
    if (isGenerating) return;
    
    setReportContent('');
    setEnhancedData(null);
    setReportId('');
    setIsGenerating(false);
    setHasStartedGeneration(false);
    setIsCopied(false);
    setProgress(0);
    onClose();
  };

  const renderFinancialMetrics = () => {
    if (!enhancedData?.financials) return null;
    
    const { keyMetrics, projections } = enhancedData.financials;
    
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <TrendingUp className="h-4 w-4 text-success" />
                <div>
                  <p className="text-2xl font-bold">{keyMetrics.grossRentalYield}%</p>
                  <p className="text-xs text-muted-foreground">Gross Yield</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <DollarSign className="h-4 w-4 text-info" />
                <div>
                  <p className="text-2xl font-bold">${keyMetrics.weeklyNet}</p>
                  <p className="text-xs text-muted-foreground">Weekly Net</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <Home className="h-4 w-4 text-accent" />
                <div>
                  <p className="text-2xl font-bold">{keyMetrics.lvr}%</p>
                  <p className="text-xs text-muted-foreground">LVR</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <Activity className="h-4 w-4 text-warning" />
                <div>
                  <p className="text-2xl font-bold">{keyMetrics.cashOnCashReturn}%</p>
                  <p className="text-xs text-muted-foreground">Cash on Cash</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {projections && (
          <Card>
            <CardHeader>
              <CardTitle>10-Year Projections</CardTitle>
              <CardDescription>Conservative, Moderate, and Optimistic scenarios</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="moderate" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="conservative">Conservative</TabsTrigger>
                  <TabsTrigger value="moderate">Moderate</TabsTrigger>
                  <TabsTrigger value="optimistic">Optimistic</TabsTrigger>
                </TabsList>
                
                {Object.entries(projections).map(([scenario, data]: [string, any]) => (
                  <TabsContent key={scenario} value={scenario} className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="text-center">
                        <p className="text-2xl font-bold text-success">
                          ${Math.round(data[data.length - 1].propertyValue / 1000)}k
                        </p>
                        <p className="text-sm text-muted-foreground">Property Value (Yr 10)</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-info">
                          ${Math.round(data[data.length - 1].equity / 1000)}k
                        </p>
                        <p className="text-sm text-muted-foreground">Equity (Yr 10)</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-accent">
                          ${Math.round(data[data.length - 1].cumulativeCashFlow / 1000)}k
                        </p>
                        <p className="text-sm text-muted-foreground">Total Cash Flow</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-warning">
                          {data[data.length - 1].roi}%
                        </p>
                        <p className="text-sm text-muted-foreground">Average ROI</p>
                      </div>
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        )}
      </div>
    );
  };

  const renderDemographicData = () => {
    if (!enhancedData?.demographics) return null;
    
    const { population, income, housing, employment } = enhancedData.demographics;
    
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {population && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Population Data</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span>Total Population:</span>
                  <Badge variant="secondary">{population.total?.toLocaleString('en-AU')}</Badge>
                </div>
                {population.growth && (
                  <div className="flex justify-between">
                    <span>Growth Rate:</span>
                    <Badge variant="secondary">{population.growth}% p.a.</Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {income && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Income & Demographics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span>Median Income:</span>
                  <Badge variant="secondary">${income.medianHouseholdIncome?.toLocaleString('en-AU')}</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Median Age:</span>
                  <Badge variant="secondary">{income.medianAge} years</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Unemployment:</span>
                  <Badge variant="secondary">{income.unemploymentRate}%</Badge>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {housing && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Housing Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span>Owner-Occupier:</span>
                  <Badge variant="secondary">{housing.ownerOccupierRate}%</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Renters:</span>
                  <Badge variant="secondary">{housing.renterRate}%</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Median Rent:</span>
                  <Badge variant="secondary">${housing.medianRent}/week</Badge>
                </div>
              </CardContent>
            </Card>
          )}

          {employment && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Employment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span>Participation Rate:</span>
                  <Badge variant="secondary">{employment.laborForceParticipation}%</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Professional Jobs:</span>
                  <Badge variant="secondary">{employment.professionalOccupations}%</Badge>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium">Top Industries:</span>
                  <div className="flex flex-wrap gap-1">
                    {employment.topIndustries?.map((industry: string, index: number) => (
                      <Badge key={index} variant="outline" className="text-xs">
                        {industry}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    );
  };

  const renderInvestmentScore = () => {
    if (!enhancedData?.investmentScore) {
      return (
        <div className="text-center py-8">
          <p className="text-muted-foreground">Investment score not available</p>
        </div>
      );
    }
    
    const { totalScore, grade, recommendation, breakdown, coverage, strengths, weaknesses, opportunities, risks } = enhancedData.investmentScore;
    const insufficient = coverage?.dataInsufficient || totalScore == null;

    return (
      <div className="space-y-6">
        <Card className="border-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Overall Investment Score</span>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="text-2xl font-bold px-4 py-2">
                  {grade}
                </Badge>
                {insufficient ? (
                  <span className="text-sm font-semibold text-muted-foreground">Insufficient data</span>
                ) : (
                  <span className="text-3xl font-bold">{totalScore}/100</span>
                )}
              </div>
            </CardTitle>
            <CardDescription className="text-lg font-medium pt-2">
              {recommendation}
            </CardDescription>
            {coverage && (
              <CardDescription className="text-xs text-muted-foreground pt-1">
                {coverage.partialLabel}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(breakdown).map(([key, value]: [string, any]) => (
                <div key={key} className={`space-y-1 ${value.excluded ? 'opacity-50' : ''}`}>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium capitalize">{key.replace('Score', '')}</span>
                    <span>
                      {value.excluded
                        ? <em className="text-muted-foreground">Excluded — no data</em>
                        : `${value.score}/100 (Weight: ${value.weight}%)`}
                    </span>
                  </div>
                  <Progress value={value.excluded ? 0 : value.score} className="h-2" />
                  <p className="text-xs text-muted-foreground">{value.details}</p>
                </div>

              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-success">Strengths</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {strengths.map((strength, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-success mt-0.5">✓</span>
                    <span className="text-sm">{strength}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-warning">Weaknesses</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {weaknesses.map((weakness, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-warning mt-0.5">!</span>
                    <span className="text-sm">{weakness}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-info">Opportunities</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {opportunities.map((opportunity, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-info mt-0.5">→</span>
                    <span className="text-sm">{opportunity}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg text-destructive">Risks</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {risks.map((risk, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="text-destructive mt-0.5">⚠</span>
                    <span className="text-sm">{risk}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  };

  const renderLocationIntelligence = () => {
    if (!enhancedData?.location) {
      return (
        <div className="text-center py-8">
          <p className="text-muted-foreground">Location data not available</p>
        </div>
      );
    }
    
    const { walkScore, commute, transport, schools, healthcare, lifestyle, amenities } = enhancedData.location;
    
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          <Card className="border-2 border-primary">
            <CardContent className="pt-6 text-center">
              <div className="text-4xl font-bold text-primary mb-2">{walkScore}</div>
              <div className="text-sm font-medium">Walk Score</div>
              <div className="text-xs text-muted-foreground mt-1">
                {walkScore >= 90 ? 'Walker\'s Paradise' : 
                 walkScore >= 70 ? 'Very Walkable' :
                 walkScore >= 50 ? 'Somewhat Walkable' : 'Car-Dependent'}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 text-center">
              <div className="text-4xl font-bold text-info mb-2">{commute.durationMinutes}m</div>
              <div className="text-sm font-medium">CBD Commute</div>
              <div className="text-xs text-muted-foreground mt-1">
                {commute.distanceKm}km via {commute.mode}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 text-center">
              <div className="text-4xl font-bold text-success mb-2">{transport.stationsWithin2km}</div>
              <div className="text-sm font-medium">Transit Stations</div>
              <div className="text-xs text-muted-foreground mt-1">
                Within 2km radius
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Amenity Scores</CardTitle>
            <CardDescription>Accessibility and quality of local amenities</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {amenities.map((amenity: any, index: number) => (
              <div key={index} className="space-y-2">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">{amenity.category}</div>
                    <div className="text-sm text-muted-foreground">
                      {amenity.count} nearby • Nearest: {amenity.nearest} ({amenity.distance.toFixed(1)}km)
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    {amenity.score}
                  </Badge>
                </div>
                <Progress value={amenity.score} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Public Transport</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span>Nearest Station:</span>
                <Badge variant="secondary">{transport.nearestStation}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Distance:</span>
                <Badge variant="outline">{transport.distanceToStation.toFixed(1)}km</Badge>
              </div>
              <div className="flex justify-between">
                <span>Stations within 2km:</span>
                <Badge variant="outline">{transport.stationsWithin2km}</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Schools & Education</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span>Nearest School:</span>
                <Badge variant="secondary">{schools.nearestSchool}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Distance:</span>
                <Badge variant="outline">{schools.distanceToSchool.toFixed(1)}km</Badge>
              </div>
              <div className="flex justify-between">
                <span>Schools within 3km:</span>
                <Badge variant="outline">{schools.schoolsWithin3km}</Badge>
              </div>
              {schools.topSchools && schools.topSchools.length > 0 && (
                <div className="mt-3">
                  <div className="text-sm font-medium mb-2">Top Schools Nearby:</div>
                  <div className="space-y-1">
                    {schools.topSchools.map((school: any, index: number) => (
                      <div key={index} className="text-xs flex justify-between items-center">
                        <span>{school.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{school.distance.toFixed(1)}km</span>
                          <Badge variant="outline" className="text-xs">★ {school.rating}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Healthcare</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span>Nearest Hospital:</span>
                <Badge variant="secondary">{healthcare.nearestHospital}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Distance:</span>
                <Badge variant="outline">{healthcare.distanceToHospital.toFixed(1)}km</Badge>
              </div>
              <div className="flex justify-between">
                <span>Facilities within 5km:</span>
                <Badge variant="outline">{healthcare.facilitiesWithin5km}</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lifestyle & Recreation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span>Shopping Centers:</span>
                <Badge variant="secondary">{lifestyle.shoppingCenters}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Parks & Recreation:</span>
                <Badge variant="secondary">{lifestyle.parks}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Restaurants & Cafes:</span>
                <Badge variant="secondary">{lifestyle.restaurants}</Badge>
              </div>
              <div className="mt-3 text-sm">
                <div className="text-muted-foreground">Nearest Shopping: {lifestyle.nearestShopping}</div>
                <div className="text-muted-foreground">Nearest Park: {lifestyle.nearestPark}</div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] flex flex-col" onPointerDownOutside={(e) => {
        if (isGenerating) e.preventDefault();
      }}>
        <DialogHeader>
          <DialogTitle>Enhanced Property Investment Analysis</DialogTitle>
          <DialogDescription>
            Comprehensive investment report with financial projections for {propertyAddress}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex flex-col min-h-0">
          {!hasStartedGeneration && !reportContent && (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="w-full max-w-md text-center space-y-4">
                <h3 className="text-lg font-medium">Generate Enhanced Investment Report</h3>
                <p className="text-muted-foreground">
                  Generate a comprehensive analysis including ABS demographic data, RBA economic indicators, 
                  and detailed financial projections with 10-year scenarios.
                </p>
                <ReportGenerationStatus
                  estimate={estimateTokens('report.investment.executive', { aiNarrative: true, extraSections: 1 })}
                  className="text-left"
                />
                <div className="flex items-center justify-center">
                  <TokenCostEstimate
                    kind="report.investment.executive"
                    options={{ aiNarrative: true, extraSections: 1 }}
                  />
                </div>
                <Button onClick={() => generateReport(false)} size="lg" disabled={isGenerating}>
                  Generate Enhanced Analysis
                </Button>
              </div>
            </div>
          )}

          {(hasStartedGeneration && !reportContent) && (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="text-center space-y-4 w-full max-w-md">
                {isGenerating ? (
                  <>
                    <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                    <h3 className="text-lg font-medium">Generating Enhanced Report</h3>
                    <p className="text-muted-foreground">
                      Fetching ABS demographic data, RBA economic indicators, and calculating financial projections...
                    </p>
                    <div className="space-y-2">
                      <Progress value={progress} className="w-full" />
                      <p className="text-xs text-muted-foreground">{progress}% complete</p>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-medium text-destructive">Generation Failed</h3>
                    <p className="text-muted-foreground">
                      There was an error generating your enhanced report. Please try again.
                    </p>
                    <Button onClick={() => generateReport(false)} variant="outline" size="lg">
                      Try Again
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {reportContent && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex justify-between items-center mb-4">
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={copyToClipboard} disabled={isCopied}>
                    {isCopied ? <><Check className="h-4 w-4 mr-2" />Copied</> : <><Copy className="h-4 w-4 mr-2" />Copy</>}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadPDF}>
                    <Download className="h-4 w-4 mr-2" />Download PDF
                  </Button>
                  <FlattenPdfIconButton
                    getPdfBlob={async () => buildPdfDoc().output('blob')}
                    filename={pdfFilename}
                  />
                  {reportId && (
                    <Button variant="outline" size="sm" onClick={viewInGeneratedReports}>
                      <Eye className="h-4 w-4 mr-2" />View Report
                    </Button>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={handleClose}>
                  Close Report
                </Button>
              </div>

              <Tabs defaultValue="report" className="flex-1 flex flex-col min-h-0">
                <TabsList className="grid w-full grid-cols-6">
                  <TabsTrigger value="report">Full Report</TabsTrigger>
                  <TabsTrigger value="score">Investment Score</TabsTrigger>
                  <TabsTrigger value="financials">Financial Analysis</TabsTrigger>
                  <TabsTrigger value="location">Location Intel</TabsTrigger>
                  <TabsTrigger value="demographics">Demographics</TabsTrigger>
                  <TabsTrigger value="economics">Economic Data</TabsTrigger>
                </TabsList>
                
                <TabsContent value="report" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {reportContent}
                      </ReactMarkdown>
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="score" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    {renderInvestmentScore()}
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="financials" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    {renderFinancialMetrics()}
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="location" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    {renderLocationIntelligence()}
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="demographics" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    {renderDemographicData()}
                  </ScrollArea>
                </TabsContent>
                
                <TabsContent value="economics" className="flex-1 flex flex-col min-h-0">
                  <ScrollArea className="flex-1 border rounded-lg p-6">
                    {enhancedData?.economics ? (
                      <div className="space-y-4">
                        <Card>
                          <CardHeader>
                            <CardTitle>RBA Cash Rate & Interest Rates</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <div className="flex justify-between">
                              <span>Current Cash Rate:</span>
                              <Badge variant="secondary">{enhancedData.economics.cashRate?.current}%</Badge>
                            </div>
                            <div className="flex justify-between">
                              <span>Previous Rate:</span>
                              <Badge variant="outline">{enhancedData.economics.cashRate?.previous}%</Badge>
                            </div>
                            <div className="flex justify-between">
                              <span>Change:</span>
                              <Badge variant={enhancedData.economics.cashRate?.change > 0 ? "destructive" : "default"}>
                                {enhancedData.economics.cashRate?.change > 0 ? '+' : ''}{enhancedData.economics.cashRate?.change}%
                              </Badge>
                            </div>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader>
                            <CardTitle>Inflation & Economic Indicators</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <div className="flex justify-between">
                              <span>Annual Inflation:</span>
                              <Badge variant="secondary">{enhancedData.economics.inflation?.annual}%</Badge>
                            </div>
                            <div className="flex justify-between">
                              <span>GDP Growth:</span>
                              <Badge variant="secondary">{enhancedData.economics.indicators?.gdpGrowth}%</Badge>
                            </div>
                            <div className="flex justify-between">
                              <span>National Unemployment:</span>
                              <Badge variant="secondary">{enhancedData.economics.indicators?.unemploymentRate}%</Badge>
                            </div>
                            <div className="flex justify-between">
                              <span>House Price Growth:</span>
                              <Badge variant="secondary">{enhancedData.economics.indicators?.housePriceGrowth}%</Badge>
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-muted-foreground">Economic data not available</p>
                      </div>
                    )}
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}