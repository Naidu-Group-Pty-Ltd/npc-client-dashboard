import { useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, TrendingUp, MapPin, AlertTriangle, Target, FileWarning } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { readStoredAnalysis, section } from '@/lib/reports/propertyComparison/storedAnalysis.pure';
import { ComparisonPDFGenerator } from './ComparisonPDFGenerator';
import { ComparisonDownloadButton } from './ComparisonDownloadButton';
import { logActivityDirect } from '@/hooks/useActivityLogger';

interface ComparisonViewerProps {
  isOpen: boolean;
  onClose: () => void;
  comparison: {
    id: string;
    property_count: number;
    property_addresses?: string[];
    property_states?: string[];
    report_title?: string;
    executive_summary: string | null;
    rankings: any;
    investor_matches?: any;
    financial_comparison: any;
    location_comparison: any;
    risk_comparison: any;
    recommendations: any;
    red_flags: any;
    report_ids: string[];
    created_at: string;
  } | null;
}

export function ComparisonViewer({ isOpen, onClose, comparison }: ComparisonViewerProps) {
  // Log comparison viewed when opened
  useEffect(() => {
    if (isOpen && comparison) {
      logActivityDirect({
        actionType: 'comparison_viewed',
        entityType: 'property_comparison',
        entityId: comparison.id,
        entityName: comparison.report_title || `${comparison.property_count} Property Comparison`,
        metadata: { 
          property_count: comparison.property_count,
          property_addresses: comparison.property_addresses 
        }
      });
    }
  }, [isOpen, comparison]);

  if (!comparison) return null;

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Trophy className="h-5 w-5 text-brand-500" />;
    if (rank === 2) return <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-xs">2</div>;
    if (rank === 3) return <div className="h-5 w-5 rounded-full bg-brand-600 flex items-center justify-center text-xs">3</div>;
    return <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center text-xs">{rank}</div>;
  };

  const getRiskColor = (level: string) => {
    switch (level?.toLowerCase()) {
      case 'low': return 'text-success';
      case 'medium': return 'text-brand-600';
      case 'high': return 'text-destructive';
      default: return 'text-muted-foreground';
    }
  };

  // Format text content for display (converts to readable paragraphs)
  const formatText = (text: string): string[] => {
    if (!text) return [];
    return text
      .split('\n\n')
      .map(para => para.trim())
      .filter(para => para.length > 0);
  };

  // ── What this row actually holds ──────────────────────────────────────────
  //
  // 30 of the 53 stored comparisons have all seven structured columns NULL and
  // the model's whole raw response sitting in `executive_summary`. This screen
  // used to try `JSON.parse` on that and **return the cleaned string on
  // failure**, so those rows rendered as 16 KB of raw JSON under the heading
  // "Executive Summary", with every tab reading "No … data available" — while
  // the typeset PDF beside them read the same rows correctly.
  //
  // `readStoredAnalysis` is the decision the render route makes, shared rather
  // than re-implemented, so the two can no longer disagree about what the model
  // said. It never repairs, so a section is shown whole or reported absent.
  const stored = readStoredAnalysis(comparison as unknown as Record<string, unknown>);
  const { provenance } = stored;

  const rankings = section(stored, 'rankings') as any;
  const financialComparison = section(stored, 'financialComparison') as any;
  const locationComparison = section(stored, 'locationComparison') as any;
  const riskComparison = section(stored, 'riskComparison') as any;
  const recommendations = section(stored, 'recommendations') as any;
  const redFlags = section(stored, 'redFlags') as any;

  const summary = section(stored, 'executiveSummary');
  const cleanExecutiveSummary = typeof summary === 'string' ? summary : null;

  // Only worth saying on the salvaged path. On the columns path a section the
  // analysis had nothing to say about is ordinary absence, and announcing it
  // would turn every complete comparison into a warning.
  const recordIncomplete = provenance.shape === 'salvaged' && provenance.missing.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5" />
                {comparison.report_title || `Property Comparison Analysis - ${comparison.property_count} Properties`}
              </div>
              {comparison.property_states && comparison.property_states.length > 0 && (
                <p className="text-sm font-normal text-muted-foreground mt-1">
                  States: {comparison.property_states.join(', ')}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/*
                Beside the AI-written report, never instead of it. The typeset
                path reads the saved row and costs nothing; the one to its right
                re-writes the document with a model on every press.
              */}
              <ComparisonDownloadButton comparisonId={comparison.id} />
              <ComparisonPDFGenerator comparison={comparison} />
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 pr-4">
          <div className="space-y-6 pb-4">
            {/*
              What the record does not hold, said first. On a cut-off analysis a
              reader who is not told simply reads a shorter report — and the one
              section truncation eats first is the one that answers "which should
              I buy".
            */}
            {stored.error ? (
              <Alert variant="destructive">
                <FileWarning className="h-4 w-4" />
                <AlertTitle>This comparison could not be read</AlertTitle>
                <AlertDescription>
                  The saved analysis holds no readable sections — {stored.error}. Re-run the
                  comparison to produce it again.
                </AlertDescription>
              </Alert>
            ) : recordIncomplete ? (
              <Alert>
                <FileWarning className="h-4 w-4" />
                <AlertTitle>Part of this analysis was not saved</AlertTitle>
                <AlertDescription>
                  The model's response was cut off before it finished, so{' '}
                  {provenance.missing.length} of {provenance.missing.length + provenance.recovered.length}{' '}
                  sections were never stored: {provenance.missing.join(', ')}. Everything shown below
                  was recovered from the saved response and is what the model wrote. Re-run the
                  comparison to produce the missing sections.
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Executive Summary */}
            {cleanExecutiveSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Executive Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3 text-sm leading-relaxed">
                    {formatText(cleanExecutiveSummary).map((paragraph, idx) => (
                      <p key={idx}>{paragraph}</p>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            <Tabs defaultValue="rankings" className="w-full">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="rankings">Rankings</TabsTrigger>
                <TabsTrigger value="financial">Financial</TabsTrigger>
                <TabsTrigger value="location">Location</TabsTrigger>
                <TabsTrigger value="risk">Risk</TabsTrigger>
              </TabsList>

              {/* Rankings Tab */}
              <TabsContent value="rankings" className="space-y-4">
                {rankings && Array.isArray(rankings) ? (
                  rankings.map((property: any) => (
                    <Card key={property.propertyNumber}>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {getRankIcon(property.rank)}
                            <div>
                              <CardTitle className="text-base">{property.address}</CardTitle>
                              <CardDescription>
                                Score: {typeof property.finalScore === 'number' ? property.finalScore.toFixed(1) : property.finalScore}/100
                              </CardDescription>
                            </div>
                          </div>
                          <Badge variant={property.rank === 1 ? "default" : "secondary"}>
                            Rank #{property.rank}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {property.primaryStrengths && (
                          <div>
                            <p className="text-sm font-medium mb-1">Strengths:</p>
                            <ul className="text-sm text-muted-foreground space-y-1">
                              {property.primaryStrengths.map((strength: string, idx: number) => (
                                <li key={idx}>✓ {strength}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {property.primaryConcerns && property.primaryConcerns.length > 0 && (
                          <div>
                            <p className="text-sm font-medium mb-1">Concerns:</p>
                            <ul className="text-sm text-muted-foreground space-y-1">
                              {property.primaryConcerns.map((concern: string, idx: number) => (
                                <li key={idx}>⚠ {concern}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {property.bestSuitedFor && (
                          <p className="text-sm">
                            <span className="font-medium">Best for:</span> {property.bestSuitedFor}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      No ranking data available
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* Financial Tab */}
              <TabsContent value="financial" className="space-y-4">
                {financialComparison ? (
                  <div className="grid gap-4">
                    {Object.entries(financialComparison).map(([key, value]: [string, any]) => (
                      <Card key={key}>
                        <CardHeader>
                          <CardTitle className="text-sm capitalize flex items-center gap-2">
                            <TrendingUp className="h-4 w-4" />
                            {key.replace(/([A-Z])/g, ' $1').trim()}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm mb-2">
                            <span className="font-medium">Property #{value.propertyNumber}</span>
                            {value.value && `: ${value.value}`}
                          </p>
                          <div className="text-sm text-muted-foreground space-y-1">
                            {formatText(value.reason || '').map((para, idx) => (
                              <p key={idx}>{para}</p>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      No financial comparison data available
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* Location Tab */}
              <TabsContent value="location" className="space-y-4">
                {locationComparison ? (
                  <div className="grid gap-4">
                    {Object.entries(locationComparison).map(([key, value]: [string, any]) => (
                      <Card key={key}>
                        <CardHeader>
                          <CardTitle className="text-sm capitalize flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {key.replace(/([A-Z])/g, ' $1').trim()}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm mb-2">
                            <span className="font-medium">Property #{value.propertyNumber}</span>
                          </p>
                          <div className="text-sm text-muted-foreground space-y-1">
                            {formatText(value.reason || '').map((para, idx) => (
                              <p key={idx}>{para}</p>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      No location comparison data available
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* Risk Tab */}
              <TabsContent value="risk" className="space-y-4">
                {riskComparison ? (
                  <>
                    <div className="grid gap-4">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-success" />
                            Lowest Risk
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm mb-2">
                            <span className="font-medium">Property #{riskComparison.lowestRisk?.propertyNumber}</span>
                          </p>
                          <div className="text-sm text-muted-foreground space-y-1">
                            {formatText(riskComparison.lowestRisk?.reason || '').map((para, idx) => (
                              <p key={idx}>{para}</p>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                            Highest Risk
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="text-sm mb-2">
                            <span className="font-medium">Property #{riskComparison.highestRisk?.propertyNumber}</span>
                          </p>
                          <div className="text-sm text-muted-foreground space-y-1">
                            {formatText(riskComparison.highestRisk?.reason || '').map((para, idx) => (
                              <p key={idx}>{para}</p>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {riskComparison.riskLevels && (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-sm">Risk Levels by Property</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {riskComparison.riskLevels.map((risk: any) => (
                            <div key={risk.propertyNumber} className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">Property #{risk.propertyNumber}</span>
                                <Badge className={getRiskColor(risk.riskLevel)}>
                                  {risk.riskLevel} Risk
                                </Badge>
                              </div>
                              {risk.specificRisks && risk.specificRisks.length > 0 && (
                                <ul className="text-sm text-muted-foreground space-y-1">
                                  {risk.specificRisks.map((r: string, idx: number) => (
                                    <li key={idx}>• {r}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    )}
                  </>
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      No risk comparison data available
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            </Tabs>

            {/* Final Recommendation */}
            {recommendations && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Target className="h-5 w-5" />
                    Final Recommendation
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {recommendations.bestOverall && (
                    <div>
                      <p className="font-medium text-sm mb-2">Best Overall Investment:</p>
                      <p className="text-sm mb-2">
                        Property #{recommendations.bestOverall.propertyNumber}
                      </p>
                      <div className="text-sm text-muted-foreground space-y-1">
                        {formatText(recommendations.bestOverall.reason || '').map((para, idx) => (
                          <p key={idx}>{para}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {recommendations.runners && recommendations.runners.length > 0 && (
                    <div>
                      <p className="font-medium text-sm mb-2">Alternative Options:</p>
                      {recommendations.runners.map((runner: any, idx: number) => (
                        <div key={idx} className="mt-3 pt-3 border-t first:mt-0 first:pt-0 first:border-0">
                          <p className="text-sm font-medium mb-1">Property #{runner.propertyNumber}</p>
                          <div className="text-sm text-muted-foreground space-y-1">
                            {formatText(runner.reason || '').map((para, pIdx) => (
                              <p key={pIdx}>{para}</p>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Red Flags */}
            {redFlags && redFlags.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                    Red Flags & Concerns
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {redFlags.map((flag: any) => (
                    <div key={flag.propertyNumber} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">Property #{flag.propertyNumber}</p>
                        <Badge variant="destructive">{flag.severity}</Badge>
                      </div>
                      <ul className="text-sm text-muted-foreground space-y-1">
                        {flag.concerns.map((concern: string, idx: number) => (
                          <li key={idx}>⚠ {concern}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
