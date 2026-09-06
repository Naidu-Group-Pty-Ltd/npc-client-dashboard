import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0'
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';

import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { calculateStampDuty } from '../_shared/stampDuty/index.pure.ts';
import { coerceState, resolveSchedule } from '../_shared/stampDuty/scheduleStore.ts';
// Every figure this service publishes is computed by the pure engine, which
// is where the arithmetic is documented and pinned by tests. This file only
// orchestrates: auth, the stamp-duty schedule, the CPI cache, HTTP.
import {
  calculateAnnualCosts,
  calculateKeyMetrics,
  calculateMonthlyPayment,
  calculateSensitivityAnalysis,
  generateConvergenceProjections,
  generateProjections,
  getDefaultCpiProjections,
  getInterestRateByLVR,
  type CpiProjection,
  type LoanCalculationInput,
} from '../_shared/reports/investment/financialEngine.pure.ts';

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);

  console.log('Financial calculator service invoked with method:', req.method);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase configuration missing')
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // SECURITY: Verify authentication
    const body = await req.json();
    const input: LoanCalculationInput = body;

    const { error: authError, userId } = await verifyAuth(supabase, req.headers, body);
    if (authError) {
      console.log('[financial-calculator-service] Auth failed:', authError);
      return createUnauthorizedResponse(authError, corsHeaders);
    }
    console.log(`[financial-calculator-service] Authenticated user: ${userId}`);
    console.log('Calculating financial projections for:', input);

    const calculations = await calculateFinancialProjections(input, supabase);

    return new Response(JSON.stringify({
      success: true,
      data: calculations
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in financial calculator service:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to calculate financial projections';
    return new Response(JSON.stringify({
      error: errorMessage,
      success: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function calculateFinancialProjections(input: LoanCalculationInput, supabase: any) {
  const {
    propertyValue,
    deposit,
    loanTerm,
    weeklyRent,
    state,
    propertyType,
    isFirstHomeBuyer = false,
    isNewBuild = false,
    borrowerType = 'investor'
  } = input;

  // Calculate LVR
  const loanAmount = propertyValue - deposit;
  const lvr = (loanAmount / propertyValue) * 100;

  // Get interest rate - use provided rate or fetch LVR-based rate
  const rateInfo = getInterestRateByLVR(lvr, borrowerType, input.interestRate);
  const interestRate = rateInfo.rate;

  const monthlyInterestRate = interestRate / 100 / 12;
  const totalPayments = loanTerm * 12;

  // Monthly loan payment (Principal + Interest)
  const monthlyPayment = calculateMonthlyPayment(loanAmount, monthlyInterestRate, totalPayments);

  // Calculate stamp duty with FHB concessions
  const stampDutyResult = await calculateStampDutyWithConcessions(
    propertyValue,
    state,
    supabase,
    isFirstHomeBuyer,
    isNewBuild
  );

  // Calculate ongoing costs. Reviewed figures arrive as INPUT so the totals,
  // projections, sensitivity and metrics all describe them — see
  // overrides.pure.ts for why they must never be splatted over the output.
  const annualCosts = calculateAnnualCosts(propertyValue, weeklyRent, state, propertyType, input.annualCostOverrides);

  // Generate 10-year projections with scenarios
  // If a custom capital growth rate is provided (e.g., from Perplexity research), use it
  // Otherwise, use standard scenario-based rates
  const customCapitalGrowth = input.capitalGrowthRate ? input.capitalGrowthRate / 100 : null;
  const customRentGrowth = input.rentGrowthRate ? input.rentGrowthRate / 100 : null;

  // Fetch live CPI projections from cached economic data
  const cpiProjections = await fetchCpiProjections(supabase);
  const customCpiGrowth = input.cpiGrowthRate ? input.cpiGrowthRate / 100 : null;

  const scenarios = customCapitalGrowth !== null ? {
    // When custom rate provided, use it as the "moderate" scenario with ±2% for conservative/optimistic
    conservative: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, Math.max(0, customCapitalGrowth - 0.02), customRentGrowth || 0.025, customCpiGrowth, cpiProjections),
    moderate: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, customCapitalGrowth, customRentGrowth || 0.03, customCpiGrowth, cpiProjections),
    optimistic: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, customCapitalGrowth + 0.02, customRentGrowth || 0.035, customCpiGrowth, cpiProjections)
  } : {
    // Default scenario-based rates when no custom rate provided
    conservative: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, 0.02, 0.02, customCpiGrowth, cpiProjections),
    moderate: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, 0.04, 0.03, customCpiGrowth, cpiProjections),
    optimistic: generateProjections({ ...input, interestRate }, monthlyPayment, annualCosts, 0.06, 0.04, customCpiGrowth, cpiProjections)
  };

  // The upfront position is stated once: these exact lines appear in
  // initialCosts AND fund the cash-on-cash denominator, so the total a
  // report prints always foots against the lines printed above it. An
  // operator-supplied duty or conveyancing figure replaces the estimate in
  // those lines — the schedule assessment is still reported beside it.
  const stampDuty = input.stampDutyOverride ?? stampDutyResult.stampDuty;
  const legalFees = input.legalFeesOverride ?? 1500;
  const inspectionFees = 500;
  const totalUpfront = deposit + stampDuty + rateInfo.lmiEstimate + legalFees + inspectionFees;

  // Calculate key metrics
  const metrics = calculateKeyMetrics(
    { ...input, interestRate },
    monthlyPayment,
    annualCosts,
    totalUpfront
  );

  return {
    initialCosts: {
      propertyValue,
      deposit,
      loanAmount,
      stampDuty,
      stampDutyConcession: stampDutyResult.concession,
      stampDutyBeforeConcession: stampDutyResult.originalAmount,
      fhbEligible: stampDutyResult.fhbEligible,
      // Surfaced so a report can state which financial year's schedule it was
      // assessed against rather than presenting the figure as timeless.
      stampDutyScheduleYear: stampDutyResult.scheduleYear,
      stampDutyScheduleSource: stampDutyResult.scheduleSource,
      lmi: rateInfo.lmiEstimate,
      lmiRequired: rateInfo.lmiRequired,
      legalFees,
      inspectionFees,
      totalUpfront
    },
    loanDetails: {
      monthlyPayment,
      totalInterest: (monthlyPayment * totalPayments) - loanAmount,
      weeklyPayment: monthlyPayment * 12 / 52,
      lvr: Math.round(lvr * 100) / 100,
      lvrTier: rateInfo.lvrTier,
      interestRate: rateInfo.rate,
      rateSource: rateInfo.source,
      borrowerType
    },
    // Persist the exact rental input used by every projection. Downstream cash-flow
    // cards and exports read this canonical path, including reports without manual
    // overrides, so the displayed figure cannot drift from the generated series.
    income: {
      weeklyRent,
      annualRent: weeklyRent * 52,
    },
    annualCosts,
    keyMetrics: metrics,
    projections: scenarios,
    sensitivityAnalysis: calculateSensitivityAnalysis({ ...input, interestRate }, monthlyPayment, annualCosts),
    interestRateInfo: rateInfo
  };
}

// ============================================
// STAMP DUTY WITH FIRST HOME BUYER CONCESSIONS
// ============================================

interface StampDutyResult {
  stampDuty: number;
  originalAmount: number;
  concession: number;
  fhbEligible: boolean;
  concessionType: string;
  /** Financial year of the schedule used, so a report can cite its basis. */
  scheduleYear: string;
  /** Whether the figures came from the cache or the schedule shipped in code. */
  scheduleSource: 'cache' | 'built-in';
}

/**
 * Stamp duty for the projection.
 *
 * This used to be ~480 lines: eight bracket functions, eight first-home-buyer
 * concession functions, and a cache reader — a third independent copy of the
 * rates alongside `src/utils/` and the `_shared/` "mirror". All three disagreed
 * with each other and none matched the revenue offices. It now delegates to the
 * one engine, with the cache consulted through `resolveSchedule` so an
 * administrator can publish a correction without a deploy.
 */
async function calculateStampDutyWithConcessions(
  propertyValue: number,
  state: string,
  supabase: any,
  isFirstHomeBuyer: boolean,
  isNewBuild: boolean,
): Promise<StampDutyResult> {
  const jurisdiction = coerceState(state);
  const { schedule, source, rejectedReason } = await resolveSchedule(jurisdiction, supabase);
  if (rejectedReason) {
    console.warn(`[financial-calculator-service] ${jurisdiction} using built-in schedule: ${rejectedReason}`);
  }

  const category = isNewBuild ? 'new' : 'established';

  // Duty before relief, so the response can still report what the concession
  // was worth. The engine is asked twice rather than reverse-engineering the
  // gross figure from the net one.
  const gross = calculateStampDuty({
    propertyValue,
    state: jurisdiction,
    intent: 'owner_occupier',
    category,
    schedule,
  });

  const assessed = calculateStampDuty({
    propertyValue,
    state: jurisdiction,
    intent: 'owner_occupier',
    category,
    isFirstHomeBuyer,
    schedule,
  });

  const concession = Math.max(0, gross.totalDuty - assessed.totalDuty);

  return {
    stampDuty: assessed.totalDuty,
    originalAmount: gross.totalDuty,
    concession,
    fhbEligible: isFirstHomeBuyer && concession > 0,
    concessionType: isFirstHomeBuyer
      ? (concession > 0 ? assessed.notes.join('; ') : `No first home concession applies in ${jurisdiction} at this value`)
      : 'none',
    scheduleYear: assessed.scheduleYear,
    scheduleSource: source,
  };
}

/**
 * Fetch CPI projections from the economic_data_cache table.
 * Returns year-by-year CPI forecasts for 10-year projection models.
 */
async function fetchCpiProjections(supabase: any): Promise<CpiProjection[]> {
  try {
    const { data: cachedData, error } = await supabase
      .from('economic_data_cache')
      .select('data')
      .eq('data_type', 'rba_indicators')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !cachedData?.data) {
      console.log('[financial-calculator] No cached CPI projections, using defaults');
      return getDefaultCpiProjections();
    }

    const cpiProjections = cachedData.data?.cpiProjections;
    if (Array.isArray(cpiProjections) && cpiProjections.length > 0) {
      console.log(`[financial-calculator] Using ${cpiProjections.length} cached CPI projections`);
      return cpiProjections;
    }

    // Fall back to deriving from current CPI
    const currentCpi = cachedData.data?.inflation?.annual || 2.5;
    return generateConvergenceProjections(currentCpi);
  } catch (err) {
    console.error('[financial-calculator] Error fetching CPI projections:', err);
    return getDefaultCpiProjections();
  }
}
