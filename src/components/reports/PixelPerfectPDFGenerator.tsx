import React, { forwardRef, useImperativeHandle } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { FlattenPdfIconButton } from '@/components/common/FlattenPdfIconButton';
import { toast } from 'sonner';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { logActivityDirect } from '@/hooks/useActivityLogger';
import { secureStorageUpload } from '@/hooks/useSecureStorage';
import { fetchGlobalReportSettings, type GlobalReportSettings } from '@/hooks/useGlobalReportSettings';
import { drawPdfLibDisclaimerPage } from '@/utils/pdfDisclaimerPage';
import { downloadClientPdf } from '@/lib/reports/clientPdfDownload';

type ReportTier = 'compass' | 'briefing' | 'snapshot' | 'financial';

interface InvestmentReportData {
  id: string;
  address: string;
  content: string;
  created_at: string;
  enhanced_data?: {
    domainData?: any;
    absData?: any;
    rbaData?: any;
    financialData?: any;
    locationData?: any;
    investmentScore?: any;
  };
  pdf_url?: string | null;
}

interface PixelPerfectPDFGeneratorProps {
  report: InvestmentReportData;
  includeSources?: boolean;
  includeScoring?: boolean;
  reportTier?: ReportTier;
  pdf_url?: string | null;
  skipDatabaseUpdate?: boolean;
  /**
   * How the control presents. The unified template-first delivery is every
   * surface's primary road now, so this generator is offered as the named
   * legacy layout beside it — same document, quieter chrome. The ref handle
   * is unaffected either way; the send fallback still reaches it.
   */
  appearance?: 'primary' | 'legacy';
}

export interface PixelPerfectPDFGeneratorHandle {
  generateAndUpload: () => Promise<string | null>;
  /** The button's own download action, for callers that trigger it programmatically. */
  download: () => Promise<void>;
}

export const PixelPerfectPDFGenerator = forwardRef<PixelPerfectPDFGeneratorHandle, PixelPerfectPDFGeneratorProps>(({ report, includeSources = true, includeScoring = true, reportTier = 'compass', skipDatabaseUpdate = false, appearance = 'primary' }, ref) => {
  const [isGenerating, setIsGenerating] = React.useState(false);

  const extractSuburbState = (address: string | undefined | null): { suburb: string; state: string } => {
    // Handle undefined/null address gracefully
    if (!address || typeof address !== 'string' || address.trim() === '') {
      console.warn('extractSuburbState: Address is undefined, not a string, or empty, using fallback');
      return { suburb: 'PROPERTY', state: '' };
    }
    
    // Safe split with null-check on each element
    const parts = address.split(',').map(p => (p ?? '').trim()).filter(p => p.length > 0);
    
    // If no valid parts after filtering, return fallback
    if (parts.length === 0) {
      console.warn('extractSuburbState: No valid address parts found, using fallback');
      return { suburb: 'PROPERTY', state: '' };
    }
    
    // Map full state names to abbreviations
    const stateMapping: Record<string, string> = {
      'new south wales': 'NSW',
      'victoria': 'VIC',
      'queensland': 'QLD',
      'south australia': 'SA',
      'western australia': 'WA',
      'tasmania': 'TAS',
      'northern territory': 'NT',
      'australian capital territory': 'ACT',
    };
    
    // Search entire address for state (abbreviation first, then full name)
    let state = '';
    const addressLower = address.toLowerCase();
    
    // Try to find state abbreviation anywhere in address
    const stateAbbrevMatch = address.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i);
    if (stateAbbrevMatch) {
      state = stateAbbrevMatch[0].toUpperCase();
    } else {
      // Try full state names
      for (const [fullName, abbrev] of Object.entries(stateMapping)) {
        if (addressLower.includes(fullName)) {
          state = abbrev;
          break;
        }
      }
    }
    
    // Extract suburb - find the first meaningful part that's not a postcode, state, or "Australia"
    let suburb = '';
    for (const part of parts) {
      // part is guaranteed to be a non-empty string due to filter above
      const trimmedPart = part;
      const partLower = trimmedPart.toLowerCase();
      
      // Skip if it's "Australia", a postcode (4 digits), or contains the state
      const isAustralia = partLower === 'australia';
      const isPostcode = /^\d{4}$/.test(trimmedPart);
      const isState = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i.test(trimmedPart) || 
                      Object.keys(stateMapping).some(s => partLower === s);
      const containsPostcode = /\b\d{4}\b/.test(trimmedPart);
      
      // For suburb reports, the first part is usually the suburb name
      if (!isAustralia && !isPostcode && !isState) {
        // If this part contains a postcode but also text, extract just the suburb name
        if (containsPostcode) {
          const suburbOnly = trimmedPart.replace(/\b\d{4}\b/, '').replace(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/gi, '').trim();
          if (suburbOnly) {
            suburb = suburbOnly;
            break;
          }
        } else {
          suburb = trimmedPart;
          break;
        }
      }
    }
    
    // Fallback: use first part if nothing else worked
    if (!suburb && parts.length > 0) {
      const firstPart = parts[0] || '';
      suburb = firstPart.replace(/\b\d{4}\b/, '').replace(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/gi, '').trim();
    }
    
    // Final fallback if suburb is still empty
    if (!suburb) {
      suburb = 'PROPERTY';
    }
    
    return { suburb: suburb.toUpperCase(), state };
  };

  // Helper to strip word count markers from content - these are AI instruction artifacts
  const stripWordCountMarkers = (text: string): string => {
    return text
      // Remove patterns like "(Word count: 812)", "(word count: 500)"
      .replace(/\(\s*Word\s*count\s*:\s*\d+[\d,]*\s*\)/gi, '')
      // Remove patterns like "(500 words)", "(500-1000 words)", "(min 500 words)", "(450+ words total)"
      .replace(/\(\s*(?:minimum|min|max|maximum)?\s*\d+\s*(?:\+|-|\s*-\s*\d+)?\s*words?\s*(?:total|required|minimum|min|max|maximum)?\s*\)/gi, '')
      // Remove patterns like "(Minimum 400 words for this section)" or any parenthesized phrase containing "words"
      .replace(/\(\s*[^)]*\d+\s*words?\s*[^)]*\)/gi, '')
      // Remove standalone "**Top 3 Risks (450+ words total):**" style markers - strip just the word count part
      .replace(/\(\s*\d+\+?\s*words?\s*(?:total)?\s*\)\s*:?/gi, '')
      // Remove patterns like "(312 words)[1][2]" - word count before reference markers
      .replace(/\(\s*\d+\s*words?\s*\)\s*(?:\[\d+\])+/gi, '')
      // Clean up any double spaces left behind
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  // Helper to sanitize AI-generated content - fix word merges, duplicates, and malformed text
  const sanitizeAIContent = (text: string): string => {
    return text
      // ===== ISSUE 8 FIX: Comprehensive word merge corrections =====
      // Fix camelCase splits: "WyndhamVale" -> "Wyndham Vale", "FreewayUpgrades" -> "Freeway Upgrades"
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Fix letter-number merges: "Year1" -> "Year 1", "Section2" -> "Section 2"
      .replace(/([a-z])(\d)/g, '$1 $2')
      // Fix number-letter merges (but preserve units like "100km"): "2024The" -> "2024 The"
      .replace(/(\d)([A-Z])/g, '$1 $2')
      // Fix punctuation-capital merges: "done.The" -> "done. The", "finished:Next" -> "finished: Next"
      .replace(/([.!?:,;])([A-Za-z])/g, '$1 $2')
      // Fix possessive merges: "Vale'sdemographic" -> "Vale's demographic", "City'sinfrastructure" -> "City's infrastructure"
      .replace(/([a-z])'s([a-z])/gi, "$1's $2")
      // Fix closing paren merges: ")The" -> ") The", ")and" -> ") and"
      .replace(/(\))([A-Za-z])/g, '$1 $2')
      // Fix opening paren merges after words: "word(example" -> "word (example"
      .replace(/([a-z])(\([A-Za-z])/g, '$1 $2')
      // Fix hyphen merges for compound words that got mashed: "Western-Freewayupgrades" or "Westernfreeway" patterns
      .replace(/([a-z]{3,})(freeway|highway|road|street|avenue|drive|boulevard|upgrades?|improvements?|developments?)/gi, '$1 $2')
      // Fix common infrastructure word merges
      .replace(/(infrastructure|developments?|projects?|investments?)([A-Z])/g, '$1 $2')
      // ===== ISSUE 3 FIX: Remove broken/repeated phrases with data =====
      // Remove duplicate "Purchase Price: $X" patterns: "Purchase Price: $717,400 median" or "Purchase Price: $X, Purchase Price: $Y"
      .replace(/Purchase Price:\s*\$[\d,]+\s*(?:Purchase Price:\s*\$[\d,]+|median)/gi, (match) => {
        const priceMatch = match.match(/\$[\d,]+/);
        return priceMatch ? `Purchase Price: ${priceMatch[0]}` : match;
      })
      // Remove duplicate percentage/ratio patterns like "LVR:90%:90%" or "80% LVR:90%"
      .replace(/(\d+%?\s*(?:LVR|lvr))\s*:\s*\d+%?\s*(?:LVR|lvr)?\s*:\s*\d+%/gi, '$1')
      .replace(/(\d+%\s+LVR)\s*:\s*\d+%\s*LVR/gi, '$1')
      // Remove repeated field patterns like "Interest Rate: 6% Interest Rate: 6%"
      .replace(/(Interest Rate:\s*[\d.]+%)\s+Interest Rate:\s*[\d.]+%/gi, '$1')
      .replace(/(Loan Term:\s*\d+\s*years?)\s+Loan Term:\s*\d+\s*years?/gi, '$1')
      .replace(/(Weekly Rent:\s*\$[\d,]+)\s+Weekly Rent:\s*\$[\d,]+/gi, '$1')
      // Remove "At $X, the [Field]: $X" redundancy: "At $717,400, the Purchase Price: $717,400"
      .replace(/At\s+\$[\d,]+,?\s*the\s+(Purchase Price|Property Value|Loan Amount):\s*\$[\d,]+/gi, (match) => {
        const priceMatch = match.match(/\$[\d,]+/);
        const fieldMatch = match.match(/(Purchase Price|Property Value|Loan Amount)/i);
        return priceMatch && fieldMatch ? `${fieldMatch[0]}: ${priceMatch[0]}` : match;
      })
      // Clean up any resulting double spaces
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  // Helper to truncate text at word boundary for TOC entries
  const truncateAtWordBoundary = (text: string, maxWidth: number, font: any, fontSize: number): string => {
    if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) {
      return text;
    }
    
    const words = text.split(' ');
    let result = '';
    const ellipsis = '...';
    const ellipsisWidth = font.widthOfTextAtSize(ellipsis, fontSize);
    
    for (let i = 0; i < words.length; i++) {
      const testText = result ? `${result} ${words[i]}` : words[i];
      const testWidth = font.widthOfTextAtSize(testText + ellipsis, fontSize);
      
      if (testWidth > maxWidth) {
        break;
      }
      result = testText;
    }
    
    return result ? `${result}${ellipsis}` : `${text.substring(0, 20)}${ellipsis}`;
  };

  // Helper to break long words that exceed maxWidth
  const breakLongWord = (word: string, maxWidth: number, font: any, fontSize: number): string[] => {
    const wordWidth = font.widthOfTextAtSize(word, fontSize);
    if (wordWidth <= maxWidth) {
      return [word];
    }
    
    // Break the word into chunks that fit
    const chunks: string[] = [];
    let currentChunk = '';
    
    for (const char of word) {
      const testChunk = currentChunk + char;
      const testWidth = font.widthOfTextAtSize(testChunk + '-', fontSize);
      
      if (testWidth > maxWidth && currentChunk.length > 0) {
        chunks.push(currentChunk + '-');
        currentChunk = char;
      } else {
        currentChunk = testChunk;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  };

  const filterSourcesSections = (sections: Record<string, string>): Record<string, string> => {
    if (includeSources) {
      console.log('✓ Including sources in PDF (toggle is ON)');
      return sections;
    }
    
    console.log('🚫 Filtering out sources sections from PDF (toggle is OFF)');
    console.log('📋 Available sections before filtering:', Object.keys(sections));
    
    // Create a new object without source-related and methodology sections
    // These sections have been removed from the report structure per user request
    const filteredSections: Record<string, string> = {};
    const sourceSectionPatterns = [
      /market data sources?/i,
      /data sources?/i,
      /data availability/i,
      /data.*sourcing/i,
      /methodology\s*notes?/i,
      /data\s*transparency/i,
      /data\s*limitations?/i,
      /limitations?\s*(&|and)?\s*transparency/i,
      /demographic.*economic data/i,
      /economic data sources?/i,
      /sources?$/i
    ];
    
    let removedCount = 0;
    for (const [key, value] of Object.entries(sections)) {
      const isSourceSection = sourceSectionPatterns.some(pattern => pattern.test(key));
      if (isSourceSection) {
        console.log(`  ❌ Removing section: "${key}"`);
        removedCount++;
      } else {
        filteredSections[key] = value;
      }
    }
    
    console.log(`✓ Filtered out ${removedCount} source section(s)`);
    console.log('📋 Remaining sections:', Object.keys(filteredSections));
    return filteredSections;
  };

  const filterScoringSections = (sections: Record<string, string>): Record<string, string> => {
    if (includeScoring) {
      console.log('✓ Including scoring breakdown in PDF (toggle is ON)');
      return sections;
    }
    
    console.log('🚫 Filtering out scoring sections from PDF (toggle is OFF)');
    console.log('📋 Available sections before filtering:', Object.keys(sections));
    
    // Create a new object without scoring-related sections
    const filteredSections: Record<string, string> = {};
    const scoringSectionPatterns = [
      /investment scor/i,
      /score breakdown/i,
      /scoring breakdown/i,
      /investment grade/i,
      /investment rating/i,
      /overall score/i,
      /property score/i
    ];
    
    let removedCount = 0;
    for (const [key, value] of Object.entries(sections)) {
      const isScoringSection = scoringSectionPatterns.some(pattern => pattern.test(key));
      if (isScoringSection) {
        console.log(`  ❌ Removing scoring section: "${key}"`);
        removedCount++;
      } else {
        filteredSections[key] = value;
      }
    }
    
    console.log(`✓ Filtered out ${removedCount} scoring section(s)`);
    console.log('📋 Remaining sections:', Object.keys(filteredSections));
    return filteredSections;
  };

  const injectOverridesIntoContent = (content: string, financialData: any): string => {
    if (!financialData) {
      console.log('⚠️ No financialData provided, skipping injection');
      return content;
    }

    console.log('💉 Injecting override values into markdown content');
    console.log('📊 Input financialData structure:', JSON.stringify(financialData, null, 2).substring(0, 2000));
    console.log('🔍 Direct value checks:', {
      'financialData.income': financialData?.income,
      'financialData.income.weeklyRent': financialData?.income?.weeklyRent,
      'financialData.income.annualRent': financialData?.income?.annualRent,
    });

    // Calculate annual rent from weekly rent (weekly × 52)
    // Use ?? 0 to handle null/undefined but preserve explicit 0 values
    const weeklyRentRaw = financialData?.income?.weeklyRent;
    const weeklyRent = Number(weeklyRentRaw) || 0;
    console.log('📌 weeklyRent:', { raw: weeklyRentRaw, resolved: weeklyRent });
    const annualRent = weeklyRent * 52;
    console.log('📌 annualRent calculated:', annualRent);

    // Recalculate property management based on overridden values
    const propertyManagementPercent = Number(financialData?.annualCosts?.propertyManagementPercent) || 7;
    const propertyManagementFee = Math.floor(annualRent * (propertyManagementPercent / 100));
    console.log('📌 propertyManagement:', { percent: propertyManagementPercent, calculatedFee: propertyManagementFee });

    // Calculate total annual costs dynamically from overridden values (excluding letting fees)
    // IMPORTANT: Use ?? (nullish coalescing) not || to properly handle 0 values as valid overrides
    const councilRates = financialData?.annualCosts?.councilRates ?? 0;
    const waterRates = financialData?.annualCosts?.waterRates ?? 0;
    const strataFees = financialData?.annualCosts?.strataFees ?? 0;
    const landlordInsurance = financialData?.annualCosts?.landlordInsurance ?? 0;
    const propertyManagement = propertyManagementFee; // Use dynamically calculated value
    // CRITICAL FIX: Use ?? 0 to respect explicit $0 override, don't default to 1500
    // The 1500 default was causing conflicts with user-specified $0 maintenance
    const maintenance = financialData?.annualCosts?.maintenance ?? 0;
    const landTax = financialData?.annualCosts?.landTax ?? 0;
    
    // Total annual costs WITHOUT land tax - used for net yield calculation (pages 14-15)
    const totalAnnualCostsExcludingLandTax = councilRates + waterRates + strataFees + landlordInsurance + propertyManagement + maintenance;
    
    // Total annual costs WITH land tax - used for page 10 ongoing costs table display
    const totalAnnualCostsWithLandTax = totalAnnualCostsExcludingLandTax + landTax;
    
    console.log('📊 Computed values from overrides:', {
      weeklyRent,
      annualRent,
      councilRates,
      waterRates,
      strataFees,
      landlordInsurance,
      propertyManagementPercent,
      propertyManagement,
      maintenance,
      landTax,
      totalAnnualCostsExcludingLandTax,
      totalAnnualCostsWithLandTax
    });
    
    // Debug: Log the raw maintenance value from financialData
    console.log('🔧 Maintenance debug:', {
      rawValue: financialData?.annualCosts?.maintenance,
      resolvedValue: maintenance
    });
    
    // Debug: Log specific content snippets we're trying to match
    const annualIncomeMatch = content.match(/Annual Income[^\n]{0,100}/gi);
    const annualExpensesMatch = content.match(/Annual Expenses[^\n]{0,100}/gi);
    const propertyMgmtMatch = content.match(/Property Management[^\n]{0,100}/gi);
    console.log('🔍 Content snippets found:', {
      annualIncome: annualIncomeMatch,
      annualExpenses: annualExpensesMatch,
      propertyMgmt: propertyMgmtMatch
    });

    // Calculate loan amount from property value and deposit
    const propertyValue = financialData?.initialCosts?.propertyValue || 0;
    const stampDuty = financialData?.initialCosts?.stampDuty || 0;
    const interestRate = financialData?.loanDetails?.interestRate || 6;
    const loanTerm = financialData?.loanDetails?.loanTerm || 30;
    
    // Calculate deposit: use explicit value if set, otherwise derive from LVR
    // Formula: Deposit = Purchase Price × (100% - LVR%)
    const lvr = financialData?.keyMetrics?.lvr || financialData?.loanDetails?.lvr || 80;
    const explicitDeposit = financialData?.initialCosts?.deposit;
    const depositValue = (explicitDeposit !== undefined && explicitDeposit !== null && explicitDeposit !== 0)
      ? Number(explicitDeposit)
      : Math.round(propertyValue * (1 - lvr / 100));
    const loanAmount = propertyValue - depositValue;
    
    console.log('💰 Deposit calculation:', {
      propertyValue,
      lvr,
      explicitDeposit,
      calculatedDeposit: depositValue,
      loanAmount
    });

    // Map of field paths to regex patterns that match them in markdown tables
    const fieldReplacements: Array<{ pattern: RegExp; getValue: () => any; format: (v: any) => string; isFullLineReplacement?: boolean }> = [
      // === BASE ASSUMPTIONS SECTION - Bullet point format ===
      // Property Price: $XXX,XXX
      {
        pattern: /[-•]\s*Property Price:[^\n]*/gi,
        getValue: () => propertyValue,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '- Property Price: $' + str;
        },
        isFullLineReplacement: true
      },
      // Deposit: $XXX,XXX
      {
        pattern: /[-•]\s*Deposit:[^\n]*/gi,
        getValue: () => depositValue,
        format: (v) => {
          const str = Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
          return '- Deposit: $' + str;
        },
        isFullLineReplacement: true
      },
      // Loan Amount: $XXX,XXX
      {
        pattern: /[-•]\s*Loan Amount:[^\n]*/gi,
        getValue: () => loanAmount,
        format: (v) => {
          const str = Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
          return '- Loan Amount: $' + str;
        },
        isFullLineReplacement: true
      },
      // Interest Rate: X%
      {
        pattern: /[-•]\s*Interest Rate:[^\n]*/gi,
        getValue: () => interestRate,
        format: (v) => '- Interest Rate: ' + (v || 0) + '%',
        isFullLineReplacement: true
      },
      // Loan Term: XX years
      {
        pattern: /[-•]\s*Loan Term:[^\n]*/gi,
        getValue: () => loanTerm,
        format: (v) => '- Loan Term: ' + (v || 30) + ' years',
        isFullLineReplacement: true
      },
      // Weekly Rent: $XXX ($XX,XXX annually)
      {
        pattern: /[-•]\s*Weekly Rent:[^\n]*/gi,
        getValue: () => ({ weeklyRent, annualRent }),
        format: (v) => {
          // Explicit type conversion and validation
          const weeklyNum = typeof v.weeklyRent === 'number' ? v.weeklyRent : Number(v.weeklyRent) || 0;
          const annualNum = typeof v.annualRent === 'number' ? v.annualRent : Number(v.annualRent) || 0;
          
          // Format with explicit locale
          const weeklyFormatted = weeklyNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          const annualFormatted = annualNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          
          // Build the result string
          const result = '- Weekly Rent: $' + weeklyFormatted + ' ($' + annualFormatted + ' annually)';
          
          console.log('📝 WEEKLY RENT INJECTION:', {
            inputWeekly: v.weeklyRent,
            inputAnnual: v.annualRent,
            weeklyNum,
            annualNum,
            weeklyFormatted,
            annualFormatted,
            finalResult: result
          });
          
          return result;
        },
        isFullLineReplacement: true
      },
      // Property Management: X% of $XX,XXX annual rent = $X,XXX
      {
        pattern: /[-•]\s*Property Management:[^\n]*/gi,
        getValue: () => ({ percent: propertyManagementPercent, annualRent, fee: propertyManagement }),
        format: (v) => {
          const percentNum = typeof v.percent === 'number' ? v.percent : Number(v.percent) || 7;
          const annualNum = typeof v.annualRent === 'number' ? v.annualRent : Number(v.annualRent) || 0;
          const feeNum = typeof v.fee === 'number' ? v.fee : Number(v.fee) || 0;
          
          const annualFormatted = annualNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          const feeFormatted = feeNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          
          // IMPORTANT: Use "= $feeFormatted" NOT "Annual Rent: $annualFormatted"
          const result = '- Property Management: ' + percentNum + '% of $' + annualFormatted + ' annual rent = $' + feeFormatted;
          
          console.log('📝 PROPERTY MANAGEMENT INJECTION:', {
            inputPercent: v.percent,
            inputAnnual: v.annualRent,
            inputFee: v.fee,
            percentNum,
            annualNum,
            feeNum,
            annualFormatted,
            feeFormatted,
            finalResult: result
          });
          
          return result;
        },
        isFullLineReplacement: true
      },
      // Maintenance: $X annually (fixed)
      {
        pattern: /[-•]\s*Maintenance:[^\n]*/gi,
        getValue: () => maintenance,
        format: (v) => {
          const maintenanceNum = Number(v) || 0;
          const formatted = maintenanceNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          console.log('📝 Maintenance format:', { rawValue: v, maintenanceNum, formatted });
          // Use array join
          const parts = ['- Maintenance: ', '$', formatted, ' annually (fixed)'];
          return parts.join('');
        },
        isFullLineReplacement: true
      },
      // Council Rates: $X,XXX annually
      {
        pattern: /[-•]\s*Council Rates:[^\n]*/gi,
        getValue: () => councilRates,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '- Council Rates: $' + str + ' annually';
        },
        isFullLineReplacement: true
      },
      // Water Rates: $X,XXX annually
      {
        pattern: /[-•]\s*Water Rates:[^\n]*/gi,
        getValue: () => waterRates,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '- Water Rates: $' + str + ' annually';
        },
        isFullLineReplacement: true
      },
      // Insurance: $X,XXX annually
      {
        pattern: /[-•]\s*Insurance:[^\n]*/gi,
        getValue: () => landlordInsurance,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '- Insurance: $' + str + ' annually';
        },
        isFullLineReplacement: true
      },

      // === OTHER SECTIONS - Non-bullet patterns ===
      {
        pattern: /Purchase Price.*?\$[\d,]+/gi,
        getValue: () => propertyValue,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return 'Purchase Price: $' + str;
        }
      },
      {
        pattern: /Property Value.*?\$[\d,]+/gi,
        getValue: () => propertyValue,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return 'Property Value: $' + str;
        }
      },
      {
        pattern: /Stamp Duty.*?\$[\d,]+/gi,
        getValue: () => financialData?.initialCosts?.stampDuty,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return 'Stamp Duty: $' + str;
        }
      },
      {
        pattern: /Deposit(?:.*?20%)?[:\s-]+\$[\d,]+/gi,
        getValue: () => depositValue,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return 'Deposit: $' + str;
        }
      },
      // Non-bullet Weekly Rent patterns - only for contexts NOT starting with bullets
      // IMPORTANT: These should NOT match after the bullet patterns have already run
      {
        pattern: /^\s*Weekly Rent:\s*\$[\d,]+\s*\(\$[\d,]+\s*annually\)/gim,
        getValue: () => ({ weeklyRent, annualRent }),
        format: (v) => {
          const weeklyNum = Number(v.weeklyRent) || 0;
          const annualNum = Number(v.annualRent) || 0;
          const weeklyFormatted = weeklyNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          const annualFormatted = annualNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          return 'Weekly Rent: $' + weeklyFormatted + ' ($' + annualFormatted + ' annually)';
        },
        isFullLineReplacement: true
      },
      // Table format Weekly Rent
      {
        pattern: /\|\s*Weekly Rent\s*\|[^\|]*\|\s*\$[\d,]+\s*\|/gi,
        getValue: () => weeklyRent,
        format: (v) => {
          const weeklyNum = Number(v) || 0;
          const weeklyFormatted = weeklyNum.toLocaleString('en-AU', { maximumFractionDigits: 0 });
          return '| Weekly Rent | | $' + weeklyFormatted + ' |';
        },
        isFullLineReplacement: true
      },
      // Standalone Annual Rent patterns - ONLY match bullet-point format in Base Assumptions
      // Must require bullet point prefix to avoid matching "Annual" in table cells
      {
        pattern: /^[•\-]\s*Annual Rent:\s*\$[\d,]+/gim,
        getValue: () => annualRent,
        format: (v) => {
          const str = Number(v || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
          return '• Annual Rent: $' + str;
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Annual Rent\s*\|[^\|]*\|\s*\$[\d,]+\s*\|/gi,
        getValue: () => annualRent,
        format: (v) => {
          const str = Number(v || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
          return '| Annual Rent | | $' + str + ' |';
        },
        isFullLineReplacement: true
      },
      // Annual Income row in Gross & Net Yield table
      {
        pattern: /\|\s*Annual Income\s*\|\s*\$[\d,]+\s*[×x]\s*52\s*weeks?\s*\|\s*\$[\d,]+\s*\|/gi,
        getValue: () => ({ weeklyRent, annualRent }),
        format: (v) => {
          const weeklyStr = String(v.weeklyRent || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          const annualStr = String(v.annualRent || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Annual Income | $' + weeklyStr + ' x 52 weeks | $' + annualStr + ' |';
        },
        isFullLineReplacement: true
      },
      // Table format patterns for ongoing costs - COLUMN ORDER: Cost Category | Amount (AUD) | Calculation Method
      // Each row has a meaningful, contextual description in Calculation Method
      
      // Fix malformed Stamp Duty row where amount is merged into category name
      {
        pattern: /\|\s*Stamp Duty:\s*\$[\d,]+\.?\d*\s*\|[^\n]*/gi,
        getValue: () => stampDuty,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Stamp Duty | $' + str + ' | State Revenue Office calculator (2025) |';
        },
        isFullLineReplacement: true
      },
      // Fix malformed Purchase Price row where value is merged into attribute name
      {
        pattern: /\|\s*(?:Estimated\s+)?Purchase Price:\s*\$[\d,]+\.?\d*\s*\|[^\n]*/gi,
        getValue: () => propertyValue,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Estimated Purchase Price | $' + str + ' |';
        },
        isFullLineReplacement: true
      },
      // Fix Net Rental Yield showing formula instead of percentage
      {
        pattern: /\|\s*Net Rental Yield\s*\|\s*\$[\d,]+\.?\d*\s*[÷\/]\s*\$[\d,]+\.?\d*\s*[×x\*]\s*\d+[^\n]*/gi,
        getValue: () => financialData?.keyMetrics?.netRentalYield,
        format: (v) => {
          const yieldVal = parseFloat(v) || 0;
          return '| Net Rental Yield | ' + yieldVal.toFixed(2) + '% |';
        },
        isFullLineReplacement: true
      },
      // Fix malformed Property Type row
      {
        pattern: /\|\s*Property Type:\s*[^\|]+\|[^\n]*/gi,
        getValue: () => 'Residential Property',
        format: (v) => '| Property Type | ' + v + ' |',
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Council Rates\s*\|\s*\$[^\n]*/gi,
        getValue: () => councilRates,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Council Rates | $' + str + ' | Local council rates notice (2024/25) |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Water Rates\s*\|\s*\$[^\n]*/gi,
        getValue: () => waterRates,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Water Rates | $' + str + ' | Estimated based on local water authority |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*(?:Building\s*(?:&|and)\s*)?(?:Landlord\s*)?Insurance\s*\|\s*\$[^\n]*/gi,
        getValue: () => landlordInsurance,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Insurance | $' + str + ' | Industry average for investment property |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Strata Fees\s*\|\s*\$[^\n]*/gi,
        getValue: () => strataFees,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Strata Fees | $' + str + ' | Body corporate/strata levy |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Body Corporate\s*\|\s*\$[^\n]*/gi,
        getValue: () => strataFees,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Body Corporate | $' + str + ' | Body corporate/strata levy |';
        },
        isFullLineReplacement: true
      },
      // Property Management Fee table row - Amount column = fee, Calculation Method = formula
      {
        pattern: /\|?\s*Property Management Fee?\s*\|\s*\$[^\n]*/gi,
        getValue: () => ({ percent: propertyManagementPercent, annualRent, fee: propertyManagement }),
        format: (v) => {
          const annualStr = String(v.annualRent || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          const feeStr = String(v.fee || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Property Management Fee | $' + feeStr + ' | ' + (v.percent || 7) + '% x $' + annualStr + ' annual rent |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*Maintenance\s*\|\s*\$[^\n]*/gi,
        getValue: () => maintenance,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Maintenance | $' + str + ' | Fixed amount per instructions |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /Interest Rate.*?[\d.]+%/gi,
        getValue: () => interestRate,
        format: (v) => 'Interest Rate: ' + (v || 0) + '%'
      },
      {
        pattern: /Capital Growth.*?[\d.]+%/gi,
        getValue: () => financialData?.assumptions?.capitalGrowth,
        format: (v) => 'Capital Growth: ' + (v || 0) + '%'
      },
      {
        pattern: /LVR.*?[\d.]+%/gi,
        getValue: () => financialData?.keyMetrics?.lvr,
        format: (v) => 'LVR: ' + (v || 0) + '%'
      },
      // Land Tax row in page 10 table - Amount column then Calculation column
      {
        pattern: /\|\s*Land Tax\s*\|\s*\$[^\n]*/gi,
        getValue: () => landTax,
        format: (v) => {
          const str = String(v || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| Land Tax | $' + str + ' | State land tax threshold for investors |';
        },
        isFullLineReplacement: true
      },
      // Total Annual Costs table row - handle malformed format where amount is in Cost Category column
      // Pattern: | $X,XXX | Sum of ALL ongoing costs | (empty) |
      // Note: Include \.?\d* to match decimal amounts like $11,848.99 to prevent duplicate decimals
      {
        pattern: /\|\s*\$[\d,]+\.?\d*\s*\|\s*Sum of ALL ongoing costs[^\n]*/gi,
        getValue: () => totalAnnualCostsWithLandTax,
        format: (v) => {
          const rounded = Math.round(v || 0);
          const str = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| **Total Annual Costs** | **$' + str + '** | **Sum of ALL ongoing costs** |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\|\s*\*?\*?Total Annual Costs\*?\*?\s*\|[^\n]*/gi,
        getValue: () => totalAnnualCostsWithLandTax,
        format: (v) => {
          const rounded = Math.round(v || 0);
          const str = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          return '| **Total Annual Costs** | **$' + str + '** | **Sum of ALL ongoing costs** |';
        },
        isFullLineReplacement: true
      },
      {
        pattern: /\*\*Total Annual Costs\*\*.*?\$[\d,]+\.?\d*/gi,
        getValue: () => totalAnnualCostsWithLandTax,
        format: (v) => `$${Math.round(v || 0).toLocaleString('en-AU')}`
      },
      {
        pattern: /Total Annual Costs.*?\$[\d,]+\.?\d*/gi,
        getValue: () => totalAnnualCostsWithLandTax,
        format: (v) => `$${Math.round(v || 0).toLocaleString('en-AU')}`
      },
      // Annual Expenses row in Gross & Net Yield table - handle table rows starting with |
      {
        pattern: /\|?\s*Annual Expenses\s*\|[^\n]*/gi,
        getValue: () => {
          // Build breakdown components for display (include strataFees if present)
          const components = [];
          if (councilRates > 0) components.push(`$${councilRates.toLocaleString('en-AU')}`);
          if (waterRates > 0) components.push(`$${waterRates.toLocaleString('en-AU')}`);
          if (strataFees > 0) components.push(`$${strataFees.toLocaleString('en-AU')}`);
          if (propertyManagement > 0) components.push(`$${propertyManagement.toLocaleString('en-AU')}`);
          if (landlordInsurance > 0) components.push(`$${landlordInsurance.toLocaleString('en-AU')}`);
          if (maintenance > 0) components.push(`$${maintenance.toLocaleString('en-AU')}`);
          
          console.log('📊 Annual Expenses breakdown:', {
            councilRates,
            waterRates,
            strataFees,
            propertyManagement,
            landlordInsurance,
            maintenance,
            totalAnnualCostsExcludingLandTax,
            breakdown: components.join(' + ')
          });
          
          return { 
            breakdown: components.join(' + ') || '$0',
            total: totalAnnualCostsExcludingLandTax 
          };
        },
        format: (v) => `| Annual Expenses | ${v.breakdown} | $${v.total?.toLocaleString('en-AU') || '0'} |`,
        isFullLineReplacement: true
      },
      // Note: Removed generic "Annual Expenses" pattern that was corrupting table breakdown display
      // The table-specific pattern above handles the yield table; no fallback needed
      // Net Annual Return row in Gross & Net Yield table - handle table rows starting with |
      {
        pattern: /\|?\s*Net Annual Return\s*\|[^\n]*/gi,
        getValue: () => {
          const netAnnualReturn = annualRent - totalAnnualCostsExcludingLandTax;
          return { annualRent, totalExpenses: totalAnnualCostsExcludingLandTax, netReturn: netAnnualReturn };
        },
        format: (v) => `| Net Annual Return | $${v.annualRent?.toLocaleString('en-AU') || '0'} - $${v.totalExpenses?.toLocaleString('en-AU') || '0'} | $${v.netReturn?.toLocaleString('en-AU') || '0'} |`,
        isFullLineReplacement: true
      },
      // Net Rental Yield row in Gross & Net Yield table - handle table rows starting with |
      {
        pattern: /\|?\s*Net Rental Yield\s*\|[^\n]*/gi,
        getValue: () => {
          const purchasePrice = financialData?.initialCosts?.propertyValue || 0;
          const netAnnualReturn = annualRent - totalAnnualCostsExcludingLandTax;
          const netYield = purchasePrice > 0 ? ((netAnnualReturn / purchasePrice) * 100).toFixed(2) : '0.00';
          return { netReturn: netAnnualReturn, purchasePrice, netYield };
        },
        format: (v) => `| Net Rental Yield | $${v.netReturn?.toLocaleString('en-AU') || '0'} ÷ $${v.purchasePrice?.toLocaleString('en-AU') || '0'} × 100 | ${v.netYield}% |`,
        isFullLineReplacement: true
      },
    ];

    let updatedContent = content;
    let replacementCount = 0;

    for (const { pattern, getValue, format, isFullLineReplacement } of fieldReplacements) {
      const value = getValue();
      if (value !== undefined && value !== null) {
        const formattedValue = format(value);
        const beforeReplace = updatedContent;
        // Use a function replacement to ensure the value is returned verbatim
        updatedContent = updatedContent.replace(pattern, () => {
          // If explicitly marked as full line replacement, return formatted value directly
          if (isFullLineReplacement) {
            console.log(`  🔄 Full line replacement → "${formattedValue.substring(0, 60)}..."`);
            replacementCount++;
            return formattedValue;
          }
          // If formattedValue contains ' | ' (table row) or starts with '- ' (bullet point line), return as-is
          if (formattedValue.includes(' | ') || formattedValue.startsWith('- ')) {
            replacementCount++;
            return formattedValue;
          }
          // Otherwise, this shouldn't happen with current patterns
          replacementCount++;
          return formattedValue;
        });
        
        if (beforeReplace !== updatedContent) {
          console.log(`  ✓ Injected value for pattern: ${pattern.source.substring(0, 30)}...`);
        }
      }
    }

    console.log(`✓ Completed: ${replacementCount} value replacements in markdown content`);
    return updatedContent;
  };

  // Structure to track section hierarchy for TOC
  interface ParsedSection {
    content: string;
    level: number; // 2 = H2 (main section), 3 = H3 (subsection)
    parentSection?: string;
  }
  
  // Store section metadata for TOC hierarchy
  const sectionMetadata = React.useRef<Map<string, ParsedSection>>(new Map());

  const parseReportContent = (content: string): Record<string, string> => {
    const sections: Record<string, string> = {};
    const lines = content.split('\n');
    let currentH2Section = '';
    let currentH3Subsection = '';
    let currentContent: string[] = [];
    
    // Clear previous metadata
    sectionMetadata.current.clear();

    const saveCurrentSection = () => {
      if (currentH2Section && currentContent.length > 0) {
        const sectionKey = currentH3Subsection || currentH2Section;
        // Strip word count markers from content before saving
        const rawContent = currentContent.join('\n').trim();
        sections[sectionKey] = stripWordCountMarkers(rawContent);
        
        // Store metadata for TOC hierarchy
        sectionMetadata.current.set(sectionKey, {
          content: sections[sectionKey],
          level: currentH3Subsection ? 3 : 2,
          parentSection: currentH3Subsection ? currentH2Section : undefined
        });
      }
    };

    for (const line of lines) {
      // Check for H2 heading (## Heading) - Main sections
      const h2Match = line.match(/^##\s+(.+)$/);
      // Check for H3 heading (### Heading) - Subsections
      const h3Match = line.match(/^###\s+(.+)$/);
      // Check for H1 heading (# Heading) - Treat as H2 for compatibility
      const h1Match = line.match(/^#\s+(.+)$/);
      
      if (h2Match || h1Match) {
        // Save previous section before starting new one
        saveCurrentSection();
        
        // Extract section name and strip word count markers
        const rawName = (h2Match?.[1] || h1Match?.[1] || '').trim();
        currentH2Section = stripWordCountMarkers(rawName)
          .replace(/^\d+(\.\d+)*\.?\s+/, '') // Remove all numbered prefixes (e.g., "1 ", "1. ", "11 ", "11. ", "11.1 ", "11.1. ", "11.1.1 ")
          .replace(/:\s*$/, '') // Remove trailing colon
          .trim();
        currentH3Subsection = ''; // Reset subsection
        currentContent = [];
        
        // Store H2 metadata
        sectionMetadata.current.set(currentH2Section, {
          content: '',
          level: 2,
          parentSection: undefined
        });
      } else if (h3Match && currentH2Section) {
        // Save previous section/subsection before starting new subsection
        saveCurrentSection();
        
        // Extract subsection name and strip word count markers
        currentH3Subsection = stripWordCountMarkers(h3Match[1])
          .replace(/^\d+(\.\d+)*\.?\s+/, '') // Remove all numbered prefixes (e.g., "1 ", "1. ", "11 ", "11. ", "11.1 ", "11.1. ", "11.1.1 ")
          .replace(/:\s*$/, '') // Remove trailing colon
          .trim();
        currentContent = [];
      } else if (currentH2Section && line.trim()) {
        // Regular content line - add to current section
        currentContent.push(line);
      }
    }

    // Don't forget the last section
    saveCurrentSection();

    return sections;
  };
  
  // Helper to get section level for TOC rendering
  const getSectionLevel = (sectionName: string): number => {
    return sectionMetadata.current.get(sectionName)?.level || 2;
  };
  
  // Helper to get parent section for TOC hierarchy
  const getParentSection = (sectionName: string): string | undefined => {
    return sectionMetadata.current.get(sectionName)?.parentSection;
  };

  const findSection = (sections: Record<string, string>, possibleNames: string[]): string => {
    for (const name of possibleNames) {
      const exactMatch = sections[name];
      if (exactMatch) return exactMatch;

      const partialMatch = Object.keys(sections).find(key => 
        key.toLowerCase().includes(name.toLowerCase())
      );
      if (partialMatch) return sections[partialMatch];
    }
    return '';
  };

  const extractMarketData = (sections: Record<string, string>, enhancedData: any) => {
    const domainData = enhancedData?.domainData || {};
    const financialData = enhancedData?.financialData || {};
    const investmentScore = enhancedData?.investmentScore || {};
    const absData = enhancedData?.absData || {};
    const locationData = enhancedData?.locationData || {};

    console.log('📊 Extracting market data with financial calculations:', {
      hasFinancialData: !!financialData,
      hasInitialCosts: !!financialData?.initialCosts,
      hasKeyMetrics: !!financialData?.keyMetrics,
      propertyValue: financialData?.initialCosts?.propertyValue,
      weeklyRent: financialData?.income?.weeklyRent
    });

    // Helper to extract numeric values from text
    const extractNumber = (text: string, pattern: RegExp): number | null => {
      const match = text.match(pattern);
      if (match) {
        const numStr = match[1].replace(/,/g, '');
        const num = parseFloat(numStr);
        return isNaN(num) ? null : num;
      }
      return null;
    };

    // CRITICAL: Prioritize structured financial data over markdown-parsed values
    // This ensures manual overrides are reflected in the PDF
    let medianPrice = financialData?.initialCosts?.propertyValue || domainData.medianPrice;
    let rentalYield = financialData?.keyMetrics?.grossYield || investmentScore.cashFlowScore;
    let growthRate = financialData?.assumptions?.capitalGrowth || domainData.growthRate || investmentScore.capitalGrowthScore;

    // Only fall back to parsing markdown if structured data is not available
    if (!medianPrice || !rentalYield) {
      const marketKPIs = findSection(sections, ['Market KPIs', 'Market Performance', 'Key Metrics']);
      
      if (marketKPIs) {
        if (!medianPrice) {
          const priceMatch = extractNumber(marketKPIs, /median.*price.*\$?([\d,]+)/i);
          if (priceMatch) medianPrice = priceMatch;
        }
        
        if (!rentalYield) {
          const yieldMatch = extractNumber(marketKPIs, /rental.*yield.*?([\d.]+)%/i);
          if (yieldMatch) rentalYield = yieldMatch;
        }
        
        if (!growthRate) {
          const growthMatch = extractNumber(marketKPIs, /growth.*?([\d.]+)%/i);
          if (growthMatch) growthRate = growthMatch;
        }
      }
    }

    // Parse Demographics section
    const demographics = findSection(sections, ['Demographics & Demand Drivers', 'Demographics', 'Population']);
    let population = absData.population || domainData.population;
    let medianAge = absData.medianAge || domainData.medianAge;
    let medianIncome = absData.medianIncome || domainData.medianIncome;

    if (demographics) {
      const popMatch = extractNumber(demographics, /population.*?([\d,]+)/i);
      if (popMatch) population = popMatch;
      
      const ageMatch = extractNumber(demographics, /median age.*?([\d.]+)/i);
      if (ageMatch) medianAge = ageMatch;
      
      const incomeMatch = extractNumber(demographics, /median.*income.*\$?([\d,]+)/i);
      if (incomeMatch) medianIncome = incomeMatch;
    }

    console.log('✓ Market data extracted:', {
      medianPrice,
      rentalYield,
      growthRate,
      source: financialData?.initialCosts?.propertyValue ? 'structured_data' : 'markdown_parsed'
    });

    return {
      medianPrice,
      rentalYield,
      growthRate,
      population,
      medianAge,
      medianIncome,
      demographics: absData.demographics || {},
      infrastructure: locationData.nearbyAmenities || locationData.infrastructure || {},
      financialData, // Pass through full financial data for detailed sections
    };
  };

  const replaceTextInElement = (element: HTMLElement, placeholder: string, value: string) => {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    const nodesToReplace: { node: Text; newValue: string }[] = [];

    let node;
    while ((node = walker.nextNode())) {
      const textNode = node as Text;
      if (textNode.nodeValue?.includes(placeholder)) {
        nodesToReplace.push({
          node: textNode,
          newValue: textNode.nodeValue.replace(new RegExp(placeholder, 'g'), value)
        });
      }
    }

    nodesToReplace.forEach(({ node, newValue }) => {
      node.nodeValue = newValue;
    });
  };

  const replaceContentSection = (container: HTMLElement, sectionIdentifiers: string[], content: string, maxLength: number = 500) => {
    if (!content) return;

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null
    );

    const nodesToReplace: { node: Text; newValue: string }[] = [];
    let node;
    
    while ((node = walker.nextNode())) {
      const textNode = node as Text;
      const text = textNode.nodeValue || '';
      
      // Check if text matches any section identifier or is placeholder
      const matchesIdentifier = sectionIdentifiers.some(id => 
        text.toLowerCase().includes(id.toLowerCase())
      );
      const isPlaceholder = text.includes('Lorem ipsum') || 
                           text.includes('Sample text') ||
                           text.includes('placeholder') ||
                           text.trim().length > 50 && text.includes('dolor sit amet');
      
      if (matchesIdentifier || isPlaceholder) {
        // Clean markdown, bullets, and word count markers from content
        const cleanContent = content
          .replace(/^[#*\-•]\s*/gm, '') // Remove markdown headers and bullets
          .replace(/\(\s*\d+\s*(?:-\s*\d+)?\s*words?\s*\)/gi, '') // Remove word count markers like "(500 words)" or "(500-1000 words)"
          .replace(/\(\s*(?:minimum|min|max|maximum)?\s*\d+\s*(?:\+|-)?\s*words?\s*(?:required|minimum|min)?\s*\)/gi, '') // Remove "(min 500 words)" variants
          .replace(/\n+/g, ' ') // Replace newlines with spaces
          .trim()
          .substring(0, maxLength);
        
        nodesToReplace.push({
          node: textNode,
          newValue: cleanContent
        });
      }
    }

    nodesToReplace.forEach(({ node, newValue }) => {
      node.nodeValue = newValue;
    });
  };

  const generateCore = async (): Promise<{ blob: Blob; publicUrl: string; suburb: string; state: string }> => {
    console.log('🚀 Starting PDF generation for report:', report.id);
    
      // Fetch global report settings (contact details and disclaimer)
      console.log('⚙️ Step 0: Fetching global report settings...');
      const globalSettings = await fetchGlobalReportSettings();
      console.log('✓ Global settings loaded:', {
        company: globalSettings.contactDetails.company_name,
        disclaimerEnabled: globalSettings.disclaimer.is_enabled
      });

      console.log('📍 Step 1: Extracting suburb and state from address:', report.address);
      const { suburb, state } = extractSuburbState(report.address);
      console.log('✓ Extracted:', { suburb, state });
      
      console.log('📄 Step 2: Injecting override values and parsing report content...');
      // Inject override values from structured financial data into markdown content
      const contentWithOverrides = injectOverridesIntoContent(
        report.content,
        report.enhanced_data?.financialData
      );
      
      // Parse report content into sections
      const parsedSections = parseReportContent(contentWithOverrides);
      console.log('✓ Parsed sections:', Object.keys(parsedSections));
      
      // Filter out sources sections if toggle is off (AFTER parsing for reliability)
      const sectionsWithoutSources = filterSourcesSections(parsedSections);
      
      // Filter out scoring sections if toggle is off
      const sections = filterScoringSections(sectionsWithoutSources);
      console.log('✓ Final sections for PDF:', Object.keys(sections));

      // Load the PDF template
      console.log('📥 Step 3: Loading PDF template from /templates/npc_template.pdf...');
      const templateResponse = await fetch('/templates/npc_template.pdf');
      if (!templateResponse.ok) {
        throw new Error(`Failed to load template: ${templateResponse.status} ${templateResponse.statusText}`);
      }
      const templateBytes = await templateResponse.arrayBuffer();
      console.log('✓ Template loaded, size:', templateBytes.byteLength, 'bytes');
      
      // Load the template PDF
      console.log('📋 Step 4: Parsing PDF template...');
      const pdfDoc = await PDFDocument.load(templateBytes);
      console.log('✓ PDF template parsed successfully');
      
      const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      console.log('✓ Fonts embedded');

      // Get the second page from template to use as content template
      console.log('📑 Step 5: Preparing template pages...');
      const templatePages = pdfDoc.getPages();
      console.log('✓ Template has', templatePages.length, 'pages');
      
      if (templatePages.length < 2) {
        throw new Error('Template must have at least 2 pages');
      }

      // Remove the original second page since we'll duplicate it as needed
      pdfDoc.removePage(1); // Remove index 1 (second page)
      console.log('✓ Template pages configured');

      // ========================================
      // PAGE BREAK SETTINGS (Global Configuration)
      // ========================================
      const pageWidth = 595; // A4 width in points
      const pageHeight = 842; // A4 height in points
      const margin = 55; // Left/right margin — slightly wider content area
      const topMargin = 75; // Top margin (space for template header)
      const bottomMargin = 65; // Bottom margin
      const lineHeight = 15; // Tighter line spacing for professional look

      // ─── Premium Design Tokens (Dark & Gold) ────────────────────────────
      const GOLD_RGB = rgb(191 / 255, 155 / 255, 80 / 255);     // #BF9B50
      const GOLD_LIGHT_RGB = rgb(245 / 255, 235 / 255, 210 / 255); // #F5EBD2
      const NAVY_RGB = rgb(13 / 255, 38 / 255, 77 / 255);       // #0D264D
      const DARK_BG_RGB = rgb(20 / 255, 20 / 255, 20 / 255);    // #141414
      const WHITE_RGB = rgb(1, 1, 1);
      const BODY_TEXT_RGB = rgb(55 / 255, 55 / 255, 55 / 255);   // #373737
      const SECTION_BG_RGB = rgb(250 / 255, 247 / 255, 240 / 255); // Warm off-white for callouts
      const TABLE_HEADER_BG = NAVY_RGB;
      const TABLE_HEADER_TEXT = WHITE_RGB;
      const TABLE_ALT_ROW = rgb(252 / 255, 249 / 255, 242 / 255); // Very light gold tint
      const TABLE_BORDER = rgb(210 / 255, 195 / 255, 160 / 255);  // Gold-tinted border
      const FOOTER_TEXT_RGB = rgb(128 / 255, 128 / 255, 128 / 255);
      const titleSize = 14;
      const textSize = 9.5; // Slightly smaller for more content per page
      
      // Smart page break thresholds
      const PAGE_BREAK_CONFIG = {
        // Minimum space required before starting a new element
        MIN_SPACE_FOR_TABLE: 120, // Reduced — allow tables to start lower on page
        MIN_SPACE_FOR_SECTION: 90, // Minimum space for a new section title + some content
        MIN_SPACE_FOR_PARAGRAPH: 50, // Minimum space for a paragraph
        MIN_SPACE_FOR_HEADING: 70, // Minimum space for headings
        // Table-specific settings
        TABLE_ORPHAN_ROWS: 3, // Minimum rows to keep together (avoid orphan rows)
        PREFER_FULL_TABLES: true, // If true, move entire table to new page rather than split
        TABLE_SAFETY_MARGIN: 30, // Extra margin to ensure table fits
      };
      
      // Sections that MUST start on a new page (forced page breaks)
      const FORCED_NEW_PAGE_SECTIONS = [
        'employment & industry breakdown',
        'employment and industry breakdown',
        'recreational amenities',
        'property-level information',
        'property level information',
      ];
      
      // Headers that must stay attached to their following table (no orphan headers)
      const KEEP_WITH_TABLE_HEADERS = [
        'property snapshot',
        'ongoing annual costs',
        'ongoing annual ongoing costs',
        'annual ongoing costs',
        'water rates justification',
        'yield comparison to benchmarks',
        'interest only loan',
        'interest-only loan',
        'alternative structure',
        'loan serviceability assessment',
        'rental income projections',
      ];

      let currentPage: any = null;
      let yPosition = 0;

      // Helper to group content into paragraphs and tables
      const groupContentBlocks = (content: string): string[] => {
        const lines = content.split('\n');
        const blocks: string[] = [];
        let i = 0;
        
        while (i < lines.length) {
          const line = lines[i].trim();
          
          // Skip empty lines
          if (!line) {
            i++;
            continue;
          }
          
          // Check if this line is part of a table (contains |)
          if (line.includes('|')) {
            // Accumulate all consecutive table lines
            const tableLines: string[] = [];
            while (i < lines.length && lines[i].trim().includes('|')) {
              tableLines.push(lines[i]);
              i++;
            }
            // Add the complete table as one block
            blocks.push(tableLines.join('\n'));
          } else {
            // Regular paragraph line
            blocks.push(line);
            i++;
          }
        }
        
        return blocks;
      };

      // Helper function to sanitize text for WinAnsi encoding (removes emojis, newlines, and special chars)
      const stripEmojis = (text: string): string => {
        // Remove emojis and other non-WinAnsi characters
        return text
          // Replace smart/curly quotes with straight quotes
          .replace(/[\u2018\u2019\u201B]/g, "'") // Single curly quotes to straight
          .replace(/[\u201C\u201D\u201F]/g, '"') // Double curly quotes to straight
          // Replace special dashes and hyphens
          .replace(/[\u2013\u2014\u2015]/g, '-') // En-dash, em-dash, horizontal bar
          .replace(/[\u2010\u2011\u2012]/g, '-') // Various hyphens
          // Replace ellipsis
          .replace(/\u2026/g, '...')
          // Replace bullet points
          .replace(/[\u2022\u2023\u2043\u204C\u204D]/g, '-')
          // Replace non-breaking spaces and other space variants
          .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
          // Remove zero-width characters
          .replace(/[\u200C\u200D\uFEFF]/g, '')
          // Remove emojis - comprehensive ranges
          .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
          .replace(/[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{2300}-\u{23FF}]|[\u{2B50}]|[\u{231A}-\u{231B}]/gu, '')
          .replace(/[\u{FE00}-\u{FE0F}]|[\u{E0020}-\u{E007F}]/gu, '') // Variation selectors
          // Remove other problematic Unicode symbols
          .replace(/[\u2190-\u21FF]/g, '') // Arrows
          .replace(/[\u2500-\u257F]/g, '') // Box drawing
          .replace(/[\u2580-\u259F]/g, '') // Block elements
          .replace(/[\u25A0-\u25FF]/g, '') // Geometric shapes
          .replace(/[\u2600-\u26FF]/g, '') // Miscellaneous symbols
          .replace(/[\u2700-\u27BF]/g, '') // Dingbats
          // Replace any remaining non-ASCII characters that aren't in WinAnsi
          .replace(/[^\x00-\x7F\xA0-\xFF]/g, '')
          // Replace newlines, carriage returns, tabs with spaces
          .replace(/[\n\r\t]/g, ' ')
          // Normalize multiple spaces to single space
          .replace(/\s+/g, ' ')
          .trim();
      };

      // Helper function to add a new content page by copying from template
      const addContentPage = async () => {
        // Load template again to get a fresh page 2
        const freshTemplate = await PDFDocument.load(templateBytes);
        const [copiedPage] = await pdfDoc.copyPages(freshTemplate, [1]);
        pdfDoc.addPage(copiedPage);
        return pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
      };

      // Helper function to add a contact/disclaimer page with global settings
      const addContactDisclaimerPage = async (settings: GlobalReportSettings) => {
        const page = drawPdfLibDisclaimerPage(
          pdfDoc,
          pageWidth,
          pageHeight,
          helveticaFont,
          helveticaBold,
          settings.contactDetails,
          settings.disclaimer,
        );
        console.log('✓ Added contact/disclaimer page with global settings');
        return page;
      };

      // Helper to check if text is a markdown table
      const isMarkdownTable = (text: string): boolean => {
        const lines = text.trim().split('\n');
        // A table has at least 2 lines (header + separator)
        if (lines.length < 2) return false;
        // Check if it has pipe separators
        return lines.some(line => line.includes('|'));
      };

      // Helper to calculate TOTAL table height without drawing (for smart page breaks)
      const calculateTableHeight = (tableText: string, maxWidth: number, normalFont: any, boldFont: any, size: number): number => {
        const lines = tableText.trim().split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return 0;

        // Parse table rows (same logic as drawTable)
        const rows = lines
          .filter(line => {
            const withoutPipes = line.replace(/\|/g, '').trim();
            const isSeparator = /^[\s\-:]+$/.test(withoutPipes);
            return !isSeparator;
          })
          .map((line, lineIndex) => {
            const cells = line.split('|')
              .map(cell => cell.trim())
              .filter(cell => cell.length > 0);
            return cells;
          })
          .filter(row => row.length > 0);

        if (rows.length === 0) return 0;

        // ===== ISSUE 6 FIX: Apply same column normalization as drawTable =====
        const dataRowColumnCounts = rows.slice(1).map(r => r.length);
        const mostCommonCount = dataRowColumnCounts.length > 0 
          ? dataRowColumnCounts.sort((a, b) => 
              dataRowColumnCounts.filter(v => v === b).length - dataRowColumnCounts.filter(v => v === a).length
            )[0]
          : rows[0]?.length || 0;
        
        const normalizedRows = rows.map((row) => {
          if (row.length === mostCommonCount) return row;
          if (row.length > mostCommonCount) return row.slice(0, mostCommonCount);
          const padded = [...row];
          while (padded.length < mostCommonCount) padded.push('');
          return padded;
        });

        const columnCount = Math.max(...normalizedRows.map(r => r.length));
        const cellPadding = 5;
        const tableLineHeight = size + 4;
        
        // Calculate column widths (simplified version for estimation)
        const colWidth = maxWidth / columnCount;
        
        let totalHeight = 0;
        
        // Calculate height for each row
        for (let i = 0; i < normalizedRows.length; i++) {
          const row = normalizedRows[i];
          const isHeader = i === 0;
          let maxRowHeight = tableLineHeight + 8;
          
          for (let j = 0; j < row.length; j++) {
            const cellText = sanitizeAIContent(stripEmojis(row[j] || ''));
            const maxCellWidth = colWidth - 2 * cellPadding;
            
            // Estimate lines needed
            let currentLineWidth = 0;
            let cellLines = 1;
            const font = isHeader ? boldFont : normalFont;
            const words = cellText.replace(/\*+/g, '').split(' ').filter(w => w.length > 0);
            
            for (const word of words) {
              const wordWidth = font.widthOfTextAtSize(word + ' ', size);
              if (currentLineWidth + wordWidth > maxCellWidth && currentLineWidth > 0) {
                cellLines++;
                currentLineWidth = wordWidth;
              } else {
                currentLineWidth += wordWidth;
              }
            }
            
            const cellHeight = (cellLines * tableLineHeight) + 8;
            maxRowHeight = Math.max(maxRowHeight, cellHeight);
          }
          
          totalHeight += maxRowHeight;
        }
        
        return totalHeight + 25; // Add spacing after table
      };

      // Helper to parse and draw markdown table
      const buildMarkdownTableFromRows = (tableRows: string[][]): string => {
        if (!tableRows.length) return '';
        const colCount = Math.max(...tableRows.map(r => r.length));
        const normalized = tableRows.map(r => {
          const padded = [...r];
          while (padded.length < colCount) padded.push('');
          return padded;
        });
        const header = `| ${normalized[0].join(' | ')} |`;
        const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;
        const body = normalized.slice(1).map(r => `| ${r.join(' | ')} |`);
        return [header, separator, ...body].join('\n');
      };

      const drawTable = (
        page: any,
        tableText: string,
        x: number,
        startY: number,
        maxWidth: number,
        normalFont: any,
        boldFont: any,
        size: number
      ): { lastY: number; needsNewPage: boolean; remainingTableText?: string } => {
        const lines = tableText.trim().split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return { lastY: startY, needsNewPage: false };

        console.log('Drawing table with lines:', lines);

        // Parse table structure - filter out separator lines more carefully
        // Track if first row is header for column removal logic
        let isFirstDataRow = true;
        const rows = lines
          .filter(line => {
            // Keep lines that have content other than just |, -, :, and spaces
            const withoutPipes = line.replace(/\|/g, '').trim();
            const isSeparator = /^[\s\-:]+$/.test(withoutPipes);
            return !isSeparator;
          })
          .map((line, lineIndex) => {
            // Split by | and clean up cells - don't strip emojis yet, we'll do it when drawing
            const cells = line.split('|')
              .map(cell => cell.trim())
              .filter(cell => cell.length > 0);
            
            // Check if this is a total row (contains "Total" and has amount in the text)
            const lineText = line.toLowerCase();
            const isTotalRow = lineText.includes('total') && /\$[\d,]+\.?\d*/.test(line);
            
            // Determine if this is the header row (first row after filtering)
            const isHeaderRow = lineIndex === 0;
            
            // FIX: Handle malformed Total row where amount is in first cell and description in second
            // Pattern: | $X,XXX | Sum of ALL ongoing costs | (empty) |
            // Note: The content might have partial bold markers like "$8,908**" or "**Sum of..."
            // Strip bold markers before checking
            const firstCellClean = (cells[0] ?? '').trim().replace(/\*+/g, '');
            const secondCellClean = cells.length >= 2 ? (cells[1] ?? '').replace(/\*+/g, '').toLowerCase() : '';
            const firstCellIsDollarAmount = /^\$[\d,\.]+$/.test(firstCellClean);
            const secondCellIsOngoingCosts = secondCellClean.includes('sum of') || secondCellClean.includes('ongoing costs');
            
            console.log('Checking row for malformed Total:', { 
              cells, 
              firstCellClean, 
              firstCellIsDollarAmount, 
              secondCellIsOngoingCosts,
              cellsLength: cells.length
            });
            
            if (cells.length >= 2 && firstCellIsDollarAmount && secondCellIsOngoingCosts) {
              console.log('✅ Fixing malformed Total row:', cells);
              // Extract the numeric value, parse it, round it, and reformat to prevent duplicate decimals
              const numericValue = parseFloat(firstCellClean.replace(/[$,]/g, '')) || 0;
              const formattedValue = Math.round(numericValue).toLocaleString('en-AU');
              // Restructure to: [Label, Amount, Description]
              return ['**Total Annual Costs**', '**$' + formattedValue + '**', '**Sum of ALL ongoing costs**'];
            }
            
            // For total rows, preserve all cells including amounts
            // For normal data rows (NOT headers), remove the last column (Source/Methodology) to simplify layout
            // ISSUE 6 FIX: When we remove the last column from data rows, we must also remove it from the header
            // to keep column counts aligned. Track this via a flag we'll apply after the map.
            // For now, return all cells - we'll normalize column counts after parsing all rows.
            
            // For rows with amount in first cell like "Total Initial Costs $48,269", split it properly
            if (isTotalRow && cells.length === 1 && cells[0].includes('$')) {
              const match = cells[0].match(/^(.*?)(\$[\d,]+)$/);
              if (match) {
                return [match[1].trim(), '', match[2].trim()];
              }
            }
            
            return cells;
          })
          .filter(row => row.length > 0);

        console.log('Parsed table rows (before normalization):', rows);

        if (rows.length === 0) return { lastY: startY, needsNewPage: false };

        // ===== ISSUE 6 FIX: Normalize column counts across all rows =====
        // Find the most common column count among data rows (skip header for this calculation)
        // This ensures headers and data rows have matching column counts
        const dataRowColumnCounts = rows.slice(1).map(r => r.length);
        const mostCommonCount = dataRowColumnCounts.length > 0 
          ? dataRowColumnCounts.sort((a, b) => 
              dataRowColumnCounts.filter(v => v === b).length - dataRowColumnCounts.filter(v => v === a).length
            )[0]
          : rows[0]?.length || 0;
        
        // Normalize all rows to the most common column count
        const normalizedRows = rows.map((row, rowIndex) => {
          if (row.length === mostCommonCount) return row;
          
          // If row has more columns than expected, trim from the end (removes Source/Methodology columns)
          if (row.length > mostCommonCount) {
            console.log(`  Trimming row ${rowIndex} from ${row.length} to ${mostCommonCount} columns`);
            return row.slice(0, mostCommonCount);
          }
          
          // If row has fewer columns, pad with empty strings
          const padded = [...row];
          while (padded.length < mostCommonCount) {
            padded.push('');
          }
          return padded;
        });
        
        console.log('Normalized table rows:', normalizedRows);

        const columnCount = Math.max(...normalizedRows.map(r => r.length));
        const cellPadding = 6; // Slightly more padding for readability
        const lineHeight = size + 5; // Better line spacing within cells
        
        // Calculate dynamic column widths based on content
        const calculateColumnWidths = (): number[] => {
          const minColWidth = 50; // Better minimum column width
          const contentWidths: number[] = [];
          
          // Detect if this is a scenario table (Conservative/Base Case/Optimistic)
          const headerRow = normalizedRows[0] || [];
          const isScenarioTable = headerRow.some((cell: string) => 
            cell?.toLowerCase().includes('conservative') || 
            cell?.toLowerCase().includes('base case') || 
            cell?.toLowerCase().includes('optimistic')
          );
          
          // Detect if first column is "Year" - these can be much narrower
          const firstColHeader = (headerRow[0] || '').toLowerCase().trim();
          const isFirstColYear = firstColHeader === 'year' || firstColHeader.includes('year');
          
          // Calculate content width for each column
          for (let col = 0; col < columnCount; col++) {
            // For Year columns, use a fixed narrow width
            if (col === 0 && isFirstColYear) {
              contentWidths.push(35); // Fixed narrow width for Year column
              continue;
            }
            
            let maxContentWidth = minColWidth;
            
            for (const row of normalizedRows) {
              if (row[col]) {
                const cellText = stripEmojis(row[col]);
                const parts = parseMarkdownText(cellText);
                
                // Calculate max word/segment width in this cell
                for (const part of parts) {
                  const partFont = part.bold ? boldFont : normalFont;
                  const words = part.text.split(' ');
                  
                  for (const word of words) {
                    const wordWidth = partFont.widthOfTextAtSize(word + ' ', size);
                    maxContentWidth = Math.max(maxContentWidth, wordWidth + 2 * cellPadding);
                  }
                }
              }
            }
            
            contentWidths.push(maxContentWidth);
          }
          
          // Calculate total desired width
          const totalDesiredWidth = contentWidths.reduce((sum, w) => sum + w, 0);
          
          // For scenario tables, ensure equal distribution for scenario columns
          if (isScenarioTable && columnCount >= 4) {
            const yearColWidth = isFirstColYear ? 35 : contentWidths[0];
            const remainingWidth = maxWidth - yearColWidth;
            const scenarioColCount = columnCount - 1;
            const scenarioColWidth = remainingWidth / scenarioColCount;
            
            return contentWidths.map((w, i) => {
              if (i === 0 && isFirstColYear) return yearColWidth;
              return Math.max(minColWidth, scenarioColWidth);
            });
          }
          
          // If desired width fits, use it; otherwise scale proportionally
          if (totalDesiredWidth <= maxWidth) {
            // Distribute extra space proportionally
            const extraSpace = maxWidth - totalDesiredWidth;
            return contentWidths.map(w => w + (w / totalDesiredWidth) * extraSpace);
          } else {
            // Scale down proportionally to fit, but preserve Year column narrow width
            const scale = maxWidth / totalDesiredWidth;
            return contentWidths.map((w, i) => {
              if (i === 0 && isFirstColYear) return Math.max(35, w * scale);
              return Math.max(minColWidth, w * scale);
            });
          }
        };
        
        const columnWidths = calculateColumnWidths();

        let currentY = startY;

        // Helper to draw text with wrapping and markdown within a cell
        const drawCellText = (
          cellText: string, 
          cellX: number, 
          cellY: number, 
          cellWidth: number, 
          font: any,
          isHeader: boolean,
          textColor?: any
        ): number => {
          const maxCellWidth = cellWidth - 2 * cellPadding;
          const parts = parseMarkdownText(sanitizeAIContent(stripEmojis(cellText)));
          
          let currentLineY = cellY;
          let currentLineX = cellX + cellPadding;
          let lineWords: Array<{text: string, font: any}> = [];
          let lineWidth = 0;

          const drawLine = () => {
            if (lineWords.length === 0) return;
            let drawX = currentLineX;
            for (const word of lineWords) {
              page.drawText(word.text, {
                x: drawX,
                y: currentLineY,
                size,
                font: word.font,
                color: textColor || rgb(0.2, 0.2, 0.2),
              });
              drawX += word.font.widthOfTextAtSize(word.text, size);
            }
            lineWords = [];
            lineWidth = 0;
            currentLineY -= lineHeight;
          };

          for (const part of parts) {
            const partFont = (part.bold || isHeader) ? boldFont : normalFont;
            
            // Check if this is a URL (contains :// or www. or long string without spaces)
            const isURL = part.text.includes('://') || part.text.includes('www.') || 
                         (part.text.length > 40 && !part.text.includes(' '));
            
            if (isURL) {
              // Break URLs at slashes, question marks, and other delimiters
              // BUT skip breaking at the protocol (https://, http://)
              let currentSegment = '';
              const protocolEndIndex = part.text.indexOf('://') !== -1 ? part.text.indexOf('://') + 3 : 0;
              
              for (let i = 0; i < part.text.length; i++) {
                const char = part.text[i];
                currentSegment += char;
                
                // Only break at / if we're past the protocol part
                const isBreakableSlash = char === '/' && i >= protocolEndIndex;
                const shouldBreakAfter = (isBreakableSlash || ['?', '&', '='].includes(char));
                const segmentWidth = partFont.widthOfTextAtSize(currentSegment, size);
                
                if ((shouldBreakAfter && i < part.text.length - 1) || segmentWidth > maxCellWidth * 0.95) {
                  // Draw current segment
                  if (lineWidth + segmentWidth > maxCellWidth && lineWords.length > 0) {
                    drawLine();
                  }
                  
                  lineWords.push({ text: currentSegment, font: partFont });
                  lineWidth += segmentWidth;
                  
                  // Start new line for next segment
                  if (shouldBreakAfter) {
                    drawLine();
                  }
                  
                  currentSegment = '';
                }
              }
              
              // Draw any remaining segment
              if (currentSegment) {
                const segmentWidth = partFont.widthOfTextAtSize(currentSegment, size);
                if (lineWidth + segmentWidth > maxCellWidth && lineWords.length > 0) {
                  drawLine();
                }
                lineWords.push({ text: currentSegment, font: partFont });
                lineWidth += segmentWidth;
              }
            } else {
              // Normal text wrapping by words
              const words = part.text.split(' ').filter(w => w.length > 0);
              
              for (const word of words) {
                const wordWithSpace = word + ' ';
                const wordWidth = partFont.widthOfTextAtSize(wordWithSpace, size);
                
                if (lineWidth + wordWidth > maxCellWidth && lineWords.length > 0) {
                  drawLine();
                }
                
                lineWords.push({ text: wordWithSpace, font: partFont });
                lineWidth += wordWidth;
              }
            }
          }
          
          if (lineWords.length > 0) {
            drawLine();
          }

          return cellY - currentLineY;
        };

        // Calculate row height based on tallest cell
        const calculateRowHeight = (row: string[], isHeader: boolean): number => {
          let maxHeight = lineHeight + 10; // Minimum height with better padding
          
          for (let j = 0; j < row.length; j++) {
            const cellText = row[j];
            const maxCellWidth = columnWidths[j] - 2 * cellPadding;
            
            // Calculate how many lines this cell needs
            const parts = parseMarkdownText(stripEmojis(cellText));
            let currentLineWidth = 0;
            let lines = 1;
            
            for (const part of parts) {
              const partFont = (part.bold || isHeader) ? boldFont : normalFont;
              
              // Check if this is a URL (same logic as drawCellText)
              const isURL = part.text.includes('://') || part.text.includes('www.') || 
                           (part.text.length > 40 && !part.text.includes(' '));
              
              if (isURL) {
                // Calculate lines needed for URL with breaking
                // BUT skip breaking at the protocol (https://, http://)
                let currentSegment = '';
                const protocolEndIndex = part.text.indexOf('://') !== -1 ? part.text.indexOf('://') + 3 : 0;
                
                for (let i = 0; i < part.text.length; i++) {
                  const char = part.text[i];
                  currentSegment += char;
                  
                  // Only break at / if we're past the protocol part
                  const isBreakableSlash = char === '/' && i >= protocolEndIndex;
                  const shouldBreakAfter = (isBreakableSlash || ['?', '&', '='].includes(char));
                  const segmentWidth = partFont.widthOfTextAtSize(currentSegment, size);
                  
                  if ((shouldBreakAfter && i < part.text.length - 1) || segmentWidth > maxCellWidth * 0.95) {
                    if (currentLineWidth + segmentWidth > maxCellWidth && currentLineWidth > 0) {
                      lines++;
                      currentLineWidth = segmentWidth;
                    } else {
                      currentLineWidth += segmentWidth;
                    }
                    
                    if (shouldBreakAfter) {
                      lines++;
                      currentLineWidth = 0;
                    }
                    
                    currentSegment = '';
                  }
                }
                
                if (currentSegment) {
                  const segmentWidth = partFont.widthOfTextAtSize(currentSegment, size);
                  if (currentLineWidth + segmentWidth > maxCellWidth && currentLineWidth > 0) {
                    lines++;
                    currentLineWidth = segmentWidth;
                  } else {
                    currentLineWidth += segmentWidth;
                  }
                }
              } else {
                // Normal word-based calculation
                const words = part.text.split(' ').filter(w => w.length > 0);
                
                for (const word of words) {
                  const wordWithSpace = word + ' ';
                  const wordWidth = partFont.widthOfTextAtSize(wordWithSpace, size);
                  
                  if (currentLineWidth + wordWidth > maxCellWidth && currentLineWidth > 0) {
                    lines++;
                    currentLineWidth = wordWidth;
                  } else {
                    currentLineWidth += wordWidth;
                  }
                }
              }
            }
            
            const cellHeight = (lines * lineHeight) + 8;
            maxHeight = Math.max(maxHeight, cellHeight);
          }
          
          return maxHeight;
        };

        // Draw each row
        for (let i = 0; i < normalizedRows.length; i++) {
          let row = normalizedRows[i];
          const isHeader = i === 0;
          
          // BACKUP FIX: Check for malformed Total row right before drawing
          // If first cell is a dollar amount and second cell mentions ongoing costs, fix it
          // Strip bold markers before checking
          if (!isHeader && row.length >= 2) {
            const firstCellClean = (row[0]?.trim() || '').replace(/\*+/g, '');
            const secondCellClean = (row[1] || '').replace(/\*+/g, '').toLowerCase();
            if (/^\$[\d,\.]+$/.test(firstCellClean) && (secondCellClean.includes('sum of') || secondCellClean.includes('ongoing costs'))) {
              console.log('🔧 BACKUP FIX: Restructuring malformed Total row at draw time:', row);
              // Extract the numeric value, parse it, round it, and reformat to prevent duplicate decimals
              const numericValue = parseFloat(firstCellClean.replace(/[$,]/g, '')) || 0;
              const formattedValue = Math.round(numericValue).toLocaleString('en-AU');
              row = ['**Total Annual Costs**', '**$' + formattedValue + '**', '**Sum of ALL ongoing costs**'];
            }
          }
          
          const rowHeight = calculateRowHeight(row, isHeader);
          
          // Check if we need a new page
          if (currentY - rowHeight < bottomMargin + 40) {
            // IMPORTANT: Return the remaining table content so it can continue on the next page
            // Re-include the header row on the next page for readability.
            const remainingRows = [normalizedRows[0], ...normalizedRows.slice(i)];
            const remainingTableText = buildMarkdownTableFromRows(remainingRows);
            return { lastY: currentY, needsNewPage: true, remainingTableText };
          }

          // Draw cell backgrounds — premium styled
          if (isHeader) {
            // Navy header background
            page.drawRectangle({
              x: x,
              y: currentY - rowHeight + 2,
              width: maxWidth,
              height: rowHeight,
              color: TABLE_HEADER_BG,
            });
          } else if (i % 2 === 0) {
            // Gold-tinted alternating rows
            page.drawRectangle({
              x: x,
              y: currentY - rowHeight + 2,
              width: maxWidth,
              height: rowHeight,
              color: TABLE_ALT_ROW,
            });
          }

          // Draw cells
          for (let j = 0; j < row.length; j++) {
            const cellX = x + columnWidths.slice(0, j).reduce((sum, w) => sum + w, 0);
            const cellText = row[j];
            const font = isHeader ? boldFont : normalFont;
            const cellTextY = currentY - size - 6; // Better vertical centering within cell
            
            if (isHeader) {
              // Use drawCellText with white color and word-wrapping for headers
              drawCellText(cellText, cellX, cellTextY, columnWidths[j], boldFont, true, TABLE_HEADER_TEXT);
            } else {
              drawCellText(cellText, cellX, cellTextY, columnWidths[j], font, isHeader);
            }

            // Draw vertical cell border (gold-tinted)
            if (j < row.length - 1) {
              page.drawLine({
                start: { x: cellX + columnWidths[j], y: currentY },
                end: { x: cellX + columnWidths[j], y: currentY - rowHeight },
                thickness: 0.5,
                color: TABLE_BORDER,
              });
            }
          }

          // Draw horizontal border (gold-tinted)
          page.drawLine({
            start: { x: x, y: currentY - rowHeight },
            end: { x: x + maxWidth, y: currentY - rowHeight },
            thickness: isHeader ? 1.5 : 0.5,
            color: isHeader ? GOLD_RGB : TABLE_BORDER,
          });

          if (isHeader) {
            // Draw top border for header (gold accent)
            page.drawLine({
              start: { x: x, y: currentY },
              end: { x: x + maxWidth, y: currentY },
              thickness: 1.5,
              color: GOLD_RGB,
            });
          }

          currentY -= rowHeight;
        }

        return { lastY: currentY - 18, needsNewPage: false }; // Clean spacing after table
      };

      // Helper to draw horizontal rule (gold accent)
      const drawHorizontalRule = (page: any, x: number, y: number, width: number): number => {
        page.drawLine({
          start: { x: x, y: y },
          end: { x: x + width, y: y },
          thickness: 1.5,
          color: GOLD_RGB,
        });
        return y - 20; // Space after rule
      };

      // ─── Premium KPI Boxes (gold-bordered metric cards) ─────────────────
      const drawKPIBoxes = (
        page: any,
        startY: number,
        metrics: Array<{ label: string; value: string; subtitle?: string }>,
        maxWidth: number
      ): number => {
        const boxCount = Math.min(metrics.length, 4); // Max 4 boxes per row
        if (boxCount === 0) return startY;
        
        const boxGap = 10;
        const boxWidth = (maxWidth - (boxCount - 1) * boxGap) / boxCount;
        const boxHeight = 72; // Increased for better spacing
        const cornerRadius = 4;
        
        for (let i = 0; i < boxCount; i++) {
          const metric = metrics[i];
          const boxX = margin + i * (boxWidth + boxGap);
          const boxY = startY - boxHeight;
          
          // Draw warm off-white background
          page.drawRectangle({
            x: boxX,
            y: boxY,
            width: boxWidth,
            height: boxHeight,
            color: SECTION_BG_RGB,
            borderColor: GOLD_RGB,
            borderWidth: 1.2,
          });
          
          // Draw gold top accent strip
          page.drawRectangle({
            x: boxX,
            y: boxY + boxHeight - 4,
            width: boxWidth,
            height: 4,
            color: GOLD_RGB,
          });
          
          // Draw label (small, gray, centered) — at top below gold strip
          const labelText = stripEmojis(metric.label).toUpperCase();
          const labelSize = 7;
          const labelWidth = helveticaBold.widthOfTextAtSize(labelText, labelSize);
          page.drawText(labelText, {
            x: boxX + (boxWidth - labelWidth) / 2,
            y: boxY + boxHeight - 18,
            size: labelSize,
            font: helveticaBold,
            color: FOOTER_TEXT_RGB,
          });
          
          // Draw value (large, navy, centered vertically)
          const valueText = stripEmojis(metric.value);
          const valueSize = metric.subtitle ? 15 : 16;
          const valueWidth = helveticaBold.widthOfTextAtSize(valueText, valueSize);
          const valueY = metric.subtitle ? boxY + 28 : boxY + 24;
          page.drawText(valueText, {
            x: boxX + (boxWidth - valueWidth) / 2,
            y: valueY,
            size: valueSize,
            font: helveticaBold,
            color: NAVY_RGB,
          });
          
          // Draw subtitle if present
          if (metric.subtitle) {
            const subText = stripEmojis(metric.subtitle);
            const subSize = 6.5;
            const subWidth = helveticaFont.widthOfTextAtSize(subText, subSize);
            page.drawText(subText, {
              x: boxX + (boxWidth - subWidth) / 2,
              y: boxY + 10,
              size: subSize,
              font: helveticaFont,
              color: FOOTER_TEXT_RGB,
            });
          }
        }
        
        return startY - boxHeight - 16; // Return new Y position
      };

      // ─── Premium Callout Panel (gold left border + warm background) ─────
      const drawCalloutPanel = (
        page: any,
        text: string,
        startY: number,
        maxWidth: number
      ): { lastY: number; needsNewPage: boolean } => {
        const panelPadding = 14;
        const borderWidth = 3;
        const innerWidth = maxWidth - borderWidth - panelPadding * 2;
        const textSize = 9.5;
        const lineSpacing = 14;
        
        // Calculate text height
        const textHeight = calculateTextHeight(
          text, innerWidth, helveticaFont, helveticaBold, textSize, lineSpacing
        );
        const panelHeight = textHeight + panelPadding * 2;
        
        // Check if panel fits on current page
        if (startY - panelHeight < bottomMargin + 40) {
          return { lastY: startY, needsNewPage: true };
        }
        
        const panelY = startY - panelHeight;
        
        // Draw warm off-white background
        page.drawRectangle({
          x: margin,
          y: panelY,
          width: maxWidth,
          height: panelHeight,
          color: SECTION_BG_RGB,
        });
        
        // Draw gold left border
        page.drawRectangle({
          x: margin,
          y: panelY,
          width: borderWidth,
          height: panelHeight,
          color: GOLD_RGB,
        });
        
        // Draw "What This Means" label at top
        const labelText = 'WHAT THIS MEANS';
        page.drawText(labelText, {
          x: margin + borderWidth + panelPadding,
          y: startY - panelPadding - 2,
          size: 7.5,
          font: helveticaBold,
          color: GOLD_RGB,
        });
        
        // Draw the callout text
        const textStartY = startY - panelPadding - 16;
        const result = drawTextWithWrap(
          page,
          text,
          margin + borderWidth + panelPadding,
          textStartY,
          innerWidth,
          helveticaFont,
          helveticaBold,
          textSize,
          lineSpacing,
          'left'
        );
        
        return { lastY: panelY - 15, needsNewPage: false };
      };

      // Helper to detect and extract "What This Means" callout content
      const isCalloutParagraph = (text: string): { isCallout: boolean; content: string } => {
        const calloutPatterns = [
          /^\*?\*?\s*#{0,6}\s*What\s*This\s*Means(?:\s*for\s*you)?\*?\*?[:\s\-–—]*([\s\S]*)/i,
          /^\*?\*?\s*#{0,6}\s*Key\s*Takeaway\*?\*?[:\s\-–—]*([\s\S]*)/i,
          /^\*?\*?\s*#{0,6}\s*Practical\s*Implication\*?\*?[:\s\-–—]*([\s\S]*)/i,
          /^\*?\*?\s*#{0,6}\s*Bottom\s*Line\*?\*?[:\s\-–—]*([\s\S]*)/i,
          /^\*?\*?\s*#{0,6}\s*In\s*Practice\*?\*?[:\s\-–—]*([\s\S]*)/i,
        ];

        for (const pattern of calloutPatterns) {
          const match = text.match(pattern);
          if (match) {
            let content = (match[1] ?? '').trim();
            // Strip nested/repeated label prefixes (e.g. "**What This Means**\nWhat This Means: ...")
            for (let i = 0; i < 3; i++) {
              const inner = content.match(
                /^\*?\*?\s*#{0,6}\s*(?:What\s*This\s*Means(?:\s*for\s*you)?|Key\s*Takeaway|Practical\s*Implication|Bottom\s*Line|In\s*Practice)\*?\*?[:\s\-–—]*([\s\S]*)/i,
              );
              if (!inner) break;
              content = (inner[1] ?? '').trim();
            }
            // Strip citation/placeholder noise
            const stripped = content
              .replace(/\[(?:provided[^\]]*|citation[^\]]*|n\/?a|tbd|todo|pending|placeholder)\]/gi, '')
              .replace(/\((?:citation[^)]*|provided[^)]*)\)/gi, '')
              .trim();
            const junk = /^(?:[-–—_*•\s]+|n\/?a|tbd|todo|pending|placeholder)$/i;
            if (!stripped || junk.test(stripped) || stripped.length < 15) {
              // Empty/junk body → drop the entire paragraph so we never render an empty box or orphan label.
              return { isCallout: true, content: '' };
            }
            return { isCallout: true, content: stripped };
          }
        }
        return { isCallout: false, content: text };
      };

      // Helper to detect KPI-style content and extract metrics
      const extractKPIMetrics = (sectionName: string, content: string, enhancedData: any): { row1: Array<{ label: string; value: string; subtitle?: string }>; row2?: Array<{ label: string; value: string; subtitle?: string }> } | null => {
        // Compass / Compass-40 reports are explicitly NON-financial under the
        // current product brief — purchase price, LVR, yield, rent and similar
        // KPI tiles must never render. KPI tiles are reserved for the separate
        // Financial Analysis report tier.
        if (reportTier !== 'financial') return null;

        const sectionLower = sectionName.toLowerCase();
        const financialData = enhancedData?.financialData || {};
        const keyMetrics = financialData?.keyMetrics || {};
        const assumptions = financialData?.assumptions || {};
        const initialCosts = financialData?.initialCosts || {};
        const income = financialData?.income || {};
        const absData = enhancedData?.absData || {};
        
        // Only show KPIs for specific financial/market sections
        if (sectionLower.includes('financial') || sectionLower.includes('investment snapshot') || 
            sectionLower.includes('key metric') || sectionLower.includes('market kpi') ||
            sectionLower.includes('property snapshot') || sectionLower.includes('executive summary')) {

          
          const row1: Array<{ label: string; value: string; subtitle?: string }> = [];
          
          // Purchase Price
          if (initialCosts?.propertyValue) {
            row1.push({
              label: 'Purchase Price',
              value: '$' + Number(initialCosts.propertyValue).toLocaleString('en-AU', { maximumFractionDigits: 0 }),
            });
          }
          
          // Weekly Rent — always include prominently
          if (income?.weeklyRent) {
            row1.push({
              label: 'Weekly Rent',
              value: '$' + Number(income.weeklyRent).toLocaleString('en-AU', { maximumFractionDigits: 0 }),
              subtitle: 'Current market rate',
            });
          }
          
          // LVR
          if (keyMetrics?.lvr) {
            row1.push({
              label: 'LVR',
              value: Number(keyMetrics.lvr).toFixed(1) + '%',
              subtitle: 'Loan-to-Value Ratio',
            });
          }
          
          // Gross Yield
          if (keyMetrics?.grossYield) {
            row1.push({
              label: 'Gross Yield',
              value: Number(keyMetrics.grossYield).toFixed(2) + '%',
              subtitle: 'Annual rental return',
            });
          }
          
          // Net Yield (overflow to ensure we capture it)
          if (keyMetrics?.netRentalYield && row1.length < 4) {
            row1.push({
              label: 'Net Yield',
              value: Number(keyMetrics.netRentalYield).toFixed(2) + '%',
              subtitle: 'After all costs',
            });
          }
          
          // Capital Growth (overflow)
          if (assumptions?.capitalGrowth && row1.length < 4) {
            row1.push({
              label: 'Capital Growth',
              value: Number(assumptions.capitalGrowth).toFixed(1) + '%',
              subtitle: 'Annual forecast',
            });
          }

          if (row1.length < 2) return null;

          // ─── Row 2: Demographic KPIs ───
          const row2: Array<{ label: string; value: string; subtitle?: string }> = [];
          
          // Extract demographic data from absData
          const demographics = absData?.demographics || absData?.populationData || absData;
          
          // Population
          const population = demographics?.population || demographics?.totalPopulation || demographics?.total_population;
          if (population) {
            row2.push({
              label: 'Population',
              value: Number(population).toLocaleString('en-AU', { maximumFractionDigits: 0 }),
              subtitle: 'Local area',
            });
          }
          
          // Median Age
          const medianAge = demographics?.medianAge || demographics?.median_age;
          if (medianAge) {
            row2.push({
              label: 'Median Age',
              value: String(Math.round(Number(medianAge))),
              subtitle: 'Years',
            });
          }
          
          // Median Income
          const medianIncome = demographics?.medianIncome || demographics?.median_income || demographics?.medianHouseholdIncome || demographics?.median_household_income;
          if (medianIncome) {
            row2.push({
              label: 'Median Income',
              value: '$' + Number(medianIncome).toLocaleString('en-AU', { maximumFractionDigits: 0 }),
              subtitle: 'Household p.a.',
            });
          }
          
          // Median House Price (bonus demographic)
          const medianHousePrice = demographics?.medianHousePrice || demographics?.median_house_price;
          if (medianHousePrice && row2.length < 4) {
            row2.push({
              label: 'Median House Price',
              value: '$' + Number(medianHousePrice).toLocaleString('en-AU', { maximumFractionDigits: 0 }),
              subtitle: 'Local market',
            });
          }
          
          return { row1: row1.slice(0, 4), row2: row2.length >= 2 ? row2.slice(0, 4) : undefined };
        }
        
        return null;
      };


      const parseMarkdownText = (text: string): Array<{text: string, bold: boolean, italic: boolean}> => {
        // Strip emojis first to prevent encoding errors
        text = stripEmojis(text);
        const parts: Array<{text: string, bold: boolean, italic: boolean}> = [];
        let remaining = text
          .replace(/^#{1,6}\s+/gm, '') // Remove markdown headers
          .replace(/^[\*\-\+]\s+/gm, '• ') // Convert markdown bullets
          .replace(/^\d+\.\s+/gm, '') // Remove numbered lists
          .replace(/^>\s+/gm, '') // Remove blockquotes
          .replace(/`{1,3}(.*?)`{1,3}/g, '$1') // Remove code formatting
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // Remove links, keep text

        // Parse bold and italic
        const boldItalicRegex = /\*\*\*(.*?)\*\*\*/g;
        const boldRegex = /\*\*(.*?)\*\*/g;
        const italicRegex = /\*(.*?)\*/g;

        let lastIndex = 0;
        const segments: Array<{text: string, start: number, end: number, bold: boolean, italic: boolean}> = [];

        // Find all bold+italic
        let match;
        while ((match = boldItalicRegex.exec(remaining)) !== null) {
          segments.push({text: match[1], start: match.index, end: match.index + match[0].length, bold: true, italic: true});
        }

        // Find all bold
        boldItalicRegex.lastIndex = 0;
        remaining = text
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/^[\*\-\+]\s+/gm, '• ')
          .replace(/^\d+\.\s+/gm, '')
          .replace(/^>\s+/gm, '')
          .replace(/`{1,3}(.*?)`{1,3}/g, '$1')
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
        
        while ((match = boldRegex.exec(remaining)) !== null) {
          // Don't overlap with bold+italic
          if (!segments.some(s => match.index >= s.start && match.index < s.end)) {
            segments.push({text: match[1], start: match.index, end: match.index + match[0].length, bold: true, italic: false});
          }
        }

        // Find all italic
        boldRegex.lastIndex = 0;
        while ((match = italicRegex.exec(remaining)) !== null) {
          // Don't overlap with bold or bold+italic
          if (!segments.some(s => match.index >= s.start && match.index < s.end)) {
            segments.push({text: match[1], start: match.index, end: match.index + match[0].length, bold: false, italic: true});
          }
        }

        // Sort segments by position
        segments.sort((a, b) => a.start - b.start);

        // Build parts array with normal text between segments
        segments.forEach((seg, i) => {
          // Add normal text before this segment
          if (seg.start > lastIndex) {
            const normalText = remaining.substring(lastIndex, seg.start)
              .replace(/\*\*\*/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
            if (normalText) parts.push({text: normalText, bold: false, italic: false});
          }
          // Add formatted segment
          parts.push({text: seg.text, bold: seg.bold, italic: seg.italic});
          lastIndex = seg.end;
        });

        // Add remaining normal text
        if (lastIndex < remaining.length) {
          const normalText = remaining.substring(lastIndex)
            .replace(/\*\*\*/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
          if (normalText) parts.push({text: normalText, bold: false, italic: false});
        }

        // If no formatting found, return whole text as normal
        if (parts.length === 0) {
          parts.push({text: remaining.replace(/\*\*\*/g, '').replace(/\*\*/g, '').replace(/\*/g, ''), bold: false, italic: false});
        }

        return parts;
      };

      // Helper to calculate text height without drawing
      const calculateTextHeight = (text: string, maxWidth: number, normalFont: any, boldFont: any, size: number, lineSpacing: number): number => {
        const sanitizedText = stripEmojis(text); // Sanitize text first
        const parts = parseMarkdownText(sanitizedText);
        let lines = 1;
        let currentLineWidth = 0;
        
        for (const part of parts) {
          const words = part.text.split(' ');
          const font = part.bold ? boldFont : normalFont;
          
          for (const word of words) {
            const wordWithSpace = word + ' ';
            const wordWidth = font.widthOfTextAtSize(wordWithSpace, size);
            
            if (currentLineWidth + wordWidth > maxWidth && currentLineWidth > 0) {
              lines++;
              currentLineWidth = wordWidth;
            } else {
              currentLineWidth += wordWidth;
            }
          }
        }
        
        return lines * lineSpacing;
      };

      // Helper to draw text with word wrapping, markdown formatting, and JUSTIFIED alignment
      const drawTextWithWrap = (page: any, text: string, x: number, startY: number, maxWidth: number, normalFont: any, boldFont: any, size: number, lineSpacing: number, align: 'left' | 'justify' = 'justify') => {
        // Sanitize text: strip emojis AND fix AI content issues (word merges, duplicates)
        const sanitizedText = sanitizeAIContent(stripEmojis(text));
        const parts = parseMarkdownText(sanitizedText);
        let currentY = startY;
        
        // Collect all words with their fonts first
        const allWords: Array<{word: string, font: any}> = [];
        for (const part of parts) {
          const words = part.text.split(' ').filter(w => w.length > 0);
          const font = part.bold ? boldFont : normalFont;
          for (const word of words) {
            allWords.push({ word, font });
          }
        }
        
        // Build lines for text wrapping
        type LineData = { words: Array<{word: string, font: any}>, totalWidth: number };
        const lines: LineData[] = [];
        let currentLine: LineData = { words: [], totalWidth: 0 };
        const spaceWidth = normalFont.widthOfTextAtSize(' ', size);
        
        for (let i = 0; i < allWords.length; i++) {
          const { word, font } = allWords[i];
          const wordWidth = font.widthOfTextAtSize(word, size);
          
          // Handle words that are wider than maxWidth by breaking them
          if (wordWidth > maxWidth) {
            const brokenParts = breakLongWord(word, maxWidth, font, size);
            for (const part of brokenParts) {
              const partWidth = font.widthOfTextAtSize(part, size);
              if (currentLine.words.length > 0) {
                lines.push(currentLine);
              }
              currentLine = { words: [{ word: part, font }], totalWidth: partWidth };
            }
            continue;
          }
          
          const neededWidth = currentLine.words.length > 0 ? wordWidth + spaceWidth : wordWidth;
          
          if (currentLine.totalWidth + neededWidth > maxWidth && currentLine.words.length > 0) {
            // Line is full, push and start new line
            lines.push(currentLine);
            currentLine = { words: [{ word, font }], totalWidth: wordWidth };
          } else {
            currentLine.words.push({ word, font });
            currentLine.totalWidth += neededWidth;
          }
        }
        // Push the last line
        if (currentLine.words.length > 0) {
          lines.push(currentLine);
        }
        
        // Draw each line with appropriate alignment
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          const isLastLine = lineIndex === lines.length - 1;
          
          // Check if we need a new page
          if (currentY < bottomMargin + 40) {
            // CRITICAL FIX: Do NOT drop the rest of the paragraph.
            // Return the remaining text as markdown parts so the caller can continue on the next page.
            const remainingWords = lines
              .slice(lineIndex)
              .flatMap(l => l.words);

            // Reconstruct a markdown-ish string that preserves bold styling (italic is not rendered anyway).
            const remainingText = remainingWords
              .map(({ word, font }) => (font === boldFont ? `**${word}**` : word))
              .join(' ');

            return {
              needsNewPage: true,
              lastY: currentY,
              remainingParts: parseMarkdownText(remainingText),
            };
          }
          
          // For left alignment OR single word OR last line of justified text - use left alignment
          if (align === 'left' || line.words.length === 1 || isLastLine) {
            let drawX = x;
            for (const { word, font } of line.words) {
              page.drawText(word, {
                x: drawX,
                y: currentY,
                size,
                font,
                color: rgb(0.2, 0.2, 0.2),
              });
              drawX += font.widthOfTextAtSize(word + ' ', size);
            }
          } else {
            // Multiple words, not last line, justify alignment - distribute space evenly
            const totalWordsWidth = line.words.reduce((sum, { word, font }) => 
              sum + font.widthOfTextAtSize(word, size), 0);
            const extraSpace = maxWidth - totalWordsWidth;
            const spaceBetween = extraSpace / (line.words.length - 1);
            
            let drawX = x;
            for (let wi = 0; wi < line.words.length; wi++) {
              const { word, font } = line.words[wi];
              page.drawText(word, {
                x: drawX,
                y: currentY,
                size,
                font,
                color: rgb(0.2, 0.2, 0.2),
              });
              drawX += font.widthOfTextAtSize(word, size) + spaceBetween;
            }
          }
          
          currentY -= lineSpacing;
        }

        return { needsNewPage: false, lastY: currentY, remainingParts: [] };
      };

      // Get ALL sections from the report dynamically instead of hardcoded list
      // Filter out meta/cover/contents entries that should never appear as numbered TOC items
      const META_SECTION_PATTERNS: RegExp[] = [
        /^cover\s*page?$/i,
        /^cover$/i,
        /^contents?$/i,
        /^table\s+of\s+contents$/i,
        /^reading\s+guide$/i,
        /^naidu/i,
        /^title\s*page$/i,
        /^disclaimer$/i,
        /^back\s*cover$/i,
      ];
      // Compass / Compass-40 only: financial-leak sections that must never render.
      // These are still valid for the Financial Analysis tier.
      if (reportTier !== 'financial') {
        META_SECTION_PATTERNS.push(
          /^investment\s+highlights$/i,
          /^key\s+findings$/i,
          /^headline\s+scores?$/i,
          /^overall\s+investment\s+profile$/i,
          /^investment\s+score\s+analysis$/i,
          /^macro\s+investment\s+scorecard$/i,
          /^property\s+snapshot\s*[-–—]\s*non[-\s]?financial$/i,
        );
      }

      // Collapse adjacent repeated words/phrases that occasionally appear in
      // model-generated headings (e.g. "Industry 4 Industry & Employment",
      // "Amenity Amenity & Livability", "SEIFA IFA", "Key Strengths Key Strengths").
      const dedupeRepeatedWords = (s: string): string => {
        if (!s) return s;
        let out = s;
        out = out.replace(/\b(\w+)\s+\d+\s+\1\b/gi, '$1');
        out = out.replace(/\b((?:\w+\s+){1,3}\w+)\s+\d+\s+\1\b/gi, '$1');
        for (let i = 0; i < 2; i++) {
          out = out.replace(/\b((?:\w+\s+){0,3}\w+)\s+\1\b/gi, '$1');
        }
        out = out.replace(/(\b\w+\b)\s*,\s*\1\b/gi, '$1');
        out = out.replace(/\b(\w*?)(\w{3,})\s+\2\b/gi, '$1$2');
        return out.replace(/\s{2,}/g, ' ').trim();
      };
      const isMetaSectionName = (raw: string) => {
        const cleaned = dedupeRepeatedWords(raw
          .replace(/^#{1,6}\s*/, '')
          .replace(/^\d+(\.\d+)*\.?\s+/, '')
          .replace(/:\s*$/, '')
          .trim());
        return META_SECTION_PATTERNS.some((p) => p.test(cleaned));
      };
      // De-duplicate sections that the model produces twice (e.g. "Property
      // Snapshot" appears once on its own and once as "Property Snapshot —
      // Non-Financial"). Keep the first occurrence of each canonical name.
      const seenCanonical = new Set<string>();
      const seenTopic = new Set<string>();
      const topicOf = (name: string): string | null => {
        const n = name.toLowerCase();
        if (/\b(transport|connectivity|commute|rail access|road network|public transport)\b/.test(n)) return 'transport';
        if (/\bpopulation\s+(growth|trends|&|and)\b/.test(n)) return 'population';
        if (/\bfuture\s+infrastructure\b/.test(n)) return 'infrastructure';
        return null;
      };
      const allSectionNames = Object.keys(sections).filter(name => {
        if (!name || !sections[name] || sections[name].trim().length < 40) return false;
        if (isMetaSectionName(name)) return false;
        const canonical = dedupeRepeatedWords(name
          .replace(/^#{1,6}\s*/, '')
          .replace(/^\d+(\.\d+)*\.?\s+/, '')
          .replace(/:\s*$/, '')
          .trim()).toLowerCase();
        if (seenCanonical.has(canonical)) return false;
        seenCanonical.add(canonical);
        // Fuzzy topic dedup — only one H2 per topic group (Compass tier only).
        if (reportTier !== 'financial') {
          const t = topicOf(canonical);
          if (t) {
            if (seenTopic.has(t)) return false;
            seenTopic.add(t);
          }
        }
        return true;
      });


      console.log('Found sections to include in PDF:', allSectionNames);
      
      // Track section page numbers as we render (used for TOC in compass tier)
      const sectionPageNumbers: Map<string, number> = new Map();
      
      // ========== DYNAMIC TABLE OF CONTENTS - TWO-PASS APPROACH ==========
      // Only generate TOC for 'compass' tier (full Investor Compass reports)
      // Skip TOC for 'briefing' (Executive Brief) and 'snapshot' (Snapshot) tiers
      const shouldIncludeTOC = reportTier === 'compass';
      const tocPageIndices: number[] = [];
      
      if (shouldIncludeTOC) {
        console.log('📑 Step 5.0.5: Preparing dynamic Table of Contents (compass tier)...');
        
        // Reserve TOC pages (we'll come back and fill them in after rendering content)
        // Estimate 1-2 pages for TOC based on section count
        const tocEntriesPerPage = 28; // Approximate entries per TOC page
        const estimatedTocPages = Math.ceil(allSectionNames.length / tocEntriesPerPage);
        
        // Store the TOC page indices so we can draw on them later
        for (let i = 0; i < estimatedTocPages; i++) {
          currentPage = await addContentPage();
          tocPageIndices.push(pdfDoc.getPageCount() - 1);
        }
        
        console.log(`✓ Reserved ${estimatedTocPages} TOC page(s) at indices:`, tocPageIndices);
      } else {
        console.log(`📑 Step 5.0.5: Skipping TOC (${reportTier} tier does not require TOC)`);
      }
      
      // Content rendering starts AFTER TOC pages (if any)
      // The page number display will account for: cover (1) + TOC pages + content pages
      const contentStartPageIndex = pdfDoc.getPageCount();
      console.log(`📄 Content will start at page index ${contentStartPageIndex}`);
      
      // ========== END TOC RESERVATION ==========

      // Add content start page with report title
      currentPage = await addContentPage();
      yPosition = pageHeight - topMargin - 20;

      // Use the property address directly as the title (which admins can edit)
      // For different tiers, use appropriate prefix
      const tierPrefix = reportTier === 'compass' ? 'Investment Report' : 
                         reportTier === 'briefing' ? 'Executive Brief' : 
                         reportTier === 'financial' ? 'Financial Analysis' : 'Snapshot Report';
      const titleText = stripEmojis(`${tierPrefix}: ${report.address}`);
      let titleResult = drawTextWithWrap(
        currentPage,
        `**${titleText}**`,
        margin,
        yPosition,
        pageWidth - 2 * margin,
        helveticaFont,
        helveticaBold,
        18,
        24,
        'left' // Report title should be left-aligned
      );
      if (titleResult.needsNewPage) {
        currentPage = await addContentPage();
        yPosition = pageHeight - topMargin - 20;
        titleResult = drawTextWithWrap(
          currentPage,
          `**${titleText}**`,
          margin,
          yPosition,
          pageWidth - 2 * margin,
          helveticaFont,
          helveticaBold,
          18,
          24,
          'left' // Report title should be left-aligned
        );
      }
      yPosition = titleResult.lastY - 25;
      
      console.log('✏️ Step 5.1: Starting to render', allSectionNames.length, 'sections...');

      let sectionCount = 0;
      for (const sectionName of allSectionNames) {
        sectionCount++;
        let content = sections[sectionName];
        if (!content) continue;

        // Strip orphan "What This Means:" labels with no body before next heading/EOF.
        content = content.replace(
          /(^|\n)(?:>\s*)?\**\s*(?:#{1,4}\s*)?(?:WHAT\s+THIS\s+MEANS|What\s+This\s+Means)\s*:?\s*\**\s*(?=\n\s*(?:#{1,4}\s|$))/g,
          '$1'
        );
        // Strip leftover [citation] / (citation) tokens that slipped past the edge sanitizer.
        content = content
          .replace(/\[(citation(?:\s+needed)?|source(?:\s+needed)?|TBD|placeholder)\]/gi, '')
          .replace(/\((citation(?:\s+needed)?|source(?:\s+needed)?|TBD|placeholder)\)/gi, '')
          .replace(/\[\d+\](?:\[\d+\])*/g, '');


        // Clean section name and strip emojis + dedupe repeated word/phrase artefacts
        const cleanSectionName = dedupeRepeatedWords(stripEmojis(
          sectionName
            .replace(/^#{1,6}\s*/, '')
            .replace(/:\s*$/, '')
            .trim()
        ));

        
        console.log(`  📝 Section ${sectionCount}/${allSectionNames.length}: "${cleanSectionName}"`);

        // Calculate total height needed for this section
        const paragraphs = groupContentBlocks(content);
        console.log(`     → ${paragraphs.length} content blocks`);
        const sectionTitleHeight = 30;
        let totalContentHeight = 0;
        
        // Calculate height of first content block (to ensure it stays with heading)
        let firstBlockHeight = 0;
        
        for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
          const paragraph = paragraphs[pIdx];
          if (!paragraph.trim()) continue;
          
          let blockHeight = 0;
          
          // Check for horizontal rule
          if (paragraph.trim().match(/^-{3,}$/)) {
            blockHeight = 20;
          } else if (isMarkdownTable(paragraph)) {
            // Estimate table height: count rows and multiply by row height
            const tableLines = paragraph.split('\n').filter(l => l.trim() && !l.match(/^[\|\s\-:]+$/));
            blockHeight = tableLines.length * (textSize + 12) + 16; // row height + padding
          } else {
            // Regular text - calculate height normally
            blockHeight = calculateTextHeight(
              paragraph,
              pageWidth - 2 * margin,
              helveticaFont,
              helveticaBold,
              textSize,
              lineHeight
            ) + 8; // paragraph spacing
          }
          
          totalContentHeight += blockHeight;
          
          // Capture first meaningful block height (skip horizontal rules)
          if (firstBlockHeight === 0 && !paragraph.trim().match(/^-{3,}$/)) {
            firstBlockHeight = blockHeight;
          }
        }
        
        const totalSectionHeight = sectionTitleHeight + totalContentHeight + 15; // section spacing
        
        // IMPROVED PAGE BREAK LOGIC:
        // 1. SKIP page break logic for first section (it should stay with report title)
        // 2. Check for forced page break sections 
        // 3. Minimum content with heading = title + first content block (at least 120px)
        // 4. Never leave a heading orphaned at the bottom of a page
        const cleanSectionLower = cleanSectionName.toLowerCase();
        const shouldForceNewPage = FORCED_NEW_PAGE_SECTIONS.some(section => 
          cleanSectionLower.includes(section)
        );
        
        // First section should stay on the same page as the report title (no page break)
        const isFirstSection = sectionCount === 1;
        
        if (isFirstSection) {
          // Keep first section with the title - no page break
          console.log(`     → First section: keeping with report title (no page break)`);
        } else if (shouldForceNewPage) {
          console.log(`     → FORCED page break for section: "${cleanSectionName}"`);
          currentPage = await addContentPage();
          yPosition = pageHeight - topMargin - 20;
        } else {
          const minContentWithHeading = Math.max(sectionTitleHeight + firstBlockHeight + 30, 150);
          const remainingSpace = yPosition - bottomMargin;
          
          // Force new page if we can't fit heading + first content block together
          if (remainingSpace < minContentWithHeading) {
            console.log(`     → Page break: only ${Math.round(remainingSpace)}px remaining, need ${Math.round(minContentWithHeading)}px for heading + first block`);
            currentPage = await addContentPage();
            yPosition = pageHeight - topMargin - 20;
          }
          // Or if entire section fits and current space is tight, start fresh
          else if (totalSectionHeight < (pageHeight - topMargin - bottomMargin - 100) && 
              yPosition - totalSectionHeight < bottomMargin + 40) {
            console.log(`     → Page break: section fits on new page (${Math.round(totalSectionHeight)}px), starting fresh`);
            currentPage = await addContentPage();
            yPosition = pageHeight - topMargin - 20;
          }
        }

        // TRACK SECTION PAGE NUMBER for TOC
        // Record which page this section starts on (1-indexed for display)
        const currentPageNumber = pdfDoc.getPageCount(); // Current page we're about to draw on
        sectionPageNumbers.set(cleanSectionName, currentPageNumber);

        // ─── Premium Section Header: Gold accent bar + Navy text ───────────
        // Draw gold accent bar on the left
        currentPage.drawRectangle({
          x: margin - 8,
          y: yPosition - 6,
          width: 3,
          height: 18,
          color: GOLD_RGB,
        });
        
        // Draw subtle gold underline below the section title area
        const sectionTitleClean = stripEmojis(cleanSectionName);
        const sectionTitleWidth = helveticaBold.widthOfTextAtSize(sectionTitleClean, titleSize);
        
        // Draw section title in navy
        let titleResult = drawTextWithWrap(
          currentPage,
          `**${stripEmojis(cleanSectionName)}**`,
          margin,
          yPosition,
          pageWidth - 2 * margin,
          helveticaFont,
          helveticaBold,
          titleSize,
          20,
          'left' // Section headings should be left-aligned
        );
        
        // Draw gold underline after title
        currentPage.drawLine({
          start: { x: margin, y: titleResult.lastY + 6 },
          end: { x: margin + Math.min(sectionTitleWidth + 20, pageWidth - 2 * margin), y: titleResult.lastY + 6 },
          thickness: 1,
          color: GOLD_RGB,
        });
        
        if (titleResult.needsNewPage) {
          currentPage = await addContentPage();
          yPosition = pageHeight - topMargin - 20;
          
          // Re-draw accent bar on new page
          currentPage.drawRectangle({
            x: margin - 8,
            y: yPosition - 6,
            width: 3,
            height: 18,
            color: GOLD_RGB,
          });
          
          titleResult = drawTextWithWrap(
            currentPage,
            `**${stripEmojis(cleanSectionName)}**`,
            margin,
            yPosition,
            pageWidth - 2 * margin,
            helveticaFont,
            helveticaBold,
            titleSize,
            20,
            'left'
          );
          
          // Draw gold underline on new page
          currentPage.drawLine({
            start: { x: margin, y: titleResult.lastY + 6 },
            end: { x: margin + Math.min(sectionTitleWidth + 20, pageWidth - 2 * margin), y: titleResult.lastY + 6 },
            thickness: 1,
            color: GOLD_RGB,
          });
        }
        yPosition = titleResult.lastY - 10;

        // ─── KPI Boxes: Render gold-bordered metric cards for qualifying sections ───
        const kpiMetrics = extractKPIMetrics(cleanSectionName, content, report.enhanced_data);
        if (kpiMetrics) {
          // Row 1: Financial KPIs (need ~80px)
          const totalKPIHeight = kpiMetrics.row2 ? 170 : 80;
          if (yPosition - totalKPIHeight < bottomMargin + 40) {
            currentPage = await addContentPage();
            yPosition = pageHeight - topMargin - 20;
          }
          yPosition = drawKPIBoxes(currentPage, yPosition, kpiMetrics.row1, pageWidth - 2 * margin);
          console.log(`     ✓ Rendered ${kpiMetrics.row1.length} financial KPI boxes for "${cleanSectionName}"`);
          
          // Row 2: Demographic KPIs
          if (kpiMetrics.row2) {
            if (yPosition - 80 < bottomMargin + 40) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
            }
            // Draw a small "Demographics" label above row 2
            currentPage.drawText('DEMOGRAPHIC SNAPSHOT', {
              x: margin,
              y: yPosition - 5,
              size: 7,
              font: helveticaBold,
              color: GOLD_RGB,
            });
            yPosition -= 15;
            yPosition = drawKPIBoxes(currentPage, yPosition, kpiMetrics.row2, pageWidth - 2 * margin);
            console.log(`     ✓ Rendered ${kpiMetrics.row2.length} demographic KPI boxes for "${cleanSectionName}"`);
          }
        }

        // Draw paragraphs with header-table grouping
        for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
          const paragraph = paragraphs[pIdx];
          if (!paragraph.trim()) continue;
          
          // Check if this paragraph is a header that should stay with its table
          const paragraphLower = paragraph.toLowerCase().replace(/\*\*/g, '').trim();
          const isKeepWithTableHeader = KEEP_WITH_TABLE_HEADERS.some(header => 
            paragraphLower.includes(header)
          );
          
          // If this is a "keep with table" header, check if next paragraph is a table
          if (isKeepWithTableHeader && pIdx + 1 < paragraphs.length) {
            const nextParagraph = paragraphs[pIdx + 1];
            if (isMarkdownTable(nextParagraph)) {
              // Calculate combined height of header + table
              const headerHeight = calculateTextHeight(
                paragraph, pageWidth - 2 * margin, helveticaFont, helveticaBold, textSize, lineHeight
              ) + 16;
              const tableHeight = calculateTableHeight(
                nextParagraph, pageWidth - 2 * margin, helveticaFont, helveticaBold, textSize
              );
              const combinedHeight = headerHeight + tableHeight + 20;
              const availableSpace = yPosition - bottomMargin - PAGE_BREAK_CONFIG.TABLE_SAFETY_MARGIN;
              
              // If combined doesn't fit but WOULD fit on new page, move to new page
              if (combinedHeight > availableSpace && combinedHeight <= (pageHeight - topMargin - bottomMargin - 40)) {
                console.log(`     → Keeping header "${paragraphLower.substring(0, 30)}..." with its table (${Math.round(combinedHeight)}px)`);
                currentPage = await addContentPage();
                yPosition = pageHeight - topMargin - 20;
              }
            }
          }

          // Check for rank heading marker (___RANK_HEADING___) - used for comparison analysis rankings
          const isRankHeading = paragraph.includes('___RANK_HEADING___');
          if (isRankHeading) {
            // Remove the marker and get the actual heading text
            const rankText = paragraph.replace('___RANK_HEADING___', '').trim();
            
            // Force page break if we're below 200px from bottom (ensure rank + its content fits together)
            if (yPosition < bottomMargin + 200) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
            }
            
            // Draw rank heading with larger font size (14pt vs 10pt for normal text)
            const rankHeadingSize = 13;
            const cleanRankText = stripEmojis(rankText.replace(/\*\*/g, ''));
            
            // Draw the text (bold)
            currentPage.drawText(cleanRankText, {
              x: margin,
              y: yPosition,
              size: rankHeadingSize,
              font: helveticaBold,
              color: NAVY_RGB,
            });
            
            // Calculate text width for underline
            const textWidth = helveticaBold.widthOfTextAtSize(cleanRankText, rankHeadingSize);
            
            // Draw underline below the text (gold)
            currentPage.drawLine({
              start: { x: margin, y: yPosition - 3 },
              end: { x: margin + textWidth, y: yPosition - 3 },
              thickness: 1,
              color: GOLD_RGB,
            });
            
            yPosition -= (rankHeadingSize + 12); // Space after rank heading
            continue;
          }

          // ─── Callout Panel: Detect "What This Means" paragraphs ───────────
          const calloutCheck = isCalloutParagraph(paragraph);
          if (calloutCheck.isCallout) {
            // Empty body: try to absorb the next paragraph as the body (model often emits the
            // label as its own paragraph then the prose after a blank line).
            if (!calloutCheck.content || calloutCheck.content.length < 15) {
              const next = paragraphs[pIdx + 1]?.trim() ?? '';
              const nextIsStructural =
                !next ||
                next.startsWith('#') ||
                next.startsWith('|') ||
                next.startsWith('- ') ||
                next.startsWith('* ') ||
                /^-{3,}$/.test(next) ||
                isCalloutParagraph(next).isCallout;
              if (next && !nextIsStructural && next.length >= 15) {
                calloutCheck.content = next.replace(/^\*+|\*+$/g, '').trim();
                pIdx += 1; // consume the absorbed paragraph
              } else {
                console.log('     ⏭ Skipping empty/junk "What This Means" callout');
                continue;
              }
            }
            console.log('     ✓ Detected callout paragraph, rendering styled panel');
            let calloutResult = drawCalloutPanel(
              currentPage,
              calloutCheck.content,
              yPosition,
              pageWidth - 2 * margin
            );
            if (calloutResult.needsNewPage) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
              calloutResult = drawCalloutPanel(
                currentPage,
                calloutCheck.content,
                yPosition,
                pageWidth - 2 * margin
              );
            }
            yPosition = calloutResult.lastY;
            continue;
          }

          // Check for horizontal rule (---)
          if (paragraph.trim().match(/^-{3,}$/)) {
            // Check if we need a new page
            if (yPosition < bottomMargin + 60) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
            }
            yPosition = drawHorizontalRule(currentPage, margin, yPosition - 10, pageWidth - 2 * margin);
            continue;
          }

          // Check if paragraph is a markdown table (but skip contact sections)
          if (isMarkdownTable(paragraph) && !cleanSectionName.toLowerCase().includes('contact')) {
            console.log('     ✓ Detected markdown table, rendering...');
            try {
              // SMART PAGE BREAKING FOR TABLES
              // Calculate the full table height BEFORE drawing
              const estimatedTableHeight = calculateTableHeight(
                paragraph,
                pageWidth - 2 * margin,
                helveticaFont,
                helveticaBold,
                textSize
              );
              
              const availableSpace = yPosition - bottomMargin - PAGE_BREAK_CONFIG.TABLE_SAFETY_MARGIN;
              const canFitOnCurrentPage = estimatedTableHeight <= availableSpace;
              const canFitOnNewPage = estimatedTableHeight <= (pageHeight - topMargin - bottomMargin - 40);
              
              console.log(`     📊 Table height analysis:`, {
                estimatedHeight: Math.round(estimatedTableHeight),
                availableSpace: Math.round(availableSpace),
                canFitOnCurrentPage,
                canFitOnNewPage,
                preferFullTables: PAGE_BREAK_CONFIG.PREFER_FULL_TABLES
              });
              
              // If PREFER_FULL_TABLES is true and table won't fit on current page but will fit on new page
              // Move the ENTIRE table to a new page rather than splitting
              if (PAGE_BREAK_CONFIG.PREFER_FULL_TABLES && !canFitOnCurrentPage && canFitOnNewPage) {
                console.log('     → Moving entire table to new page (smart page break)');
                currentPage = await addContentPage();
                yPosition = pageHeight - topMargin - 20;
              } else if (yPosition < bottomMargin + PAGE_BREAK_CONFIG.MIN_SPACE_FOR_TABLE) {
                // Minimal space check - always start new page if less than minimum threshold
                currentPage = await addContentPage();
                yPosition = pageHeight - topMargin - 20;
              }

              // Render tables across pages if needed.
              let tableToRender = paragraph;
              let guard = 0;
              while (guard < 20) {
                guard++;
                const tableResult = drawTable(
                  currentPage,
                  tableToRender,
                  margin,
                  yPosition,
                  pageWidth - 2 * margin,
                  helveticaFont,
                  helveticaBold,
                  textSize
                );

                if (tableResult.needsNewPage) {
                  currentPage = await addContentPage();
                  yPosition = pageHeight - topMargin - 20;
                  if (tableResult.remainingTableText && tableResult.remainingTableText.trim().length > 0) {
                    tableToRender = tableResult.remainingTableText;
                    continue;
                  }
                  // Safety: if we can't compute remaining content, stop to avoid infinite loops.
                  break;
                }

                yPosition = tableResult.lastY;
                break;
              }
              console.log('     ✓ Table rendered successfully with smart page breaking');
            } catch (tableError) {
              console.error('     ❌ Error rendering table:', tableError);
              console.error('     Table content:', paragraph.substring(0, 200));
              throw tableError;
            }
            continue;
          }

          // Regular paragraph with text wrapping
          let remainingParts = parseMarkdownText(paragraph);
          
          // Detect if this paragraph is an H3/H4 subsection heading
          const isSubsectionHeading = paragraph.trim().match(/^#{3,4}\s+/);
          const paragraphAlignment: 'left' | 'justify' = isSubsectionHeading ? 'left' : 'justify';
          
          while (remainingParts.length > 0) {
            // Check if we need a new page before starting paragraph
            if (yPosition < bottomMargin + 60) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
            }

            const paragraphText = remainingParts.map(p => {
              if (p.bold && p.italic) return `***${p.text}***`;
              if (p.bold) return `**${p.text}**`;
              if (p.italic) return `*${p.text}*`;
              return p.text;
            }).join('');

            const result = drawTextWithWrap(
              currentPage,
              paragraphText,
              margin,
              yPosition,
              pageWidth - 2 * margin,
              helveticaFont,
              helveticaBold,
              textSize,
              lineHeight,
              paragraphAlignment // Left-align H3/H4 headings, justify body text
            );

            if (result.needsNewPage) {
              currentPage = await addContentPage();
              yPosition = pageHeight - topMargin - 20;
              remainingParts = result.remainingParts;
            } else {
              yPosition = result.lastY;
              remainingParts = [];
            }
          }

          yPosition -= 6; // Tighter spacing between paragraphs
        }

        yPosition -= 10; // Reduced spacing between sections
      }

      // ========== SECOND PASS: DRAW TABLE OF CONTENTS WITH ACTUAL PAGE NUMBERS ==========
      // Only draw TOC for compass tier
      if (shouldIncludeTOC && tocPageIndices.length > 0) {
        console.log('📑 Step 5.4: Drawing Table of Contents with actual page numbers...');
        console.log(`   Section page mappings:`, Object.fromEntries(sectionPageNumbers));
        
        // Draw TOC on the reserved pages
        let tocPageIdx = 0;
        let tocPage = pdfDoc.getPages()[tocPageIndices[tocPageIdx]];
        let tocY = pageHeight - topMargin - 20;
        
        // TOC Title - Navy with gold accent
        const tocTitleText = 'TABLE OF CONTENTS';
        tocPage.drawText(tocTitleText, {
          x: margin,
          y: tocY,
          size: 20,
          font: helveticaBold,
          color: NAVY_RGB,
        });
        tocY -= 40;
        
        // Draw gold decorative line under title
        tocPage.drawLine({
          start: { x: margin, y: tocY + 15 },
          end: { x: pageWidth - margin, y: tocY + 15 },
          thickness: 2,
          color: GOLD_RGB,
        });
        tocY -= 25;
        
        // Draw TOC entries with hierarchical numbering
        // Pure sequential counters - no metadata lookup needed
        let h2Index = 0;
        let h3Index = 0;
        
        for (const sectionName of allSectionNames) {
          // sectionName is already cleaned (no ## or ### prefix) - it's the key from sections object
          const cleanName = dedupeRepeatedWords(stripEmojis(
            sectionName
              .replace(/^#{1,6}\s*/, '') // Remove markdown heading prefix (if any remaining)
              .replace(/^\d+(\.\d+)*\.?\s+/, '') // Remove all numbered prefixes (e.g., "1 ", "1. ", "11.1 ")
              .replace(/:\s*$/, '') // Remove trailing colon
              .trim()
          ));

          
          if (!cleanName || cleanName.length < 3) continue;
          
          // Use the sectionMetadata populated during parsing to get the correct level
          // The sectionName IS the key used in sectionMetadata (both come from sections object)
          const metadata = sectionMetadata.current.get(sectionName);
          const sectionLevel = metadata?.level ?? 2; // Default to H2 if not found
          
          // Update numbering based on hierarchy - pure sequential counters
          let sectionNumText: string;
          let indentation: number;
          let fontSize: number;
          let fontToUse: typeof helveticaFont;
          
          if (sectionLevel === 2) {
            // H2 = Main section
            h2Index++;
            h3Index = 0; // Reset subsection counter for new H2
            sectionNumText = `${h2Index}.`;
            indentation = 0;
            fontSize = 11;
            fontToUse = helveticaBold;
          } else {
            // H3 = Subsection - simple sequential increment
            h3Index++;
            sectionNumText = `${h2Index}.${h3Index}`;
            indentation = 15; // Indent subsections
            fontSize = 10;
            fontToUse = helveticaFont;
          }
          
          // Check if we need to move to next TOC page
          if (tocY < bottomMargin + 40) {
            tocPageIdx++;
            if (tocPageIdx < tocPageIndices.length) {
              tocPage = pdfDoc.getPages()[tocPageIndices[tocPageIdx]];
              tocY = pageHeight - topMargin - 20;
            }
          }
          
          // Get the actual page number for this section
          const actualPageNumber = sectionPageNumbers.get(cleanName) || 0;
          
          // Draw section number with gold accent
          tocPage.drawText(sectionNumText, {
            x: margin + indentation,
            y: tocY,
            size: fontSize,
            font: fontToUse,
            color: GOLD_RGB,
          });
          
          // Calculate number text width for positioning
          const numWidth = fontToUse.widthOfTextAtSize(sectionNumText, fontSize);
          
          // Draw section name (truncate if too long)
          const pageNumWidth = 30; // Reserve space for page number
          const textStartX = margin + indentation + numWidth + 8;
          const maxTocWidth = pageWidth - margin - pageNumWidth - textStartX - 10;
          const displayName = truncateAtWordBoundary(cleanName, maxTocWidth, helveticaFont, fontSize);
          
          tocPage.drawText(displayName, {
            x: textStartX,
            y: tocY,
            size: fontSize,
            font: sectionLevel === 2 ? helveticaFont : helveticaFont,
            color: sectionLevel === 2 ? NAVY_RGB : BODY_TEXT_RGB,
          });
          
          // Draw dotted leader line (gold dots)
          const nameWidth = helveticaFont.widthOfTextAtSize(displayName, fontSize);
          const startX = textStartX + nameWidth + 5;
          const endX = pageWidth - margin - pageNumWidth - 5;
          const dotSpacing = 6;
          
          for (let dx = startX; dx < endX; dx += dotSpacing) {
            tocPage.drawCircle({
              x: dx,
              y: tocY + 3,
              size: 0.5,
              color: GOLD_RGB,
            });
          }
          
          // Draw page number (right-aligned, navy)
          const pageNumText = String(actualPageNumber);
          const pageNumTextWidth = helveticaBold.widthOfTextAtSize(pageNumText, fontSize);
          tocPage.drawText(pageNumText, {
            x: pageWidth - margin - pageNumTextWidth,
            y: tocY,
            size: fontSize,
            font: helveticaBold,
            color: NAVY_RGB,
          });
          
          // Adjust vertical spacing based on section level
          tocY -= sectionLevel === 2 ? 24 : 18;
        }
        
        console.log(`✓ Table of Contents drawn with ${h2Index} main sections and page numbers`);
      } else {
        console.log(`📑 Step 5.4: Skipping TOC rendering (${reportTier} tier)`);
      }

      // Add contact/disclaimer page with global settings (replaces static template last page)
      console.log('📞 Step 5.5: Adding contact/disclaimer page with global settings...');
      await addContactDisclaimerPage(globalSettings);

      // Add page numbers to all pages except first and last
      console.log('🔢 Step 5.6: Adding page numbers...');
      const allPages = pdfDoc.getPages();
      const totalPages = allPages.length;
      console.log(`✓ Total pages in document: ${totalPages}`);
      
      // Add page numbers starting from page 2 (index 1), excluding last page
      for (let i = 1; i < totalPages - 1; i++) {
        const page = allPages[i];
        const pageNumber = i + 1; // Display page number (2, 3, 4, ...)
        
        // Draw gold accent line above footer
        page.drawLine({
          start: { x: margin, y: 52 },
          end: { x: pageWidth - margin, y: 52 },
          thickness: 0.5,
          color: GOLD_RGB,
        });
        
        // Draw branded footer text (left)
        page.drawText('Investment Report  |  Confidential', {
          x: margin,
          y: 40,
          size: 7,
          font: helveticaFont,
          color: FOOTER_TEXT_RGB,
        });
        
        // Draw page number (right-aligned)
        const pageNumStr = `Page ${pageNumber}`;
        const pageNumWidth = helveticaFont.widthOfTextAtSize(pageNumStr, 7);
        page.drawText(pageNumStr, {
          x: pageWidth - margin - pageNumWidth,
          y: 40,
          size: 7,
          font: helveticaFont,
          color: FOOTER_TEXT_RGB,
        });
        
        console.log(`  ✓ Added styled footer with page ${pageNumber} to page index ${i}`);
      }
      console.log(`✓ Page numbering complete (pages 2-${totalPages - 1})`);

      // Set clean PDF metadata (overrides any stray template metadata)
      try {
        const cleanSuburb = String(suburb || '').trim();
        const cleanState = String(state || '').trim();
        const locationLabel = [cleanSuburb, cleanState].filter(Boolean).join(', ');
        const pdfTitle = locationLabel
          ? `Investment Report — ${locationLabel}`
          : 'Investment Report';
        pdfDoc.setTitle(pdfTitle);
        pdfDoc.setAuthor('NPC Services');
        pdfDoc.setSubject('Property Investment Report');
        pdfDoc.setCreator('NPC Command Centre');
        pdfDoc.setProducer('NPC Command Centre');
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());
      } catch (metaErr) {
        console.warn('⚠️ Failed to set PDF metadata:', metaErr);
      }

      // Save the PDF
      console.log('💾 Step 6: Saving PDF document...');
      const pdfBytes = await pdfDoc.save();
      console.log('✓ PDF saved, size:', pdfBytes.length, 'bytes');
      
      const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });
      console.log('✓ Blob created');
      
      // Upload to Supabase Storage via secure function
      console.log('☁️ Step 7: Uploading to Supabase Storage...');
      const fileName = `${report.id}_${suburb}_${state}_${Date.now()}.pdf`;
      console.log('📤 Uploading as:', fileName);
      
      const uploadResult = await secureStorageUpload(
        'investment-reports',
        fileName,
        blob,
        { contentType: 'application/pdf', upsert: true, resourceId: report.id }
      );

      if (!uploadResult.success) {
        console.error('❌ Upload failed:', uploadResult.error);
        throw new Error(uploadResult.error || 'Upload failed');
      }
      console.log('✓ Upload successful:', uploadResult.path);

      // Get public URL via secure function
      console.log('🔗 Step 8: Getting public URL...');
      const { data: urlResult, error: urlError } = await invokeSecureFunction('secure-storage', {
        operation: 'publicUrl',
        bucket: 'investment-reports',
        path: fileName
      });
      
      const publicUrl = urlResult?.data?.publicUrl || '';
      console.log('✓ Public URL:', publicUrl);

      // Update the investment_reports table with the PDF URL via secure function
      // Skip for comparison reports which use a different table
      if (!skipDatabaseUpdate) {
        console.log('💽 Step 9: Updating database...');
        const { error: updateError } = await invokeSecureFunction('manage-investment-reports', {
          action: 'update',
          reportId: report.id,
          // Store the stable object path, never a short-lived/public URL. The
          // shared downloader obtains an authorised response at click time.
          data: { pdf_url: uploadResult.path }
        });

        if (updateError) {
          console.error('❌ Database update failed:', updateError);
          throw new Error(updateError.message || 'Database update failed');
        }
        console.log('✓ Database updated');
      } else {
        console.log('⏭️ Step 9: Skipping database update (comparison report)');
      }

      return { blob, publicUrl, suburb, state };
  };

  const handleGenerationError = (error: unknown) => {
    console.error('❌ PDF generation error:', error);
    let errorMessage = 'Failed to generate PDF. ';
    if (error instanceof Error) {
      if (error.message.includes('WinAnsi')) {
        errorMessage += 'Special characters encoding issue detected.';
      } else if (error.message.includes('template')) {
        errorMessage += 'Template loading failed.';
      } else if (error.message.includes('storage')) {
        errorMessage += 'Failed to upload to storage.';
      } else {
        errorMessage += error.message;
      }
    }
    toast.error(errorMessage);
  };

  // Generate, upload, and return the public URL (no download)
  const handleGenerateAndUpload = async (): Promise<string | null> => {
    setIsGenerating(true);
    try {
      const result = await generateCore();
      toast.success('PDF generated and uploaded successfully!');
      return result.publicUrl;
    } catch (error) {
      handleGenerationError(error);
      return null;
    } finally {
      setIsGenerating(false);
    }
  };

  // Generate, upload, AND download to device
  const generatePixelPerfectPDF = async () => {
    setIsGenerating(true);
    try {
      // Prefer the existing persisted standard client PDF. This is the same
      // flow used by the Generated Reports card and avoids needless renders.
      if (report.pdf_url) {
        await downloadClientPdf(report.id, {
          report: {
            id: report.id,
            property_address: report.address,
            report_tier: reportTier,
            pdf_url: report.pdf_url,
          },
        });
        toast.success('Client PDF downloaded successfully.');
        return;
      }
      const result = await generateCore();

      // The renderer persists the stable storage path first. Download through
      // the same authorised retrieval service used by report-library cards.
      await downloadClientPdf(report.id, {
        report: {
          id: report.id,
          property_address: report.address,
          report_tier: reportTier,
          pdf_url: result.publicUrl,
        },
      });

      console.log('✅ PDF generation completed successfully!');
      toast.success('PDF generated and saved successfully!');

      logActivityDirect({
        actionType: 'report_pdf_downloaded',
        entityType: 'investment_report',
        entityId: report.id,
        entityName: report.address,
        metadata: { format: 'pdf', source: 'pixel_perfect_generator' }
      });
    } catch (error) {
      handleGenerationError(error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Expose generateAndUpload for external use (e.g., Send to Client)
  useImperativeHandle(ref, () => ({
    generateAndUpload: handleGenerateAndUpload,
    download: generatePixelPerfectPDF,
  }));

  return (
    <div className="inline-flex items-center gap-1">
      <Button
        onClick={generatePixelPerfectPDF}
        disabled={isGenerating}
        variant={appearance === 'legacy' ? 'ghost' : 'default'}
        size={appearance === 'legacy' ? 'sm' : 'default'}
        className={appearance === 'legacy' ? 'gap-2 text-muted-foreground' : 'gap-2'}
      >
        <Download className="h-4 w-4" />
        {isGenerating
          ? 'Generating PDF...'
          : appearance === 'legacy' ? 'Download (legacy layout)' : 'Download Client PDF'}
      </Button>
      <FlattenPdfIconButton
        getPdfBlob={async () => (await generateCore()).blob}
        filename={`${(report as any)?.address || 'investment-report'}.pdf`}
        disabled={isGenerating}
      />
    </div>
  );
});

PixelPerfectPDFGenerator.displayName = 'PixelPerfectPDFGenerator';
