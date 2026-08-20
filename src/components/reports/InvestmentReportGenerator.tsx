import { useState, useCallback, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/integrations/supabase/client';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import type { Json } from '@/integrations/supabase/types';
import { useToast } from '@/hooks/use-toast';
import { useNotifications } from '@/contexts/NotificationsContext';
import { useAuth } from '@/hooks/useAuth';
import { useActivityLogger } from '@/hooks/useActivityLogger';
import { addBackgroundJob } from '@/components/BackgroundJobTracker';
import { Loader2, MapPin, Hash, Globe, TrendingUp, FileText, Link, Upload, X, Image, AlertCircle } from 'lucide-react';
import { convertPdfToImages, isPdfFile, isImageFile, imageFileToBase64 } from '@/utils/pdfToImages';
import { PreGenerationOverrides, PreGenerationData } from './PreGenerationOverrides';
import { removeCommas } from '@/hooks/useFormattedNumber';
import { BuildTypeSelector } from './shared/BuildTypeSelector';
import { BuildType } from '@/types/overrideFields';
import { AddressAutocomplete } from '@/components/shared/AddressAutocomplete';
import { useSearchParams } from 'react-router-dom';
import { ReportGenerationStatus } from '@/components/billing/ReportGenerationStatus';
import { TokenCostEstimate } from '@/components/billing/TokenCostEstimate';
import { estimateTokens } from '@/lib/missionControl';


export function InvestmentReportGenerator() {
  // Input mode: 'manual', 'url', or 'pdf'
  const [inputMode, setInputMode] = useState<'manual' | 'url' | 'pdf' | 'overrides'>('manual');
  
  // URL scraping state
  const [propertyUrl, setPropertyUrl] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [urlScrapedData, setUrlScrapedData] = useState<{ propertyAddress: string; scrapedContent: string; sourceUrl: string } | null>(null);
  const [isUrlGenerating, setIsUrlGenerating] = useState(false);
  
  // PDF upload state
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [conversionProgress, setConversionProgress] = useState<{ current: number; total: number } | null>(null);
  const [pdfParsedData, setPdfParsedData] = useState<{ propertyAddress: string; pdfContent: string } | null>(null);
  const [isPdfGenerating, setIsPdfGenerating] = useState(false);
  
  const [queryType, setQueryType] = useState<'address' | 'zipcode' | 'suburb' | 'state'>('address');
  const [query, setQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [generatedReport, setGeneratedReport] = useState<string>('');
  
  // Property details state
  const [propertyPrice, setPropertyPrice] = useState('');
  const [weeklyRent, setWeeklyRent] = useState('');
  const [propertyType, setPropertyType] = useState<string>('house');
  const [beds, setBeds] = useState('');
  const [baths, setBaths] = useState('');
  const [carSpaces, setCarSpaces] = useState('');
  const [landSize, setLandSize] = useState('');
  const [buildSize, setBuildSize] = useState('');
  
  // New build specific fields
  const [landPrice, setLandPrice] = useState('');
  const [buildPrice, setBuildPrice] = useState('');
  
  // Suburb analysis year context state
  const [dataYearType, setDataYearType] = useState<'single' | 'range'>('single');
  const [singleYear, setSingleYear] = useState('');
  const [yearRangeStart, setYearRangeStart] = useState('');
  const [yearRangeEnd, setYearRangeEnd] = useState('');
  
  const { toast } = useToast();
  const { addNotification } = useNotifications();
  const { user } = useAuth();
  const { logActivity } = useActivityLogger();
  
  // Pre-generation overrides data
  const [preGenData, setPreGenData] = useState<PreGenerationData>({ buildType: 'existing_property' });

  // Generation engine selection (legacy vs compass-40 trimmed)
  const [generationEngine, setGenerationEngine] = useState<'legacy' | 'compass-40'>('legacy');

  // Whether current query type is property-specific (needs property details, overrides, etc.)
  const isPropertySpecific = queryType === 'address';

  // Auto-switch to manual entry when selecting non-address query types
  useEffect(() => {
    if (!isPropertySpecific && inputMode !== 'manual') {
      setInputMode('manual');
    }
  }, [isPropertySpecific, inputMode]);

  // Phase B: hydrate from URL params if launched from a ReportActionMenu
  const [searchParams, setSearchParams] = useSearchParams();
  const hydratedFromUrl = useRef(false);
  useEffect(() => {
    if (hydratedFromUrl.current) return;
    const urlScope = searchParams.get('scope');
    const urlQuery = searchParams.get('q');
    const urlTier = searchParams.get('tier'); // reserved — surfaced via toast for now
    if (urlScope && ['address', 'zipcode', 'suburb', 'state'].includes(urlScope)) {
      setQueryType(urlScope as 'address' | 'zipcode' | 'suburb' | 'state');
    }
    if (urlQuery) setQuery(urlQuery);
    if (urlScope || urlQuery || urlTier) {
      hydratedFromUrl.current = true;
      // Clean URL so refresh doesn't keep re-prefilling
      const next = new URLSearchParams(searchParams);
      ['scope', 'q', 'tier'].forEach((k) => next.delete(k));
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Track if sync is in progress to prevent loops
  const isSyncingFromPreGen = useRef(false);
  const isSyncingToPreGen = useRef(false);

  // Handle currency input change with comma formatting
  const handleCurrencyInputChange = useCallback((setter: (value: string) => void) => {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = removeCommas(e.target.value);
      if (rawValue === '' || rawValue === '-' || /^-?\d*\.?\d*$/.test(rawValue)) {
        setter(rawValue);
      }
    };
  }, []);

  // Sync propertyPrice with preGenData.purchasePrice (bidirectional)
  const handlePropertyPriceChange = useCallback((value: string) => {
    const rawValue = removeCommas(value);
    if (rawValue === '' || rawValue === '-' || /^-?\d*\.?\d*$/.test(rawValue)) {
      setPropertyPrice(rawValue);
      
      if (!isSyncingFromPreGen.current) {
        isSyncingToPreGen.current = true;
        const numValue = parseFloat(rawValue);
        if (!isNaN(numValue) && numValue > 0) {
          setPreGenData(prev => ({ ...prev, purchasePrice: numValue }));
        } else if (rawValue === '') {
          setPreGenData(prev => ({ ...prev, purchasePrice: undefined }));
        }
        requestAnimationFrame(() => { isSyncingToPreGen.current = false; });
      }
    }
  }, []);

  // Sync weeklyRent with preGenData.weeklyRent (bidirectional)
  const handleWeeklyRentChange = useCallback((value: string) => {
    const rawValue = removeCommas(value);
    if (rawValue === '' || rawValue === '-' || /^-?\d*\.?\d*$/.test(rawValue)) {
      setWeeklyRent(rawValue);
      
      if (!isSyncingFromPreGen.current) {
        isSyncingToPreGen.current = true;
        const numValue = parseFloat(rawValue);
        if (!isNaN(numValue) && numValue > 0) {
          setPreGenData(prev => ({ ...prev, weeklyRent: numValue }));
        } else if (rawValue === '') {
          setPreGenData(prev => ({ ...prev, weeklyRent: undefined }));
        }
        requestAnimationFrame(() => { isSyncingToPreGen.current = false; });
      }
    }
  }, []);

  // Handle carSpaces change and sync to preGenData
  const handleCarSpacesChange = useCallback((value: string) => {
    setCarSpaces(value);
    
    if (!isSyncingFromPreGen.current) {
      isSyncingToPreGen.current = true;
      const numValue = parseInt(value);
      if (!isNaN(numValue) && numValue >= 0) {
        setPreGenData(prev => ({ ...prev, carSpaces: numValue }));
      } else if (value === '') {
        setPreGenData(prev => ({ ...prev, carSpaces: undefined }));
      }
      requestAnimationFrame(() => { isSyncingToPreGen.current = false; });
    }
  }, []);

  // Handle landSize change and sync to preGenData (bidirectional)
  const handleLandSizeChange = useCallback((value: string) => {
    // Allow empty, digits, and decimal point
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setLandSize(value);
      
      if (!isSyncingFromPreGen.current) {
        isSyncingToPreGen.current = true;
        const numValue = parseFloat(value);
        if (!isNaN(numValue) && numValue > 0) {
          setPreGenData(prev => ({ ...prev, landSizeSqm: numValue }));
        } else if (value === '') {
          setPreGenData(prev => ({ ...prev, landSizeSqm: undefined }));
        }
        requestAnimationFrame(() => { isSyncingToPreGen.current = false; });
      }
    }
  }, []);

  // Handle buildSize change and sync to preGenData (bidirectional)
  const handleBuildSizeChange = useCallback((value: string) => {
    // Allow empty, digits, and decimal point
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setBuildSize(value);
      
      if (!isSyncingFromPreGen.current) {
        isSyncingToPreGen.current = true;
        const numValue = parseFloat(value);
        if (!isNaN(numValue) && numValue > 0) {
          setPreGenData(prev => ({ ...prev, buildSizeSqm: numValue }));
        } else if (value === '') {
          setPreGenData(prev => ({ ...prev, buildSizeSqm: undefined }));
        }
        requestAnimationFrame(() => { isSyncingToPreGen.current = false; });
      }
    }
  }, []);

  // Handle preGenData changes from PreGenerationOverrides - sync back to main form fields
  const handlePreGenDataChange = useCallback((data: PreGenerationData) => {
    setPreGenData(data);
    
    // Only sync back if not currently syncing TO PreGen (prevents loops)
    if (!isSyncingToPreGen.current) {
      isSyncingFromPreGen.current = true;
      
      // Sync purchasePrice back to propertyPrice if changed in PreGenerationOverrides
      if (data.purchasePrice !== undefined) {
        const dataValueStr = data.purchasePrice.toString();
        if (propertyPrice !== dataValueStr) {
          setPropertyPrice(dataValueStr);
        }
      }
      
      // Sync weeklyRent back to main form if changed in PreGenerationOverrides
      if (data.weeklyRent !== undefined) {
        const dataValueStr = data.weeklyRent.toString();
        if (weeklyRent !== dataValueStr) {
          setWeeklyRent(dataValueStr);
        }
      }
      
      // Sync carSpaces back to main form if changed in PreGenerationOverrides
      if (data.carSpaces !== undefined) {
        const dataValueStr = data.carSpaces.toString();
        if (carSpaces !== dataValueStr) {
          setCarSpaces(dataValueStr);
        }
      }
      
      // Sync landSizeSqm back to main form if changed in PreGenerationOverrides
      if (data.landSizeSqm !== undefined) {
        const dataValueStr = data.landSizeSqm.toString();
        if (landSize !== dataValueStr) {
          setLandSize(dataValueStr);
        }
      }
      
      // Sync buildSizeSqm back to main form if changed in PreGenerationOverrides
      if (data.buildSizeSqm !== undefined) {
        const dataValueStr = data.buildSizeSqm.toString();
        if (buildSize !== dataValueStr) {
          setBuildSize(dataValueStr);
        }
      }
      
      // Reset flag after React has processed the state updates
      requestAnimationFrame(() => { isSyncingFromPreGen.current = false; });
    }
  }, [propertyPrice, weeklyRent, carSpaces, landSize, buildSize]);

  const handleGenerate = async () => {
    if (!query.trim()) {
      toast({
        title: "Input Required",
        description: "Please enter a property address, postcode, or state.",
        variant: "destructive",
      });
      return;
    }

    // Purchase price only required for property-specific address reports
    if (queryType === 'address' && (!propertyPrice || parseFloat(propertyPrice) <= 0)) {
      toast({
        title: "Purchase Price Required",
        description: "Please enter a valid purchase price to calculate investment score.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please log in to generate reports.",
        variant: "destructive",
      });
      return;
    }

    setIsGenerating(true);
    setShowResults(false);

    try {
      // Format the query based on type
      let propertyAddress = '';
      switch (queryType) {
        case 'address':
          propertyAddress = query.trim();
          break;
        case 'zipcode':
          propertyAddress = `Properties in ${query.trim()}`;
          break;
        case 'suburb':
          propertyAddress = `${query.trim()}, Australia`;
          break;
        case 'state':
          propertyAddress = `${query.trim()}, Australia`;
          break;
      }

      // Build property details object with pre-generation overrides
      // CRITICAL: Convert string values to numbers for proper override cascade
      const sanitizedPreGenData = { ...preGenData };
      
      // Ensure numeric fields are actually numbers, not strings
      const numericFields = [
        'purchasePrice', 'weeklyRent', 'depositValue', 'loanToValueRatio', 
        'interestRate', 'capitalGrowth', 'stampDuty', 'bodyCorporateFees',
        'landTax', 'councilRates', 'waterRates', 'solicitorFees',
        'buildingLandlordInsurance', 'propertyManagementFees', 'repairsMaintenance',
        'lettingFees', 'strataAdminFund', 'strataSinkingFund', 'strataSpecialLevies',
        'landPrice', 'buildPrice', 'agentFee', 'cpiGrowthRate', 'depreciation',
        'taxRate', 'occupancyRate', 'loanTermYears', 'marketValueNow', 'loanAmount'
      ];
      
      numericFields.forEach(field => {
        const val = (sanitizedPreGenData as any)[field];
        if (val !== undefined && val !== null && val !== '') {
          const numVal = parseFloat(val.toString());
          if (!isNaN(numVal)) {
            (sanitizedPreGenData as any)[field] = numVal;
          }
        }
      });
      
      // Only include manual overrides for property-specific (address) reports
      // Area reports (suburb/postcode/statewide) don't use property-level overrides
      const isPropertyScope = queryType === 'address';
      
      const propertyDetails: any = { 
        queryType, 
        originalQuery: query,
        generationEngine,
        // Include pre-generation manual overrides ONLY for address-scope reports
        ...(isPropertyScope ? { manualOverrides: sanitizedPreGenData } : {}),
      };
      
      // Add optional property details if provided (form values take precedence over preGenData)
      if (propertyPrice) {
        propertyDetails.price = parseFloat(propertyPrice);
      } else if (preGenData.purchasePrice) {
        propertyDetails.price = preGenData.purchasePrice;
      }
      
      if (weeklyRent) {
        propertyDetails.weeklyRent = parseFloat(weeklyRent);
      } else if (preGenData.weeklyRent) {
        propertyDetails.weeklyRent = preGenData.weeklyRent;
      }
      
      if (propertyType) propertyDetails.propertyType = propertyType;
      if (beds) propertyDetails.beds = parseInt(beds);
      if (baths) propertyDetails.baths = parseInt(baths);
      if (carSpaces) propertyDetails.carSpaces = parseInt(carSpaces);
      if (landSize) propertyDetails.landSizeSqm = parseFloat(landSize);
      if (buildSize) propertyDetails.buildSizeSqm = parseFloat(buildSize);
      
      // Include build type from pre-generation data
      propertyDetails.buildType = preGenData.buildType;
      
      // For new builds, add land and build prices
      if (preGenData.buildType === 'new_build') {
        if (preGenData.landPrice) propertyDetails.landPrice = preGenData.landPrice;
        if (preGenData.buildPrice) propertyDetails.buildPrice = preGenData.buildPrice;
        if (preGenData.agentFee) propertyDetails.agentFee = preGenData.agentFee;
      } else {
        if (preGenData.depositValue) propertyDetails.depositValue = preGenData.depositValue;
      }
      
      // Add financial assumptions
      if (preGenData.loanToValueRatio) propertyDetails.loanToValueRatio = preGenData.loanToValueRatio;
      if (preGenData.interestRate) propertyDetails.interestRate = preGenData.interestRate;
      if (preGenData.capitalGrowth) propertyDetails.capitalGrowth = preGenData.capitalGrowth;
      
      // Add expense overrides
      if (preGenData.stampDuty) propertyDetails.stampDuty = preGenData.stampDuty;
      if (preGenData.bodyCorporateFees) propertyDetails.bodyCorporateFees = preGenData.bodyCorporateFees;
      if (preGenData.landTax) propertyDetails.landTax = preGenData.landTax;
      if (preGenData.councilRates) propertyDetails.councilRates = preGenData.councilRates;
      if (preGenData.waterRates) propertyDetails.waterRates = preGenData.waterRates;
      if (preGenData.solicitorFees) propertyDetails.solicitorFees = preGenData.solicitorFees;
      if (preGenData.buildingLandlordInsurance) propertyDetails.buildingLandlordInsurance = preGenData.buildingLandlordInsurance;
      if (preGenData.propertyManagementFees) propertyDetails.propertyManagementFees = preGenData.propertyManagementFees;
      if (preGenData.repairsMaintenance) propertyDetails.repairsMaintenance = preGenData.repairsMaintenance;
      if (preGenData.lettingFees) propertyDetails.lettingFees = preGenData.lettingFees;
      
      // Add strata breakdown
      if (preGenData.strataAdminFund) propertyDetails.strataAdminFund = preGenData.strataAdminFund;
      if (preGenData.strataSinkingFund) propertyDetails.strataSinkingFund = preGenData.strataSinkingFund;
      if (preGenData.strataSpecialLevies) propertyDetails.strataSpecialLevies = preGenData.strataSpecialLevies;
      
      // Add cash flow analysis overrides (optional values that cascade to 10-year analysis)
      if (preGenData.cpiGrowthRate) propertyDetails.cpiGrowthRate = preGenData.cpiGrowthRate;
      if (preGenData.depreciation) propertyDetails.depreciation = preGenData.depreciation;
      if (preGenData.taxRate) propertyDetails.taxRate = preGenData.taxRate;
      if (preGenData.occupancyRate) propertyDetails.occupancyRate = preGenData.occupancyRate;
      if (preGenData.loanType) propertyDetails.loanType = preGenData.loanType;
      if (preGenData.loanTermYears) propertyDetails.loanTermYears = preGenData.loanTermYears;
      if (preGenData.marketValueNow) propertyDetails.marketValueNow = preGenData.marketValueNow;
      
      // Additional cash flow fields (optional)
      if (preGenData.loanAmount) propertyDetails.loanAmount = preGenData.loanAmount;
      if (preGenData.interestOnlyPeriodYears) propertyDetails.interestOnlyPeriodYears = preGenData.interestOnlyPeriodYears;
      if (preGenData.repaymentFrequency) propertyDetails.repaymentFrequency = preGenData.repaymentFrequency;
      if (preGenData.extraRepaymentPerMonth) propertyDetails.extraRepaymentPerMonth = preGenData.extraRepaymentPerMonth;
      if (preGenData.offsetBalance) propertyDetails.offsetBalance = preGenData.offsetBalance;
      if (preGenData.constructionDurationMonths) propertyDetails.constructionDurationMonths = preGenData.constructionDurationMonths;
      if (preGenData.constructionYear) propertyDetails.constructionYear = preGenData.constructionYear;
      if (preGenData.landSizeSqm) propertyDetails.landSizeSqm = preGenData.landSizeSqm;
      if (preGenData.buildSizeSqm) propertyDetails.buildSizeSqm = preGenData.buildSizeSqm;
      
      // First Home Buyer flag for stamp duty concessions
      if (preGenData.isFirstHomeBuyer) propertyDetails.isFirstHomeBuyer = preGenData.isFirstHomeBuyer;
      
      // Construction Stage Percentages (new build only)
      if (preGenData.buildType === 'new_build') {
        if (preGenData.stageDepositPercent) propertyDetails.stageDepositPercent = preGenData.stageDepositPercent;
        if (preGenData.stageSlabPercent) propertyDetails.stageSlabPercent = preGenData.stageSlabPercent;
        if (preGenData.stageFramePercent) propertyDetails.stageFramePercent = preGenData.stageFramePercent;
        if (preGenData.stageLockupPercent) propertyDetails.stageLockupPercent = preGenData.stageLockupPercent;
        if (preGenData.stageFixingPercent) propertyDetails.stageFixingPercent = preGenData.stageFixingPercent;
        if (preGenData.stageCompletionPercent) propertyDetails.stageCompletionPercent = preGenData.stageCompletionPercent;
      }
      
      // Add suburb year context if provided (only for suburb analysis)
      if (queryType === 'suburb') {
        if (dataYearType === 'single' && singleYear) {
          propertyDetails.dataYearType = 'single';
          propertyDetails.dataYear = parseInt(singleYear);
        } else if (dataYearType === 'range' && yearRangeStart && yearRangeEnd) {
          propertyDetails.dataYearType = 'range';
          propertyDetails.dataYearStart = parseInt(yearRangeStart);
          propertyDetails.dataYearEnd = parseInt(yearRangeEnd);
        }
      }

      // Create the report record first with pending status and pre-generation overrides
      // Filter out undefined values and cast to Json for Supabase compatibility
      // Only save overrides for property-specific (address) reports
      const cleanedOverrides = isPropertyScope 
        ? Object.fromEntries(
            Object.entries(preGenData).filter(([_, v]) => v !== undefined)
          ) as Json
        : {} as Json;
      
      // Use secure edge function for insert (service_role required due to RLS)
      const { data: insertResult, error: insertError } = await invokeSecureFunction('manage-investment-reports', {
        action: 'insert',
        data: {
          property_address: propertyAddress,
          report_content: 'Generating report...',
          status: 'pending',
          report_scope: queryType, // Track the scope type
          generated_by: user?.id ?? null,
          generation_engine: generationEngine,
          manual_overrides: cleanedOverrides, // Save pre-generation overrides (empty for area reports)
        },
      });

      if (insertError || !insertResult?.success || !insertResult.report) {
        console.error('Error creating report record:', insertError || insertResult?.error);
        throw new Error(
          `Failed to create report: ${insertError?.message || insertResult?.error || 'Database error'}`
        );
      }

      const pendingReport = insertResult.report;

      // Add to background job tracker
      addBackgroundJob({
        id: pendingReport.id,
        type: 'investment_report'
      });

      // Log report generation activity
      logActivity({
        actionType: 'report_generated',
        entityType: 'investment_report',
        entityId: pendingReport.id,
        entityName: propertyAddress,
        metadata: { queryType, scope: queryType }
      });

      // Get scope text for notification
      const scopeText = queryType === 'address' 
        ? `Property: ${query}` 
        : queryType === 'zipcode' 
          ? `Postcode: ${query}`
          : queryType === 'suburb'
            ? `Suburb: ${query}`
            : `Statewide Analysis: ${query}`;

      // Start generation in background (don't await)
      invokeSecureFunction('generate-investment-report', {
        reportId: pendingReport.id,
        propertyAddress,
        propertyDetails
      }).catch(error => {
        console.error('Background generation error:', error);
      });

      // Add "generation started" notification
      addNotification({
        type: 'report_generation_started',
        title: 'Report Generation Started',
        message: `Generating investment report for ${propertyAddress}...`,
        entityId: pendingReport.id
      });

      toast({
        title: "Report Generation Started",
        description: `Your investment report is being generated in the background. You'll be notified when it's ready. Scope: ${scopeText}`,
      });

      
      // Clear form
      setQuery('');
      setPropertyPrice('');
      setWeeklyRent('');
      setBeds('');
      setBaths('');
      setLandSize('');
      setBuildSize('');
      setSingleYear('');
      setYearRangeStart('');
      setYearRangeEnd('');

    } catch (error) {
      console.error('Error starting report generation:', error);

      toast({
        title: "Failed to Start Generation",
        description: error instanceof Error ? error.message : "Failed to start report generation. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle URL scraping ONLY - populates fields without generating report
  const handleScrapeUrlOnly = async () => {
    if (!propertyUrl.trim()) {
      toast({
        title: "URL Required",
        description: "Please enter a property listing URL to scrape.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please log in to scrape listings.",
        variant: "destructive",
      });
      return;
    }

    setIsScraping(true);
    setScrapeError(null);
    setUrlScrapedData(null);

    try {
      console.log('Scraping property URL:', propertyUrl);
      
      const { data: startData, error: startError } = await invokeSecureFunction('scrape-property-listing', {
        url: propertyUrl
      });

      if (startError) {
        console.error('Scrape function error:', startError);
        throw new Error(startError.message || 'Failed to scrape property listing');
      }

      if (!startData?.success || !startData?.jobId) {
        throw new Error(startData?.error || 'Failed to start scraping job');
      }

      const pollIntervalMs = 5000;
      const maxWaitMs = 1500 * 1000;
      const maxConsecutivePollErrors = 5;
      const startedAt = Date.now();
      let consecutivePollErrors = 0;
      let scrapedResult: any = null;

      while (Date.now() - startedAt <= maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        const { data: pollData, error: pollError } = await invokeSecureFunction('scrape-property-listing', {
          jobId: startData.jobId,
        });

        if (pollError || !pollData?.success) {
          consecutivePollErrors += 1;
          if (consecutivePollErrors >= maxConsecutivePollErrors) {
            throw new Error(pollError?.message || pollData?.error || 'Failed to check scrape status');
          }
          continue;
        }

        consecutivePollErrors = 0;
        if (pollData.status === 'failed') {
          throw new Error(pollData.error || 'Scraping failed');
        }
        if (pollData.status === 'succeeded') {
          scrapedResult = pollData.data;
          break;
        }
      }

      if (!scrapedResult) {
        throw new Error('Scrape is taking longer than expected. Please try again.');
      }

      console.log('Scrape successful:', scrapedResult);
      
      // Extract property details
      const extracted = scrapedResult.extractedDetails || {};
      console.log('Extracted details from scrape:', extracted);
      
      // Build property address - try multiple sources
      let propertyAddress = extracted.extractedAddress;
      if (!propertyAddress && extracted.extractedSuburb && extracted.extractedState) {
        propertyAddress = `${extracted.extractedSuburb}, ${extracted.extractedState}${extracted.extractedPostcode ? ' ' + extracted.extractedPostcode : ''}`;
      }
      if (!propertyAddress) {
        const title = scrapedResult.metadata?.title || '';
        const cleanedTitle = title
          .replace(/\s*[-|]\s*(Domain|realestate\.com\.au|Real Estate|Property|For Sale|Sold).*$/i, '')
          .replace(/^(Domain|realestate\.com\.au|Real Estate|Property|For Sale)\s*[-|]\s*/i, '')
          .trim();
        propertyAddress = cleanedTitle || `Property from ${new URL(propertyUrl).hostname}`;
      }

      // Store scraped data for later generation
      setUrlScrapedData({
        propertyAddress,
        scrapedContent: scrapedResult.markdown,
        sourceUrl: scrapedResult.sourceUrl || propertyUrl,
      });

      // Populate form fields with scraped data (without triggering sync loops)
      isSyncingFromPreGen.current = true;
      
      if (extracted.extractedPrice) {
        setPropertyPrice(extracted.extractedPrice.toString());
      }
      if (extracted.extractedBedrooms) {
        setBeds(extracted.extractedBedrooms.toString());
      }
      if (extracted.extractedBathrooms) {
        setBaths(extracted.extractedBathrooms.toString());
      }
      if (extracted.extractedCarSpaces) {
        setCarSpaces(extracted.extractedCarSpaces.toString());
      }
      if (extracted.extractedLandSize) {
        setLandSize(extracted.extractedLandSize.toString());
      }
      if (extracted.extractedBuildSize) {
        setBuildSize(extracted.extractedBuildSize.toString());
      }
      if (extracted.extractedPropertyType) {
        const pType = extracted.extractedPropertyType.toLowerCase();
        if (pType === 'house' || pType === 'apartment' || pType === 'townhouse') {
          setPropertyType(pType);
        }
      }
      if (extracted.extractedWeeklyRent) {
        setWeeklyRent(extracted.extractedWeeklyRent.toString());
      }

      // Update preGenData with ALL scraped values (including extended fields)
      setPreGenData(prev => ({
        ...prev,
        purchasePrice: extracted.extractedPrice || prev.purchasePrice,
        weeklyRent: extracted.extractedWeeklyRent || prev.weeklyRent,
        carSpaces: extracted.extractedCarSpaces || prev.carSpaces,
        landSizeSqm: extracted.extractedLandSize || prev.landSizeSqm,
        buildSizeSqm: extracted.extractedBuildSize || prev.buildSizeSqm,
        // Extended fields from enhanced scraper
        buildType: extracted.extractedIsNewBuild ? 'new_build' : prev.buildType,
        landPrice: extracted.extractedLandPrice || prev.landPrice,
        buildPrice: extracted.extractedBuildPrice || prev.buildPrice,
        councilRates: extracted.extractedCouncilRates || prev.councilRates,
        waterRates: extracted.extractedWaterRates || prev.waterRates,
        bodyCorporateFees: extracted.extractedStrataFees || prev.bodyCorporateFees,
        buildingLandlordInsurance: extracted.extractedInsurance || prev.buildingLandlordInsurance,
        propertyManagementFees: extracted.extractedPropertyManagementPercent || prev.propertyManagementFees,
        constructionYear: extracted.extractedYearBuilt || prev.constructionYear,
      }));

      requestAnimationFrame(() => { isSyncingFromPreGen.current = false; });

      // Show what was extracted
      const extractedInfo = [];
      if (extracted.extractedPrice) extractedInfo.push(`$${extracted.extractedPrice.toLocaleString()}`);
      if (extracted.extractedBedrooms) extractedInfo.push(`${extracted.extractedBedrooms} beds`);
      if (extracted.extractedBathrooms) extractedInfo.push(`${extracted.extractedBathrooms} baths`);
      if (extracted.extractedLandSize) extractedInfo.push(`${extracted.extractedLandSize}m²`);
      
      const extractedSummary = extractedInfo.length > 0 
        ? `Found: ${extractedInfo.join(', ')}` 
        : 'Limited details extracted - review and add missing data';

      toast({
        title: "Scraping Successful",
        description: extractedSummary + ". Review the fields below, add any overrides, then generate the report.",
      });

    } catch (error) {
      console.error('Error scraping URL:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to scrape property listing';
      setScrapeError(errorMessage);
      toast({
        title: "Scraping Failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsScraping(false);
    }
  };

  // Handle report generation from scraped URL data
  const handleGenerateFromUrl = async () => {
    if (!urlScrapedData) {
      toast({
        title: "Scrape Required",
        description: "Please scrape a URL first before generating a report.",
        variant: "destructive",
      });
      return;
    }

    if (!propertyPrice || parseFloat(propertyPrice) <= 0) {
      toast({
        title: "Purchase Price Required",
        description: "Please enter a valid purchase price to calculate investment score.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please log in to generate reports.",
        variant: "destructive",
      });
      return;
    }

    setIsUrlGenerating(true);

    try {
      const { propertyAddress, scrapedContent, sourceUrl } = urlScrapedData;

      // Build property details with form values and preGenData
      const propertyDetails: any = { 
        queryType: 'address', 
        originalQuery: propertyAddress,
        generationEngine,
        scrapedContent,
        sourceUrl,
        fromUrlScrape: true,
        manualOverrides: preGenData,
      };
      
      // Add form field values
      if (propertyPrice) propertyDetails.price = parseFloat(propertyPrice);
      if (weeklyRent) propertyDetails.weeklyRent = parseFloat(weeklyRent);
      if (propertyType) propertyDetails.propertyType = propertyType;
      if (beds) propertyDetails.beds = parseInt(beds);
      if (baths) propertyDetails.baths = parseInt(baths);
      if (carSpaces) propertyDetails.carSpaces = parseInt(carSpaces);
      if (landSize) propertyDetails.landSizeSqm = parseFloat(landSize);
      if (buildSize) propertyDetails.buildSizeSqm = parseFloat(buildSize);

      // Apply all preGenData overrides
      propertyDetails.buildType = preGenData.buildType;
      if (preGenData.purchasePrice) propertyDetails.price = preGenData.purchasePrice;
      if (preGenData.weeklyRent) propertyDetails.weeklyRent = preGenData.weeklyRent;
      if (preGenData.carSpaces) propertyDetails.carSpaces = preGenData.carSpaces;
      if (preGenData.landSizeSqm) propertyDetails.landSizeSqm = preGenData.landSizeSqm;
      if (preGenData.buildSizeSqm) propertyDetails.buildSizeSqm = preGenData.buildSizeSqm;
      
      if (preGenData.buildType === 'new_build') {
        if (preGenData.landPrice) propertyDetails.landPrice = preGenData.landPrice;
        if (preGenData.buildPrice) propertyDetails.buildPrice = preGenData.buildPrice;
        if (preGenData.agentFee) propertyDetails.agentFee = preGenData.agentFee;
      } else {
        if (preGenData.depositValue) propertyDetails.depositValue = preGenData.depositValue;
      }
      
      if (preGenData.loanToValueRatio) propertyDetails.loanToValueRatio = preGenData.loanToValueRatio;
      if (preGenData.interestRate) propertyDetails.interestRate = preGenData.interestRate;
      if (preGenData.capitalGrowth) propertyDetails.capitalGrowth = preGenData.capitalGrowth;
      if (preGenData.stampDuty) propertyDetails.stampDuty = preGenData.stampDuty;
      if (preGenData.bodyCorporateFees) propertyDetails.bodyCorporateFees = preGenData.bodyCorporateFees;
      if (preGenData.landTax) propertyDetails.landTax = preGenData.landTax;
      if (preGenData.councilRates) propertyDetails.councilRates = preGenData.councilRates;
      if (preGenData.waterRates) propertyDetails.waterRates = preGenData.waterRates;
      if (preGenData.solicitorFees) propertyDetails.solicitorFees = preGenData.solicitorFees;
      if (preGenData.buildingLandlordInsurance) propertyDetails.buildingLandlordInsurance = preGenData.buildingLandlordInsurance;
      if (preGenData.propertyManagementFees) propertyDetails.propertyManagementFees = preGenData.propertyManagementFees;
      if (preGenData.repairsMaintenance) propertyDetails.repairsMaintenance = preGenData.repairsMaintenance;
      if (preGenData.lettingFees) propertyDetails.lettingFees = preGenData.lettingFees;
      if (preGenData.strataAdminFund) propertyDetails.strataAdminFund = preGenData.strataAdminFund;
      if (preGenData.strataSinkingFund) propertyDetails.strataSinkingFund = preGenData.strataSinkingFund;
      if (preGenData.strataSpecialLevies) propertyDetails.strataSpecialLevies = preGenData.strataSpecialLevies;
      if (preGenData.cpiGrowthRate) propertyDetails.cpiGrowthRate = preGenData.cpiGrowthRate;
      if (preGenData.depreciation) propertyDetails.depreciation = preGenData.depreciation;
      if (preGenData.taxRate) propertyDetails.taxRate = preGenData.taxRate;
      if (preGenData.occupancyRate) propertyDetails.occupancyRate = preGenData.occupancyRate;
      if (preGenData.loanType) propertyDetails.loanType = preGenData.loanType;
      if (preGenData.loanTermYears) propertyDetails.loanTermYears = preGenData.loanTermYears;
      if (preGenData.marketValueNow) propertyDetails.marketValueNow = preGenData.marketValueNow;
      if (preGenData.loanAmount) propertyDetails.loanAmount = preGenData.loanAmount;
      if (preGenData.interestOnlyPeriodYears) propertyDetails.interestOnlyPeriodYears = preGenData.interestOnlyPeriodYears;
      if (preGenData.repaymentFrequency) propertyDetails.repaymentFrequency = preGenData.repaymentFrequency;
      if (preGenData.extraRepaymentPerMonth) propertyDetails.extraRepaymentPerMonth = preGenData.extraRepaymentPerMonth;
      if (preGenData.offsetBalance) propertyDetails.offsetBalance = preGenData.offsetBalance;
      if (preGenData.constructionDurationMonths) propertyDetails.constructionDurationMonths = preGenData.constructionDurationMonths;
      if (preGenData.constructionYear) propertyDetails.constructionYear = preGenData.constructionYear;
      if (preGenData.isFirstHomeBuyer) propertyDetails.isFirstHomeBuyer = preGenData.isFirstHomeBuyer;
      
      if (preGenData.buildType === 'new_build') {
        if (preGenData.stageDepositPercent) propertyDetails.stageDepositPercent = preGenData.stageDepositPercent;
        if (preGenData.stageSlabPercent) propertyDetails.stageSlabPercent = preGenData.stageSlabPercent;
        if (preGenData.stageFramePercent) propertyDetails.stageFramePercent = preGenData.stageFramePercent;
        if (preGenData.stageLockupPercent) propertyDetails.stageLockupPercent = preGenData.stageLockupPercent;
        if (preGenData.stageFixingPercent) propertyDetails.stageFixingPercent = preGenData.stageFixingPercent;
        if (preGenData.stageCompletionPercent) propertyDetails.stageCompletionPercent = preGenData.stageCompletionPercent;
      }
      
      if (preGenData.depreciationSchedule) propertyDetails.depreciationSchedule = preGenData.depreciationSchedule;
      if (preGenData.depreciationMethod) propertyDetails.depreciationMethod = preGenData.depreciationMethod;

      // Create the report record
      const cleanedOverrides = Object.fromEntries(
        Object.entries(preGenData).filter(([_, v]) => v !== undefined)
      ) as Json;
      
      // Use secure edge function for insert (service_role required due to RLS)
      const { data: insertResult, error: insertError } = await invokeSecureFunction('manage-investment-reports', {
        action: 'insert',
        data: {
          property_address: propertyAddress,
          report_content: 'Generating report from scraped listing...',
          status: 'pending',
          report_scope: 'address',
          generated_by: user?.id ?? null,
          generation_engine: generationEngine,
          manual_overrides: cleanedOverrides,
        },
      });

      if (insertError || !insertResult?.success || !insertResult.report) {
        throw new Error(
          `Failed to create report: ${insertError?.message || insertResult?.error || 'Database error'}`
        );
      }

      const pendingReport = insertResult.report;

      addBackgroundJob({
        id: pendingReport.id,
        type: 'investment_report'
      });

      // Start generation in background
      invokeSecureFunction('generate-investment-report', {
        reportId: pendingReport.id,
        propertyAddress,
        propertyDetails,
      }).catch(error => {
        console.error('Background generation error:', error);
      });

      // Add "generation started" notification
      addNotification({
        type: 'report_generation_started',
        title: 'Report Generation Started',
        message: `Generating investment report for ${propertyAddress}...`,
        entityId: pendingReport.id
      });

      toast({
        title: "Report Generation Started",
        description: `Investment report is being generated for "${propertyAddress}". You'll be notified when it's ready.`,
      });

      
      // Clear form
      setPropertyUrl('');
      setUrlScrapedData(null);

    } catch (error) {
      console.error('Error generating report from URL:', error);
      toast({
        title: "Generation Failed",
        description: error instanceof Error ? error.message : 'Failed to generate report',
        variant: "destructive",
      });
    } finally {
      setIsUrlGenerating(false);
    }
  };


  // Handle PDF/image file drop
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (isPdfFile(file) || isImageFile(file)) {
        setPdfFile(file);
        setPdfError(null);
      } else {
        setPdfError('Please upload a PDF or image file (PNG, JPG, WEBP)');
      }
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (isPdfFile(file) || isImageFile(file)) {
        setPdfFile(file);
        setPdfError(null);
      } else {
        setPdfError('Please upload a PDF or image file (PNG, JPG, WEBP)');
      }
    }
  };

  // Handle PDF/image parsing ONLY - populates fields without generating report
  const handleParsePdfOnly = async () => {
    if (!pdfFile) {
      toast({
        title: "File Required",
        description: "Please upload a PDF or image file first.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please log in to parse documents.",
        variant: "destructive",
      });
      return;
    }

    setIsParsing(true);
    setPdfError(null);
    setConversionProgress(null);
    setPdfParsedData(null);

    try {
      console.log('Processing file:', pdfFile.name, 'Type:', pdfFile.type);
      
      let requestBody: any = { fileName: pdfFile.name };
      
      if (isPdfFile(pdfFile)) {
        console.log('🔄 Converting PDF to images...');
        
        toast({
          title: "Converting PDF",
          description: "Rendering PDF pages as images for analysis...",
        });
        
        const conversionResult = await convertPdfToImages(pdfFile, (current, total) => {
          setConversionProgress({ current, total });
          console.log(`📄 Rendering page ${current}/${total}`);
        });
        
        if (!conversionResult.success) {
          throw new Error(conversionResult.error || 'Failed to convert PDF to images');
        }
        
        console.log(`✅ PDF converted: ${conversionResult.images.length} pages rendered`);
        
        requestBody.pageImages = conversionResult.images.map(img => ({
          pageNumber: img.pageNumber,
          base64: img.base64,
          width: img.width,
          height: img.height,
        }));
        
        toast({
          title: "Analyzing Document",
          description: `Sending ${conversionResult.images.length} page(s) to GPT-4o Vision for analysis...`,
        });
        
      } else if (isImageFile(pdfFile)) {
        console.log('🖼️ Processing image file...');
        
        const base64 = await imageFileToBase64(pdfFile);
        requestBody.singleImage = base64;
        requestBody.imageMimeType = pdfFile.type || 'image/png';
        
        toast({
          title: "Analyzing Image",
          description: "Sending image to GPT-4o Vision for analysis...",
        });
        
      } else {
        throw new Error('Unsupported file type. Please upload a PDF or image file.');
      }

      const { data, error } = await invokeSecureFunction('parse-property-pdf', 
        requestBody
      );

      setConversionProgress(null);

      if (error) {
        throw new Error(error.message || 'Failed to parse document');
      }

      if (!data.success) {
        throw new Error(data.error || 'Document parsing failed');
      }

      console.log('✅ Document parsed successfully:', data);
      const extracted = data.extractedData || {};
      
      // Build property address
      let propertyAddress = extracted.extractedAddress;
      if (!propertyAddress && extracted.extractedSuburb) {
        propertyAddress = `${extracted.extractedSuburb}${extracted.extractedState ? ', ' + extracted.extractedState : ''}${extracted.extractedPostcode ? ' ' + extracted.extractedPostcode : ''}`;
      }
      if (!propertyAddress) {
        propertyAddress = `Property from ${pdfFile.name}`;
      }

      // Store parsed data for later generation
      setPdfParsedData({
        propertyAddress,
        pdfContent: data.pdfContent,
      });

      // Populate form fields with extracted data (without triggering sync loops)
      isSyncingFromPreGen.current = true;
      
      if (extracted.extractedPrice) {
        setPropertyPrice(extracted.extractedPrice.toString());
      }
      if (extracted.extractedBedrooms) {
        setBeds(extracted.extractedBedrooms.toString());
      }
      if (extracted.extractedBathrooms) {
        setBaths(extracted.extractedBathrooms.toString());
      }
      if (extracted.extractedCarSpaces) {
        setCarSpaces(extracted.extractedCarSpaces.toString());
      }
      if (extracted.extractedLandSize) {
        setLandSize(extracted.extractedLandSize.toString());
      }
      if (extracted.extractedBuildSize) {
        setBuildSize(extracted.extractedBuildSize.toString());
      }
      if (extracted.extractedPropertyType) {
        const pType = extracted.extractedPropertyType.toLowerCase();
        if (pType === 'house' || pType === 'apartment' || pType === 'townhouse') {
          setPropertyType(pType);
        }
      }
      if (extracted.extractedWeeklyRent) {
        setWeeklyRent(extracted.extractedWeeklyRent.toString());
      }

      // If new build detected, update build type
      if (extracted.extractedIsNewBuild) {
        setPreGenData(prev => ({ ...prev, buildType: 'new_build' }));
      }

      // Populate land price and build price form fields if extracted
      if (extracted.extractedLandPrice) {
        setLandPrice(extracted.extractedLandPrice.toString());
      }
      if (extracted.extractedBuildPrice) {
        setBuildPrice(extracted.extractedBuildPrice.toString());
      }

      // Update preGenData with ALL extracted values (including extended fields)
      setPreGenData(prev => ({
        ...prev,
        purchasePrice: extracted.extractedPrice || prev.purchasePrice,
        weeklyRent: extracted.extractedWeeklyRent || prev.weeklyRent,
        carSpaces: extracted.extractedCarSpaces || prev.carSpaces,
        landSizeSqm: extracted.extractedLandSize || prev.landSizeSqm,
        buildSizeSqm: extracted.extractedBuildSize || prev.buildSizeSqm,
        landPrice: extracted.extractedLandPrice || prev.landPrice,
        buildPrice: extracted.extractedBuildPrice || prev.buildPrice,
        // Extended fields from enhanced PDF parser
        councilRates: extracted.extractedCouncilRates || prev.councilRates,
        waterRates: extracted.extractedWaterRates || prev.waterRates,
        bodyCorporateFees: extracted.extractedStrataFees || prev.bodyCorporateFees,
        buildingLandlordInsurance: extracted.extractedInsurance || prev.buildingLandlordInsurance,
        propertyManagementFees: extracted.extractedPropertyManagementPercent || prev.propertyManagementFees,
        stampDuty: extracted.extractedStampDuty || prev.stampDuty,
        agentFee: extracted.extractedAgentFee || prev.agentFee,
        constructionYear: extracted.extractedYearBuilt || prev.constructionYear,
      }));

      requestAnimationFrame(() => { isSyncingFromPreGen.current = false; });

      // Show what was extracted
      const extractedInfo = [];
      if (extracted.extractedPrice) extractedInfo.push(`$${extracted.extractedPrice.toLocaleString()}`);
      if (extracted.extractedBedrooms) extractedInfo.push(`${extracted.extractedBedrooms} beds`);
      if (extracted.extractedBathrooms) extractedInfo.push(`${extracted.extractedBathrooms} baths`);
      if (extracted.extractedLandSize) extractedInfo.push(`${extracted.extractedLandSize}m² land`);
      if (extracted.extractedIsNewBuild) extractedInfo.push('New Build');
      
      const extractedSummary = extractedInfo.length > 0 
        ? `Found: ${extractedInfo.join(', ')}` 
        : 'Limited details extracted - review and add missing data';

      toast({
        title: "PDF Parsed Successfully",
        description: extractedSummary + ". Review the fields below, add any overrides, then generate the report.",
      });

    } catch (error) {
      console.error('Error processing document:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to process document';
      setPdfError(errorMessage);
      toast({
        title: "Document Processing Failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsParsing(false);
      setConversionProgress(null);
    }
  };

  // Handle report generation from parsed PDF data
  const handleGenerateFromPdf = async () => {
    if (!pdfParsedData) {
      toast({
        title: "Parse Required",
        description: "Please parse a PDF first before generating a report.",
        variant: "destructive",
      });
      return;
    }

    if (!propertyPrice || parseFloat(propertyPrice) <= 0) {
      toast({
        title: "Purchase Price Required",
        description: "Please enter a valid purchase price to calculate investment score.",
        variant: "destructive",
      });
      return;
    }

    if (!user) {
      toast({
        title: "Authentication Required",
        description: "Please log in to generate reports.",
        variant: "destructive",
      });
      return;
    }

    setIsPdfGenerating(true);

    try {
      const { propertyAddress, pdfContent } = pdfParsedData;

      // Build property details with form values and preGenData
      const propertyDetails: any = { 
        queryType: 'address', 
        originalQuery: propertyAddress,
        generationEngine,
        pdfContent,
        fromPdfUpload: true,
        manualOverrides: preGenData,
      };
      
      // Add form field values
      if (propertyPrice) propertyDetails.price = parseFloat(propertyPrice);
      if (weeklyRent) propertyDetails.weeklyRent = parseFloat(weeklyRent);
      if (propertyType) propertyDetails.propertyType = propertyType;
      if (beds) propertyDetails.beds = parseInt(beds);
      if (baths) propertyDetails.baths = parseInt(baths);
      if (carSpaces) propertyDetails.carSpaces = parseInt(carSpaces);
      if (landSize) propertyDetails.landSizeSqm = parseFloat(landSize);
      if (buildSize) propertyDetails.buildSizeSqm = parseFloat(buildSize);

      // Apply all preGenData overrides
      propertyDetails.buildType = preGenData.buildType;
      if (preGenData.purchasePrice) propertyDetails.price = preGenData.purchasePrice;
      if (preGenData.weeklyRent) propertyDetails.weeklyRent = preGenData.weeklyRent;
      if (preGenData.carSpaces) propertyDetails.carSpaces = preGenData.carSpaces;
      if (preGenData.landSizeSqm) propertyDetails.landSizeSqm = preGenData.landSizeSqm;
      if (preGenData.buildSizeSqm) propertyDetails.buildSizeSqm = preGenData.buildSizeSqm;
      
      if (preGenData.buildType === 'new_build') {
        if (preGenData.landPrice) propertyDetails.landPrice = preGenData.landPrice;
        if (preGenData.buildPrice) propertyDetails.buildPrice = preGenData.buildPrice;
        if (preGenData.agentFee) propertyDetails.agentFee = preGenData.agentFee;
      } else {
        if (preGenData.depositValue) propertyDetails.depositValue = preGenData.depositValue;
      }
      
      if (preGenData.loanToValueRatio) propertyDetails.loanToValueRatio = preGenData.loanToValueRatio;
      if (preGenData.interestRate) propertyDetails.interestRate = preGenData.interestRate;
      if (preGenData.capitalGrowth) propertyDetails.capitalGrowth = preGenData.capitalGrowth;
      if (preGenData.stampDuty) propertyDetails.stampDuty = preGenData.stampDuty;
      if (preGenData.bodyCorporateFees) propertyDetails.bodyCorporateFees = preGenData.bodyCorporateFees;
      if (preGenData.landTax) propertyDetails.landTax = preGenData.landTax;
      if (preGenData.councilRates) propertyDetails.councilRates = preGenData.councilRates;
      if (preGenData.waterRates) propertyDetails.waterRates = preGenData.waterRates;
      if (preGenData.solicitorFees) propertyDetails.solicitorFees = preGenData.solicitorFees;
      if (preGenData.buildingLandlordInsurance) propertyDetails.buildingLandlordInsurance = preGenData.buildingLandlordInsurance;
      if (preGenData.propertyManagementFees) propertyDetails.propertyManagementFees = preGenData.propertyManagementFees;
      if (preGenData.repairsMaintenance) propertyDetails.repairsMaintenance = preGenData.repairsMaintenance;
      if (preGenData.lettingFees) propertyDetails.lettingFees = preGenData.lettingFees;
      if (preGenData.strataAdminFund) propertyDetails.strataAdminFund = preGenData.strataAdminFund;
      if (preGenData.strataSinkingFund) propertyDetails.strataSinkingFund = preGenData.strataSinkingFund;
      if (preGenData.strataSpecialLevies) propertyDetails.strataSpecialLevies = preGenData.strataSpecialLevies;
      if (preGenData.cpiGrowthRate) propertyDetails.cpiGrowthRate = preGenData.cpiGrowthRate;
      if (preGenData.depreciation) propertyDetails.depreciation = preGenData.depreciation;
      if (preGenData.taxRate) propertyDetails.taxRate = preGenData.taxRate;
      if (preGenData.occupancyRate) propertyDetails.occupancyRate = preGenData.occupancyRate;
      if (preGenData.loanType) propertyDetails.loanType = preGenData.loanType;
      if (preGenData.loanTermYears) propertyDetails.loanTermYears = preGenData.loanTermYears;
      if (preGenData.marketValueNow) propertyDetails.marketValueNow = preGenData.marketValueNow;
      if (preGenData.loanAmount) propertyDetails.loanAmount = preGenData.loanAmount;
      if (preGenData.interestOnlyPeriodYears) propertyDetails.interestOnlyPeriodYears = preGenData.interestOnlyPeriodYears;
      if (preGenData.repaymentFrequency) propertyDetails.repaymentFrequency = preGenData.repaymentFrequency;
      if (preGenData.extraRepaymentPerMonth) propertyDetails.extraRepaymentPerMonth = preGenData.extraRepaymentPerMonth;
      if (preGenData.offsetBalance) propertyDetails.offsetBalance = preGenData.offsetBalance;
      if (preGenData.constructionDurationMonths) propertyDetails.constructionDurationMonths = preGenData.constructionDurationMonths;
      if (preGenData.constructionYear) propertyDetails.constructionYear = preGenData.constructionYear;
      if (preGenData.isFirstHomeBuyer) propertyDetails.isFirstHomeBuyer = preGenData.isFirstHomeBuyer;
      
      if (preGenData.buildType === 'new_build') {
        if (preGenData.stageDepositPercent) propertyDetails.stageDepositPercent = preGenData.stageDepositPercent;
        if (preGenData.stageSlabPercent) propertyDetails.stageSlabPercent = preGenData.stageSlabPercent;
        if (preGenData.stageFramePercent) propertyDetails.stageFramePercent = preGenData.stageFramePercent;
        if (preGenData.stageLockupPercent) propertyDetails.stageLockupPercent = preGenData.stageLockupPercent;
        if (preGenData.stageFixingPercent) propertyDetails.stageFixingPercent = preGenData.stageFixingPercent;
        if (preGenData.stageCompletionPercent) propertyDetails.stageCompletionPercent = preGenData.stageCompletionPercent;
      }
      
      if (preGenData.depreciationSchedule) propertyDetails.depreciationSchedule = preGenData.depreciationSchedule;
      if (preGenData.depreciationMethod) propertyDetails.depreciationMethod = preGenData.depreciationMethod;

      // Create the report record
      const pdfOverrides = Object.fromEntries(
        Object.entries(preGenData).filter(([_, v]) => v !== undefined)
      ) as Json;
      
      // Use secure edge function for insert (service_role required due to RLS)
      const { data: insertResult, error: insertError } = await invokeSecureFunction('manage-investment-reports', {
        action: 'insert',
        data: {
          property_address: propertyAddress,
          report_content: 'Generating report from PDF...',
          status: 'pending',
          report_scope: 'address',
          generated_by: user?.id ?? null,
          generation_engine: generationEngine,
          manual_overrides: pdfOverrides,
        },
      });

      if (insertError || !insertResult?.success || !insertResult.report) {
        throw new Error(
          `Failed to create report: ${insertError?.message || insertResult?.error || 'Database error'}`
        );
      }

      const pendingReport = insertResult.report;

      addBackgroundJob({
        id: pendingReport.id,
        type: 'investment_report'
      });

      // Start generation in background
      invokeSecureFunction('generate-investment-report', {
        reportId: pendingReport.id,
        propertyAddress,
        propertyDetails,
      }).catch(error => {
        console.error('Background generation error:', error);
      });

      // Add "generation started" notification
      addNotification({
        type: 'report_generation_started',
        title: 'Report Generation Started',
        message: `Generating investment report for ${propertyAddress}...`,
        entityId: pendingReport.id
      });

      toast({
        title: "Report Generation Started",
        description: `Investment report is being generated for "${propertyAddress}". You'll be notified when it's ready.`,
      });

      
      // Clear form
      setPdfFile(null);
      setPdfParsedData(null);

    } catch (error) {
      console.error('Error generating report from PDF:', error);
      toast({
        title: "Generation Failed",
        description: error instanceof Error ? error.message : 'Failed to generate report',
        variant: "destructive",
      });
    } finally {
      setIsPdfGenerating(false);
    }
  };


  const getQueryTypeIcon = () => {
    switch (queryType) {
      case 'address':
        return <MapPin className="h-4 w-4" />;
      case 'zipcode':
        return <Hash className="h-4 w-4" />;
      case 'suburb':
        return <MapPin className="h-4 w-4" />;
      case 'state':
        return <Globe className="h-4 w-4" />;
      default:
        return <MapPin className="h-4 w-4" />;
    }
  };

  const getQueryTypePlaceholder = () => {
    switch (queryType) {
      case 'address':
        return 'e.g., 123 Main Street, Sydney NSW 2000';
      case 'zipcode':
        return 'e.g., 2000, 3000, 4000';
      case 'suburb':
        return 'e.g., Bondi NSW, Carlton VIC, Fortitude Valley QLD';
      case 'state':
        return 'e.g., NSW, VIC, QLD, WA, SA, TAS, NT, ACT';
      default:
        return 'Enter your query...';
    }
  };

  return (
    <div className="ci-foundation reports-investment-generator space-y-6">
      {/* Header */}
      <Card className="ci-card-premium reports-investment-hero">
        <CardContent className="p-5 md:p-6 space-y-2">
        <p className="ci-tab-eyebrow">Investment report workspace</p>
        <h2 className="text-2xl font-bold text-foreground">Investment Report Generator</h2>
        <p className="text-muted-foreground">
          Generate comprehensive property investment analysis for addresses, postcodes, or states across Australia.
        </p>
        </CardContent>
      </Card>

      <div className="reports-investment-layout grid gap-6">
        {/* Generator Form */}
        <div>
          <Card className="ci-card-premium reports-investment-panel">
            <CardHeader className="reports-investment-panel-header border-b border-border/60">
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Generate Investment Analysis
              </CardTitle>
              <CardDescription>
                Choose your input method - enter details manually, scrape from a URL, or upload a PDF.
              </CardDescription>
            </CardHeader>
            <CardContent className="reports-investment-panel-content space-y-6">
            {/* Input Mode Tabs */}
              <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'manual' | 'url' | 'pdf')}>
                {isPropertySpecific ? (
                  <div className="reports-investment-mode-shell overflow-x-auto -mx-1 px-1 scrollbar-hide">
                    <TabsList aria-label="Investment report input method" className="reports-investment-mode-list rounded-2xl border border-border/70 bg-background/60 p-1">
                      <TabsTrigger value="manual" className="reports-investment-mode-tab">
                        <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        <span className="reports-investment-mode-label">Manual</span>
                      </TabsTrigger>
                      <TabsTrigger value="url" className="reports-investment-mode-tab">
                        <Link className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        <span className="reports-investment-mode-label">URL Scrape</span>
                      </TabsTrigger>
                      <TabsTrigger value="pdf" className="reports-investment-mode-tab">
                        <Upload className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        <span className="reports-investment-mode-label">PDF Upload</span>
                      </TabsTrigger>
                    </TabsList>
                  </div>
                ) : (
                  <TabsList aria-label="Investment report input method" className="reports-investment-mode-list reports-investment-mode-single grid w-full grid-cols-1 rounded-2xl border border-border/70 bg-background/60 p-1">
                    <TabsTrigger value="manual" className="reports-investment-mode-tab">
                      <MapPin className="h-4 w-4" />
                      Manual Entry
                    </TabsTrigger>
                  </TabsList>
                )}

                {/* Manual Entry Tab */}
                <TabsContent value="manual" className="reports-investment-flow space-y-6 pt-4">
                  {/* Build Type Radio Selection - Only for property-specific */}
                  {isPropertySpecific && (
                    <>
                      <div className="reports-build-type-control space-y-3">
                        <Label className="reports-investment-section-label text-base font-semibold">Build Type</Label>
                        <BuildTypeSelector
                          value={preGenData.buildType as BuildType}
                          onChange={(value) => setPreGenData(prev => ({ ...prev, buildType: value }))}
                          disabled={isGenerating}
                          showCard={false}
                          size="sm"
                        />
                      </div>
                      <Separator />
                    </>
                  )}
                  {/* Query Type Selection */}
                  <div className="space-y-3">
                    <Label htmlFor="queryType">Analysis Scope</Label>
                    <Select value={queryType} onValueChange={(value: 'address' | 'zipcode' | 'suburb' | 'state') => setQueryType(value)}>
                      <SelectTrigger className="reports-select-trigger bg-background">
                        <SelectValue placeholder="Select analysis type" />
                      </SelectTrigger>
                      <SelectContent className="reports-select-content bg-background z-50">
                        <SelectItem value="address">
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            Specific Property Address
                          </div>
                        </SelectItem>
                        <SelectItem value="zipcode">
                          <div className="flex items-center gap-2">
                            <Hash className="h-4 w-4" />
                            Postcode Area Analysis
                          </div>
                        </SelectItem>
                        <SelectItem value="suburb">
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            Suburb Investment Analysis
                          </div>
                        </SelectItem>
                        <SelectItem value="state">
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4" />
                            State-Wide Market Analysis
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Generation Engine Selection */}
                  <div className="space-y-3">
                    <Label htmlFor="generationEngine">Generation Engine</Label>
                    <Select
                      value={generationEngine}
                      onValueChange={(value: 'legacy' | 'compass-40') => setGenerationEngine(value)}
                    >
                      <SelectTrigger className="reports-select-trigger bg-background">
                        <SelectValue placeholder="Select engine" />
                      </SelectTrigger>
                      <SelectContent className="reports-select-content bg-background z-50">
                        <SelectItem value="legacy">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium">Legacy Compass — Stable</span>
                            <span className="text-xs text-muted-foreground">Full DB template, ~12 chunks, battle-tested</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="compass-40">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium">Compass-40 — Trimmed</span>
                            <span className="text-xs text-muted-foreground">~38–42 pages, finance content removed (Financial Analysis Report covers it)</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="reports-engine-helper text-xs text-muted-foreground">
                      You can switch engines later via the Regenerate action on each report.
                    </p>
                  </div>


                  {/* Query Input */}
                  <div className="space-y-3">
                    <Label htmlFor="query" className="flex items-center gap-2">
                      {getQueryTypeIcon()}
                      {queryType === 'address' && 'Property Address'}
                      {queryType === 'zipcode' && 'Postcode'}
                      {queryType === 'suburb' && 'Suburb Name'}
                      {queryType === 'state' && 'State'}
                    </Label>
                    {queryType === 'address' && preGenData.buildType === 'existing_property' ? (
                      <AddressAutocomplete
                        id="query"
                        value={query}
                        onChange={setQuery}
                        placeholder={getQueryTypePlaceholder()}
                        disabled={isGenerating}
                        showIcon={false}
                      />
                    ) : (
                      <Input
                        id="query"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={getQueryTypePlaceholder()}
                        disabled={isGenerating}
                      />
                    )}
                    {/* Query type description hints */}
                    {queryType === 'zipcode' && (
                      <p className="text-xs text-muted-foreground">
                        Generates an area-level market analysis covering median prices, growth trends, demographics, and investment potential for the postcode.
                      </p>
                    )}
                    {queryType === 'suburb' && (
                      <p className="text-xs text-muted-foreground">
                        Generates a suburb-level snapshot including market performance, rental yields, demographic trends, and infrastructure analysis.
                      </p>
                    )}
                    {queryType === 'state' && (
                      <p className="text-xs text-muted-foreground">
                        Generates a statewide market overview covering regional trends, growth corridors, policy impacts, and investment hotspots.
                      </p>
                    )}
                  </div>


              {/* Suburb Year Context - Only show for suburb analysis */}
              {queryType === 'suburb' && (
                <>
                  <Separator />
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label className="text-base font-semibold">Data Year Context (Optional)</Label>
                      <Badge variant="outline" className="text-xs">Suburb Analysis</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Specify the year(s) for which data should be sourced and analyzed. Leave empty for the most current data.
                    </p>

                    <div className="space-y-3">
                      <Label>Data Period Type</Label>
                      <Select value={dataYearType} onValueChange={(value: 'single' | 'range') => setDataYearType(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="single">Single Year</SelectItem>
                          <SelectItem value="range">Year Range</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {dataYearType === 'single' ? (
                      <div className="space-y-2">
                        <Label htmlFor="singleYear">Data Year</Label>
                        <Input
                          id="singleYear"
                          type="number"
                          min="2010"
                          max={new Date().getFullYear()}
                          value={singleYear}
                          onChange={(e) => setSingleYear(e.target.value)}
                          placeholder={`e.g., ${new Date().getFullYear()}`}
                          disabled={isGenerating}
                        />
                        <p className="text-xs text-muted-foreground">
                          Focus on data from a specific year (e.g., 2024 for latest annual data)
                        </p>
                      </div>
                    ) : (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="yearRangeStart">From Year</Label>
                          <Input
                            id="yearRangeStart"
                            type="number"
                            min="2010"
                            max={new Date().getFullYear()}
                            value={yearRangeStart}
                            onChange={(e) => setYearRangeStart(e.target.value)}
                            placeholder="e.g., 2020"
                            disabled={isGenerating}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="yearRangeEnd">To Year</Label>
                          <Input
                            id="yearRangeEnd"
                            type="number"
                            min="2010"
                            max={new Date().getFullYear()}
                            value={yearRangeEnd}
                            onChange={(e) => setYearRangeEnd(e.target.value)}
                            placeholder={`e.g., ${new Date().getFullYear()}`}
                            disabled={isGenerating}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground sm:col-span-2">
                          Analyze trends and data across multiple years (e.g., 2020-2024 for 5-year trends)
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Pre-Generation Manual Inputs - Only for property-specific */}
              {isPropertySpecific && (
                <>
                  <Separator />
                  <PreGenerationOverrides
                    propertyAddress={query}
                    onDataChange={handlePreGenDataChange}
                    disabled={isGenerating}
                    buildType={preGenData.buildType}
                    onBuildTypeChange={(bt) => setPreGenData(prev => ({ ...prev, buildType: bt }))}
                    externalPurchasePrice={propertyPrice ? parseFloat(propertyPrice) : undefined}
                    externalLandPrice={landPrice ? parseFloat(landPrice) : undefined}
                    externalBuildPrice={buildPrice ? parseFloat(buildPrice) : undefined}
                    externalWeeklyRent={weeklyRent ? parseFloat(weeklyRent) : undefined}
                    externalCarSpaces={carSpaces ? parseInt(carSpaces) : undefined}
                    externalLandSize={landSize ? parseFloat(landSize) : undefined}
                    externalBuildSize={buildSize ? parseFloat(buildSize) : undefined}
                    externalCouncilRates={preGenData.councilRates}
                    externalWaterRates={preGenData.waterRates}
                    externalBodyCorporateFees={preGenData.bodyCorporateFees}
                    externalBuildingInsurance={preGenData.buildingLandlordInsurance}
                    externalPropertyManagementPercent={preGenData.propertyManagementFees}
                    externalConstructionYear={preGenData.constructionYear}
                    externalPropertyType={propertyType}
                    onPropertyTypeChange={setPropertyType}
                    beds={beds}
                    onBedsChange={setBeds}
                    baths={baths}
                    onBathsChange={setBaths}
                    onPurchasePriceChange={handlePropertyPriceChange}
                    onWeeklyRentChange={handleWeeklyRentChange}
                    onCarSpacesChange={handleCarSpacesChange}
                    onLandSizeChange={handleLandSizeChange}
                    onBuildSizeChange={handleBuildSizeChange}
                    onLandPriceChange={setLandPrice}
                    onBuildPriceChange={setBuildPrice}
                    hideBuildTypeSelector
                  />
                </>
              )}

              {/* Info Box */}
              <div className="rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/10 via-card to-card p-5 shadow-sm space-y-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary ring-1 ring-primary/15">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="space-y-3">
                    {isPropertySpecific ? (
                      <>
                        <p className="text-sm font-semibold text-foreground"><strong>What you'll get:</strong></p>
                        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Property basics and financial snapshot</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Investment & growth potential analysis</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Location & suburb profile</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />10-year projection calculations</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Investment recommendation with rating</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Curated sources and citations</li>
                        </ul>
                      </>
                    ) : queryType === 'zipcode' ? (
                      <>
                        <p className="text-sm font-semibold text-foreground"><strong>What you'll get:</strong></p>
                        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Postcode market overview and median prices</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Capital growth trends and rental yields</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Demographic and economic profile</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Infrastructure and development pipeline</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Investment potential assessment</li>
                        </ul>
                      </>
                    ) : queryType === 'suburb' ? (
                      <>
                        <p className="text-sm font-semibold text-foreground"><strong>What you'll get:</strong></p>
                        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Suburb market performance snapshot</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Property price trends and rental data</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Demographics and lifestyle factors</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Amenities and transport analysis</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Growth corridor assessment</li>
                        </ul>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-foreground"><strong>What you'll get:</strong></p>
                        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />State-wide market conditions overview</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Regional growth hotspots</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Government policy and regulatory impacts</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Population and migration trends</li>
                          <li className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />Top investment corridors and recommendations</li>
                        </ul>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Token cost + balance status */}
              <div className="space-y-3 rounded-2xl border bg-card/80 p-4 shadow-sm">
                <ReportGenerationStatus
                  kind="report.investment.compass"
                  estimate={estimateTokens('report.investment.compass', { aiNarrative: true, extraSections: isPropertySpecific ? 1 : 0 })}
                />
                <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2">
                  <span className="text-xs font-medium text-muted-foreground">Projected token cost (updates with inputs)</span>
                  <TokenCostEstimate
                    kind="report.investment.compass"
                    options={{ aiNarrative: true, extraSections: isPropertySpecific ? 1 : 0 }}
                  />
                </div>
              </div>

              {/* Generate Button */}
              <Button
                onClick={handleGenerate}
                disabled={isGenerating || !query.trim() || (isPropertySpecific && (!propertyPrice || parseFloat(propertyPrice) <= 0))}
                size="lg"
                className="w-full h-12 shadow-lg shadow-primary/20 disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating Analysis...
                  </>
                ) : (
                  <>
                    <TrendingUp className="h-4 w-4 mr-2" />
                    Generate Investment Report
                  </>
                )}
              </Button>

              {isGenerating && (
                <div className="reports-processing-state text-center space-y-2">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    Analyzing market data and generating comprehensive report...
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This may take up to 30 seconds
                  </p>
                </div>
              )}
                </TabsContent>

                {/* URL Scrape Tab - Only for property-specific queries */}
                {isPropertySpecific && (
                <TabsContent value="url" className="reports-investment-flow space-y-6 pt-4">
                  {/* Build Type Radio Selection */}
                  <div className="reports-build-type-control space-y-3">
                    <Label className="reports-investment-section-label text-base font-semibold">Build Type</Label>
                    <BuildTypeSelector
                      value={preGenData.buildType as BuildType}
                      onChange={(value) => setPreGenData(prev => ({ ...prev, buildType: value }))}
                      disabled={isScraping}
                      showCard={false}
                      size="sm"
                    />
                  </div>

                  <Separator />

                  {/* URL Input */}
                  <div className="space-y-3">
                    <Label htmlFor="propertyUrl" className="flex items-center gap-2">
                      <Link className="h-4 w-4" />
                      Property Listing URL
                    </Label>
                    <Input
                      id="propertyUrl"
                      value={propertyUrl}
                      onChange={(e) => setPropertyUrl(e.target.value)}
                      placeholder="https://www.domain.com.au/property/..."
                      disabled={isScraping}
                    />
                    <p className="text-xs text-muted-foreground">
                      Paste a URL from Domain, REA, or other property listing sites. Click "Scrape URL" to extract property details.
                    </p>
                  </div>

                  {/* Scrape Button - Moved to top right after URL input */}
                  <div className="flex gap-3">
                    <Button
                      onClick={handleScrapeUrlOnly}
                      disabled={isScraping || !propertyUrl.trim()}
                      size="lg"
                      variant={urlScrapedData ? "outline" : "default"}
                      className="flex-1"
                    >
                      {isScraping ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Scraping...
                        </>
                      ) : urlScrapedData ? (
                        <>
                          <Link className="h-4 w-4 mr-2" />
                          Re-Scrape URL
                        </>
                      ) : (
                        <>
                          <Link className="h-4 w-4 mr-2" />
                          Scrape URL
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Scrape Error */}
                  {scrapeError && (
                    <div className="reports-validation-state reports-validation-state-error">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
                          <AlertCircle className="h-4 w-4" />
                        </span>
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-destructive">Scraping Failed</p>
                          <p className="text-sm leading-6 text-destructive/80">{scrapeError}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Scraped data indicator - Moved to after scrape button */}
                  {urlScrapedData && (
                    <div className="reports-success-state">
                      <p className="text-sm font-semibold text-success">
                        ✓ Scraped: <strong>{urlScrapedData.propertyAddress}</strong>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Review the fields below, add any overrides, then click "Generate Report"
                      </p>
                    </div>
                  )}

                  <Separator />

                  {/* Pre-Generation Overrides for URL mode */}
                  <PreGenerationOverrides
                    propertyAddress={urlScrapedData?.propertyAddress || propertyUrl}
                    onDataChange={handlePreGenDataChange}
                    disabled={isScraping}
                    buildType={preGenData.buildType}
                    onBuildTypeChange={(bt) => setPreGenData(prev => ({ ...prev, buildType: bt }))}
                    externalPurchasePrice={propertyPrice ? parseFloat(propertyPrice) : undefined}
                    externalLandPrice={landPrice ? parseFloat(landPrice) : undefined}
                    externalBuildPrice={buildPrice ? parseFloat(buildPrice) : undefined}
                    externalWeeklyRent={weeklyRent ? parseFloat(weeklyRent) : undefined}
                    externalCarSpaces={carSpaces ? parseInt(carSpaces) : undefined}
                    externalLandSize={landSize ? parseFloat(landSize) : undefined}
                    externalBuildSize={buildSize ? parseFloat(buildSize) : undefined}
                    externalCouncilRates={preGenData.councilRates}
                    externalWaterRates={preGenData.waterRates}
                    externalBodyCorporateFees={preGenData.bodyCorporateFees}
                    externalBuildingInsurance={preGenData.buildingLandlordInsurance}
                    externalPropertyManagementPercent={preGenData.propertyManagementFees}
                    externalConstructionYear={preGenData.constructionYear}
                    externalPropertyType={propertyType}
                    onPropertyTypeChange={setPropertyType}
                    beds={beds}
                    onBedsChange={setBeds}
                    baths={baths}
                    onBathsChange={setBaths}
                    onPurchasePriceChange={handlePropertyPriceChange}
                    onWeeklyRentChange={handleWeeklyRentChange}
                    onCarSpacesChange={handleCarSpacesChange}
                    onLandSizeChange={handleLandSizeChange}
                    onBuildSizeChange={handleBuildSizeChange}
                    onLandPriceChange={setLandPrice}
                    onBuildPriceChange={setBuildPrice}
                    hideBuildTypeSelector
                  />

                  {/* Info for URL mode */}
                  <div className="reports-supported-sites-panel space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div className="text-sm text-muted-foreground space-y-1">
                        <p><strong>Supported Sites:</strong></p>
                        <ul className="list-disc list-inside space-y-1 ml-2">
                          <li>Domain.com.au</li>
                          <li>Realestate.com.au</li>
                          <li>Allhomes.com.au</li>
                          <li>Most Australian property listing sites</li>
                        </ul>
                        <p className="mt-2">
                          The scraper will extract property details and automatically generate a comprehensive investment report. Override values above will be used if provided.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Token cost + balance status */}
                  <ReportGenerationStatus
                    kind="report.investment.compass"
                    estimate={estimateTokens('report.investment.compass', { aiNarrative: true, extraSections: 2 })}
                    className="mb-3"
                  />
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-xs text-muted-foreground">Projected token cost (URL ingest + AI narrative)</span>
                    <TokenCostEstimate
                      kind="report.investment.compass"
                      options={{ aiNarrative: true, extraSections: 2 }}
                    />
                  </div>

                  {/* Generate Button - At bottom after overrides */}
                  <Button
                    onClick={handleGenerateFromUrl}
                    disabled={isUrlGenerating || !urlScrapedData || !propertyPrice || parseFloat(propertyPrice) <= 0}
                    size="lg"
                    className="w-full shadow-lg shadow-primary/20"
                  >
                    {isUrlGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Generating Report...
                      </>
                    ) : (
                      <>
                        <TrendingUp className="h-4 w-4 mr-2" />
                        Generate Report
                      </>
                    )}
                  </Button>
                </TabsContent>
                )}

                {/* PDF Upload Tab - Only for property-specific queries */}
                {isPropertySpecific && (
                <TabsContent value="pdf" className="reports-investment-flow space-y-6 pt-4">
                  {/* Build Type Radio Selection */}
                  <div className="reports-build-type-control space-y-3">
                    <Label className="reports-investment-section-label text-base font-semibold">Build Type</Label>
                    <BuildTypeSelector
                      value={preGenData.buildType as BuildType}
                      onChange={(value) => setPreGenData(prev => ({ ...prev, buildType: value }))}
                      disabled={isParsing}
                      showCard={false}
                      size="sm"
                    />
                  </div>

                  <Separator />

                  {/* PDF Drop Zone */}
                  <div className="space-y-3">
                    <Label className="flex items-center gap-2">
                      <Upload className="h-4 w-4" />
                      Upload Property PDF
                    </Label>
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      className={`
                        reports-upload-zone
                        ${isDragging ? 'reports-upload-zone-active' : 'reports-upload-zone-idle'}
                        ${pdfFile ? 'reports-upload-zone-filled' : ''}
                      `}
                      onClick={() => document.getElementById('pdf-upload')?.click()}
                    >
                      {pdfFile ? (
                        <div className="space-y-2">
                          <FileText className="h-12 w-12 mx-auto text-primary" />
                          <p className="text-sm font-medium">{pdfFile.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(pdfFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPdfFile(null);
                            }}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <Upload className="h-12 w-12 mx-auto text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">
                            Drag and drop a PDF or image file here, or click to browse
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Supports property PDFs, brochures, and images (PNG, JPG)
                          </p>
                        </div>
                      )}
                    </div>
                    <input
                      id="pdf-upload"
                      type="file"
                      accept=".pdf,image/*"
                      className="hidden"
                      onChange={handleFileSelect}
                    />
                    {/* Conversion Progress */}
                    {conversionProgress && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-2">
                            <Image className="h-4 w-4" />
                            Rendering page {conversionProgress.current} of {conversionProgress.total}...
                          </span>
                          <span className="font-medium">{Math.round((conversionProgress.current / conversionProgress.total) * 100)}%</span>
                        </div>
                        <Progress value={(conversionProgress.current / conversionProgress.total) * 100} />
                      </div>
                    )}
                  </div>

                  {/* Parse Button - Moved to top right after file upload */}
                  <Button
                    onClick={handleParsePdfOnly}
                    disabled={isParsing || !pdfFile}
                    size="lg"
                    variant={pdfParsedData ? "outline" : "default"}
                    className="w-full shadow-lg shadow-primary/20"
                  >
                    {isParsing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Parsing...
                      </>
                    ) : pdfParsedData ? (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        Re-Parse PDF
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        Parse PDF
                      </>
                    )}
                  </Button>

                  {/* PDF Error */}
                  {pdfError && (
                    <div className="reports-validation-state reports-validation-state-error">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
                          <AlertCircle className="h-4 w-4" />
                        </span>
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-destructive">Processing Failed</p>
                          <p className="text-sm leading-6 text-destructive/80">{pdfError}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Parsed data indicator - Moved to after parse button */}
                  {pdfParsedData && (
                    <div className="reports-success-state">
                      <p className="text-sm font-semibold text-success">
                        ✓ Parsed: <strong>{pdfParsedData.propertyAddress}</strong>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Review the fields below, add any overrides, then click "Generate Report"
                      </p>
                    </div>
                  )}

                  <Separator />

                  {/* Pre-Generation Overrides for PDF mode */}
                  <PreGenerationOverrides
                    propertyAddress={pdfParsedData?.propertyAddress || pdfFile?.name || ''}
                    onDataChange={handlePreGenDataChange}
                    disabled={isParsing}
                    buildType={preGenData.buildType}
                    onBuildTypeChange={(bt) => setPreGenData(prev => ({ ...prev, buildType: bt }))}
                    externalPurchasePrice={propertyPrice ? parseFloat(propertyPrice) : undefined}
                    externalLandPrice={landPrice ? parseFloat(landPrice) : undefined}
                    externalBuildPrice={buildPrice ? parseFloat(buildPrice) : undefined}
                    externalWeeklyRent={weeklyRent ? parseFloat(weeklyRent) : undefined}
                    externalCarSpaces={carSpaces ? parseInt(carSpaces) : undefined}
                    externalLandSize={landSize ? parseFloat(landSize) : undefined}
                    externalBuildSize={buildSize ? parseFloat(buildSize) : undefined}
                    externalCouncilRates={preGenData.councilRates}
                    externalWaterRates={preGenData.waterRates}
                    externalBodyCorporateFees={preGenData.bodyCorporateFees}
                    externalBuildingInsurance={preGenData.buildingLandlordInsurance}
                    externalPropertyManagementPercent={preGenData.propertyManagementFees}
                    externalConstructionYear={preGenData.constructionYear}
                    externalPropertyType={propertyType}
                    onPropertyTypeChange={setPropertyType}
                    beds={beds}
                    onBedsChange={setBeds}
                    baths={baths}
                    onBathsChange={setBaths}
                    onPurchasePriceChange={handlePropertyPriceChange}
                    onWeeklyRentChange={handleWeeklyRentChange}
                    onCarSpacesChange={handleCarSpacesChange}
                    onLandSizeChange={handleLandSizeChange}
                    onBuildSizeChange={handleBuildSizeChange}
                    onLandPriceChange={setLandPrice}
                    onBuildPriceChange={setBuildPrice}
                    hideBuildTypeSelector
                  />

                  {/* Info for PDF mode */}
                  <div className="reports-supported-sites-panel space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div className="text-sm text-muted-foreground space-y-1">
                        <p><strong>Supported Documents:</strong></p>
                        <ul className="list-disc list-inside space-y-1 ml-2">
                          <li>Property listing brochures</li>
                          <li>House and land package documents</li>
                          <li>Building contracts with pricing</li>
                          <li>Property investment summaries</li>
                        </ul>
                        <p className="mt-2">
                          AI will extract property details (address, price, size, etc.) and generate a comprehensive investment report. Override values above will be used if provided.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Token cost + balance status */}
                  <ReportGenerationStatus
                    kind="report.investment.compass"
                    estimate={estimateTokens('report.investment.compass', { aiNarrative: true, extraSections: 2 })}
                    className="mb-3"
                  />
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-xs text-muted-foreground">Projected token cost (PDF parse + AI narrative)</span>
                    <TokenCostEstimate
                      kind="report.investment.compass"
                      options={{ aiNarrative: true, extraSections: 2 }}
                    />
                  </div>

                  {/* Generate Button - At bottom after overrides */}
                  <Button
                    onClick={handleGenerateFromPdf}
                    disabled={isPdfGenerating || !pdfParsedData || !propertyPrice || parseFloat(propertyPrice) <= 0}
                    size="lg"
                    className="w-full shadow-lg shadow-primary/20"
                  >
                    {isPdfGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Generating Report...
                      </>
                    ) : (
                      <>
                        <TrendingUp className="h-4 w-4 mr-2" />
                        Generate Report
                      </>
                    )}
                  </Button>
                </TabsContent>
                )}

              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Results Display */}
      {showResults && generatedReport && (
        <Card className="ci-card-premium">
          <CardHeader className="border-b border-border/60">
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Generated Investment Analysis
            </CardTitle>
            <CardDescription>
              Comprehensive investment report for {query} • {queryType}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="bg-background/60 border border-border/70 rounded-2xl p-6 max-h-96 overflow-y-auto shadow-inner">
              <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                {generatedReport}
              </pre>
            </div>
            <div className="flex gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(generatedReport);
                  toast({
                    title: "Copied to Clipboard",
                    description: "Report content has been copied.",
                  });
                }}
              >
                Copy Report
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = '/generated-reports';
                }}
              >
                View in Reports Page
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
