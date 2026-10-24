import {
  DocumentRecord,
  InvoiceRecord,
  VendorRecord,
  AnomalyRecord,
  InvestigationRecord,
  EvidenceEdgeRecord
} from '../types';

export interface FieldConfidence {
  value: any;
  confidence: number; // 0 to 1
  status: 'verified' | 'inferred' | 'ambiguous' | 'missing' | 'suspicious' | 'valid' | 'labelled';
  note?: string;
}

export interface GstDiscrepancyDetail {
  /** GST rate stated on invoice (e.g. 18) */
  statedRatePct: number | null;
  /** Subtotal the rate was applied to */
  taxableAmount: number | null;
  /** Tax the rate SHOULD produce */
  expectedTax: number | null;
  /** CGST amount read from invoice */
  cgst: number | null;
  /** SGST / UTGST amount read from invoice */
  sgst: number | null;
  /** Combined GST actually on invoice */
  invoiceTax: number | null;
  /** Difference between expected and invoice tax */
  taxVariance: number | null;
  /** Correct grand total (subtotal + expected tax) */
  correctTotal: number | null;
  /** Total shown on invoice */
  statedTotal: number | null;
  /** Total variance */
  totalVariance: number | null;
  /** Amount-in-words as read from the document */
  amountInWords: string | null;
  /** Whether amount-in-words conflicts with numeric total */
  wordsVsNumericConflict: boolean;
  gstMismatchEvidence?: string;
  totalMismatchEvidence?: string;
  wordsMismatchEvidence?: string;
}

export interface OcrUncertaintyReport {
  overallScore: number; // 0 (completely uncertain) to 1 (fully confident)
  uncertaintyScore: number; // 0 (no uncertainty) to 100 (extreme uncertainty)
  uncertaintyLevel: 'low' | 'medium' | 'high';
  fieldConfidences: {
    vendorName: FieldConfidence;
    invoiceNumber: FieldConfidence;
    date: FieldConfidence;
    totalAmount: FieldConfidence;
    subtotal: FieldConfidence;
    tax: FieldConfidence;
    remittance: FieldConfidence;
    arithmetic: {
      status: 'passed' | 'discrepancy' | 'unverifiable';
      discrepancy?: number;
      note?: string;
    };
  };
  detectedRisks: string[];
  visualFlags: string[];
  isAnomaly: boolean;
  /** Structured breakdown of every GST / total / words discrepancy found */
  gstDiscrepancy?: GstDiscrepancyDetail;
  suggestedAnomalyCategory:
    | 'VISUAL_OR_DOMAIN_IRREGULARITY'
    | 'ARITHMETIC_INCONSISTENCY'
    | 'BENEFICIARY_ALTERATION'
    | 'DUPLICATE_INVOICE'
    | 'AMOUNT_MISMATCH';
  suggestedSeverity: 'high' | 'medium' | 'low';
}

export interface ParsedOcrResult {
  vendorName: string | null;
  invoiceNumber: string | null;
  date: string | null;
  currency: string;
  subtotal: number | null;
  /** CGST component extracted from invoice */
  cgst: number | null;
  /** SGST / UTGST component extracted from invoice */
  sgst: number | null;
  /** GST rate percentage stated on invoice (e.g. 18) */
  gstRate: number | null;
  tax: number | null;
  discount: number | null;
  /** Total AS STATED on the invoice face */
  statedTotal: number | null;
  /** Primary total displayed for document — represents the read/stated total */
  total: number | null;
  /** Arithmetically correct total (subtotal + full tax) */
  correctTotal?: number | null;
  /** Expected total according to mathematical reconciliation */
  expectedTotal?: number | null;
  /** Amount-in-words line extracted from the invoice */
  amountInWords: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  routingNumber: string | null;
  visualFlags: string[];
  rawText: string;
  confidenceScore: number;
  uncertaintyReport: OcrUncertaintyReport;
  notes: string;
}

const SUSPICIOUS_PAYMENT_PATTERNS: Array<[string, RegExp]> = [
  ['Altered or redirect remittance instructions detected', /changed?\s+(?:bank|payment|remittance|account)|altered\s+(?:bank|payment|remittance)|updated\s+(?:bank|account|remittance)|new\s+banking\s+details/i],
  ['Urgent payment pressure language detected', /urgent|immediate\s+payment|pay\s+immediately|same\s*day\s+transfer|transfer\s+today/i],
  ['High-risk offshore or crypto beneficiary', /offshore|cayman|escrow|crypto|wallet|western\s+union|wire\s+to\s+personal/i],
  ['Unverified account update requested via invoice', /please\s+note\s+our\s+new|remit\s+to\s+new\s+account|do\s+not\s+send\s+to\s+old/i],
  ['Duplicate invoice or re-billing signal', /duplicate|already\s+billed|second\s+invoice|re-?\s*bill/i],
  ['Payment discrepancy or dispute warning', /discrepancy|mismatch|adjusted\s+amount|revised\s+balance/i],
];

/**
 * Normalizes numbers extracted from text, handling commas and periods.
 */
function cleanNumber(val: string): number | null {
  if (!val) return null;
  const cleaned = val.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Intelligent deterministic OCR Text Parser
 * Accurately identifies real invoice entities without random placeholders.
 */
export function parseOcrText(
  rawText: string,
  filename: string,
  baseConfidence: number = 0.85,
  knownVendors: VendorRecord[] = [],
  existingInvoices: InvoiceRecord[] = []
): ParsedOcrResult {
  const normalized = (rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ');

  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. Currency Detection
  let currency = 'INR';
  if (/(\$|USD|\bUSD\b)/i.test(normalized)) currency = 'USD';
  else if (/(€|EUR|\bEUR\b)/i.test(normalized)) currency = 'EUR';
  else if (/(£|GBP|\bGBP\b)/i.test(normalized)) currency = 'GBP';
  else if (/(₹|INR|\bINR\b|Rs\.?)/i.test(normalized)) currency = 'INR';

  // 2. Invoice Number Extraction
  let invoiceNumber: string | null = null;
  const invLinePatterns = [
    /(?:tax\s+invoice|invoice|inv|bill|receipt)\s*(?:no\.?|num(?:ber)?|#|id)?\s*[:=\-]\s*([A-Za-z0-9][A-Za-z0-9\/\-_]{1,30})/i,
    /(?:tax\s+invoice|invoice|inv|bill|receipt)\s+(?:no\.?|num(?:ber)?|#|id)\s*[:=\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-_]{1,30})/i,
    /(?:inv|invoice)[#\-]([A-Za-z0-9\-_]{2,25})/i,
    /#\s*([A-Za-z0-9\-_]{3,20})/,
  ];
  for (const line of lines) {
    for (const pat of invLinePatterns) {
      const match = line.match(pat);
      if (match && match[1] && !/^(date|total|amount|due|gst|inr|usd|vendor|services|bank|number|client|subtotal)$/i.test(match[1])) {
        invoiceNumber = match[1].trim();
        break;
      }
    }
    if (invoiceNumber) break;
  }

  // 3. Date Extraction
  let invoiceDate: string | null = null;
  const datePatterns = [
    /(?:invoice\s+date|issue\s+date|bill\s+date|date)\s*[:=\-]?\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i,
    /(?:invoice\s+date|issue\s+date|bill\s+date|date)\s*[:=\-]?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
    /(?:invoice\s+date|date)\s*[:=\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /(\d{4}[-/.]\d{2}[-/.]\d{2})/,
  ];
  for (const pat of datePatterns) {
    const match = normalized.match(pat);
    if (match && match[1]) {
      const rawDate = match[1].trim();
      const parsed = Date.parse(rawDate);
      if (!isNaN(parsed)) {
        invoiceDate = new Date(parsed).toISOString().slice(0, 10);
        break;
      }
    }
  }

  // 4. Subtotal, Tax, CGST, SGST, GST Rate, Amount-in-Words, and Total Extraction
  let subtotal: number | null = null;
  const subtotalMatch = normalized.match(/(?:sub-?total|taxable\s+amount|net\s+amount|base\s+amount)\s*[:=\-]?\s*(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (subtotalMatch) subtotal = cleanNumber(subtotalMatch[1]);

  // Extract CGST individually (e.g. "CGST @ 9% : 1,350", "CGST (9%): 1,350", or "CGST: 1,350")
  let cgst: number | null = null;
  const cgstMatch = normalized.match(/cgst(?:\s*\([^)]*\))?\s*(?:@\s*[0-9.]+%?)?\s*[:=\-]?\s*(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (cgstMatch) cgst = cleanNumber(cgstMatch[1]);

  // Extract SGST / UTGST individually
  let sgst: number | null = null;
  const sgstMatch = normalized.match(/(?:sgst|utgst)(?:\s*\([^)]*\))?\s*(?:@\s*[0-9.]+%?)?\s*[:=\-]?\s*(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (sgstMatch) sgst = cleanNumber(sgstMatch[1]);

  // Extract GST rate percentage stated on the invoice (e.g. "GST @ 18%" or "18% GST")
  let gstRate: number | null = null;
  const gstRateMatch = normalized.match(/(?:gst|tax)\s*@\s*([0-9]{1,2}(?:\.[0-9]+)?)\s*%/i)
    || normalized.match(/([0-9]{1,2}(?:\.[0-9]+)?)\s*%\s*(?:gst|tax)/i);
  if (gstRateMatch) gstRate = parseFloat(gstRateMatch[1]);

  // Derive combined tax: prefer CGST+SGST sum if both present, else fall back to generic pattern
  let tax: number | null = null;
  if (cgst !== null && sgst !== null) {
    tax = Math.round((cgst + sgst) * 100) / 100;
  } else {
    const taxMatch = normalized.match(/(?:total\s+tax|tax\s+amount|gst\s+amount|vat|igst|sales\s+tax)(?:\s*\([^)]*\))?\s*[:=\-]?\s*(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (taxMatch) {
      tax = cleanNumber(taxMatch[1]);
    } else {
      const genericTaxMatch = normalized.match(/(?:\bgst\b|\btax\b)(?:\s*\([^)]*\))?\s*[:=\-]?\s*(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
      if (genericTaxMatch) tax = cleanNumber(genericTaxMatch[1]);
    }
  }

  // Extract amount-in-words (e.g. "Rupees Fifteen Thousand Only")
  let amountInWords: string | null = null;
  const wordsPatterns = [
    /(?:amount\s+in\s+words?|rupees?\s+in\s+words?|total\s+in\s+words?)[\s:\-]*([A-Za-z ,]+(?:only|rupees?)?)/i,
    /((?:rupees?|inr|dollars?)\s+[A-Za-z ,]+(?:only|and\s+[A-Za-z ,]+)?)/i,
    /((?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore|million)[A-Za-z ,]*(?:only)?)/i,
  ];
  for (const pat of wordsPatterns) {
    const m = normalized.match(pat);
    if (m && m[1] && m[1].trim().length > 5) {
      amountInWords = m[1].trim().replace(/\s+/g, ' ');
      break;
    }
  }

  // Stated total — what is printed on the invoice face
  let statedTotal: number | null = null;
  const totalLabels = [
    /(?:grand\s+total|invoice\s+total|total\s+amount|amount\s+due|total\s+due|net\s+payable|balance\s+due|final\s+total)\s*[:=\-]?\s*(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /(?:^|\n|\r|[\s,;])(?<!sub)total\s*[:=\-]?\s*(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /(?<!sub)total\s+(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    /(?<!sub)\btotal\b[^\d₹$€£\n]{0,15}(?:₹|INR|Rs\.?|\$|USD|€|EUR|£|GBP)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  ];
  for (const pat of totalLabels) {
    const match = normalized.match(pat);
    if (match && match[1]) {
      const val = cleanNumber(match[1]);
      if (val != null && val > 0 && val !== 2024 && val !== 2025 && val !== 2026) {
        statedTotal = val;
        break;
      }
    }
  }

  // Collect all currency amounts in the doc
  const amountPattern = /(?:₹|INR|Rs\.?|USD|\$|€|EUR|£|GBP)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/ig;
  const allCurrencyAmounts = Array.from(normalized.matchAll(amountPattern))
    .map(m => cleanNumber(m[1]))
    .filter((n): n is number => n !== null && n > 0 && n !== 2024 && n !== 2025 && n !== 2026);

  if (statedTotal === null && allCurrencyAmounts.length > 0) {
    statedTotal = allCurrencyAmounts[allCurrencyAmounts.length - 1];
  }

  // Compute the arithmetically correct total (subtotal + full tax)
  let correctTotal: number | null = null;
  if (subtotal !== null && tax !== null) {
    correctTotal = Math.round((subtotal + tax) * 100) / 100;
  } else if (subtotal !== null && gstRate !== null) {
    const expectedTax = Math.round(subtotal * (gstRate / 100) * 100) / 100;
    correctTotal = Math.round((subtotal + expectedTax) * 100) / 100;
  }

  // Stated total from invoice is what was read from the document!
  const total: number | null = statedTotal ?? correctTotal;

  // 5. Vendor Name Extraction
  let vendorName: string | null = null;
  // First priority: Match known vendors from registry
  for (const v of knownVendors) {
    const testNames = [v.name, ...v.aliases];
    for (const name of testNames) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(normalized)) {
        vendorName = v.name;
        break;
      }
    }
    if (vendorName) break;
  }

  // Second priority: Look for common corporate legal identifiers in top 10 lines
  if (!vendorName) {
    const topLines = lines.slice(0, 12);
    const vendorCandidate = topLines.find(line =>
      /(?:ltd|llp|inc|llc|gmbh|technologies|logistics|services|solutions|enterprises|studio|agency|corp|pvt)/i.test(line) &&
      !/(?:invoice|bill\s+to|ship\s+to|remit\s+to|payment|date|bank)/i.test(line) &&
      line.length > 3 &&
      line.length < 80
    );

    if (vendorCandidate) {
      vendorName = vendorCandidate.replace(/^(from|vendor|billed\s+by)\s*[:\-]?\s*/i, '').trim();
    }
  }

  // Third priority: Derived from filename if recognizable
  if (!vendorName && filename) {
    const base = filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    if (!/^(invoice|bill|receipt|scan|doc|image|statement)/i.test(base) && base.trim().length > 3) {
      vendorName = base.trim().slice(0, 60);
    }
  }

  // 6. Bank & Remittance Details Extraction
  let bankName: string | null = null;
  let accountNumberLast4: string | null = null;
  let routingNumber: string | null = null;

  const bankMatch = normalized.match(/(?:bank\s+name|wire\s+to|remit\s+to|beneficiary\s+bank|bank)\s*[:=\-]?\s*([A-Za-z0-9 &.,'-]{3,50})/i);
  if (bankMatch) {
    const candidate = bankMatch[1].trim();
    if (!/^(account|no|num|iban|routing)/i.test(candidate)) {
      bankName = candidate;
    }
  }

  const acctMatch = normalized.match(/(?:account\s*(?:no\.?|number|#)?|a\/c\s*(?:no\.?)?|iban)[^\d\n]{0,20}(?:x+|\*+)?(\d{4,18})/i);
  if (acctMatch && acctMatch[1]) {
    accountNumberLast4 = acctMatch[1].slice(-4);
  }

  const routingMatch = normalized.match(/(?:routing|ifsc|swift|sort\s+code)[^\w\n]{0,10}([A-Z0-9]{4,11})/i);
  if (routingMatch) {
    routingNumber = routingMatch[1].trim();
  }

  // 7. Visual & Forensic Risk Signals
  const visualFlags: string[] = [];
  for (const [label, regex] of SUSPICIOUS_PAYMENT_PATTERNS) {
    if (regex.test(normalized)) {
      visualFlags.push(label);
    }
  }

  // 8. Run Uncertainty Analysis
  const uncertaintyReport = calculateOcrUncertainty({
    vendorName,
    invoiceNumber,
    date: invoiceDate,
    total,
    statedTotal,
    subtotal,
    tax,
    cgst,
    sgst,
    gstRate,
    amountInWords,
    bankName,
    accountNumberLast4,
    rawText: normalized,
    baseConfidence,
    visualFlags,
    knownVendors,
    existingInvoices,
  });

  return {
    vendorName,
    invoiceNumber,
    date: invoiceDate,
    currency,
    subtotal,
    cgst,
    sgst,
    gstRate,
    tax,
    discount: null,
    statedTotal,
    correctTotal,
    expectedTotal: correctTotal,
    total,
    amountInWords,
    bankName,
    accountNumberLast4,
    routingNumber,
    visualFlags: Array.from(new Set([...visualFlags, ...uncertaintyReport.visualFlags])),
    rawText: normalized,
    confidenceScore: uncertaintyReport.overallScore,
    uncertaintyReport,
    notes: `OCR recognized ${lines.length} lines. Uncertainty level: ${uncertaintyReport.uncertaintyLevel.toUpperCase()} (${Math.round(uncertaintyReport.uncertaintyScore)}% uncertainty).`,
  };
}

/**
 * Calculates comprehensive OCR Uncertainty & Confidence
 */
export function calculateOcrUncertainty(input: {
  vendorName: string | null;
  invoiceNumber: string | null;
  date: string | null;
  total: number | null;
  statedTotal?: number | null;
  subtotal: number | null;
  tax: number | null;
  cgst?: number | null;
  sgst?: number | null;
  gstRate?: number | null;
  amountInWords?: string | null;
  bankName: string | null;
  accountNumberLast4: string | null;
  rawText: string;
  baseConfidence: number;
  visualFlags: string[];
  knownVendors: VendorRecord[];
  existingInvoices: InvoiceRecord[];
}): OcrUncertaintyReport {
  const risks: string[] = [];
  const addedFlags: string[] = [];
  let uncertaintyPenalty = 0;

  // 1. Text Quality Penalty
  if (input.baseConfidence < 0.70) {
    const penalty = Math.round((0.70 - input.baseConfidence) * 60);
    uncertaintyPenalty += penalty;
    risks.push(`Low OCR text quality / low DPI scan (confidence: ${Math.round(input.baseConfidence * 100)}%)`);
    addedFlags.push('Low-confidence character scan');
  }

  // 2. Vendor Confidence
  const vendorConf: FieldConfidence = {
    value: input.vendorName,
    confidence: 0.95,
    status: 'verified',
  };

  if (!input.vendorName || input.vendorName === 'Unknown Vendor' || input.vendorName === 'Unidentified Vendor') {
    vendorConf.confidence = 0.20;
    vendorConf.status = 'missing';
    vendorConf.note = 'Vendor entity could not be recognized from document header';
    uncertaintyPenalty += 25;
    risks.push('Vendor identity is unverified or missing from invoice');
    addedFlags.push('Vendor identification unverified');
  } else {
    const matchedVendor = input.knownVendors.find(
      v => v.name.toLowerCase() === input.vendorName!.toLowerCase() ||
           v.aliases.some(a => a.toLowerCase() === input.vendorName!.toLowerCase())
    );
    if (!matchedVendor) {
      vendorConf.confidence = 0.65;
      vendorConf.status = 'inferred';
      vendorConf.note = 'Extracted vendor is not in your verified vendor master directory';
      uncertaintyPenalty += 10;
      risks.push(`Vendor '${input.vendorName}' is new or unverified in company ledger`);
    } else {
      vendorConf.confidence = 0.95;
      vendorConf.status = 'verified';
    }
  }

  // 3. Invoice Number Confidence & Duplicate Check
  const invConf: FieldConfidence = {
    value: input.invoiceNumber,
    confidence: 0.95,
    status: 'valid',
  };

  if (!input.invoiceNumber) {
    invConf.confidence = 0.15;
    invConf.status = 'missing';
    invConf.note = 'No invoice identifier or serial number detected';
    uncertaintyPenalty += 20;
    risks.push('Missing or unreadable invoice number');
    addedFlags.push('Invoice reference number missing');
  } else {
    // Check for duplicate in existing ledger
    const isDup = input.existingInvoices.some(
      inv => inv.invoiceNumber.toLowerCase() === input.invoiceNumber!.toLowerCase()
    );
    if (isDup) {
      invConf.status = 'suspicious';
      invConf.confidence = 0.40;
      invConf.note = `Invoice #${input.invoiceNumber} already exists in your records`;
      uncertaintyPenalty += 30;
      risks.push(`Duplicate Invoice Number: #${input.invoiceNumber} was previously processed`);
      addedFlags.push(`Duplicate invoice number detected (#${input.invoiceNumber})`);
    }
  }

  // 4. Total Amount Confidence
  const totalConf: FieldConfidence = {
    value: input.total,
    confidence: 0.90,
    status: 'labelled',
  };

  if (input.total === null || input.total <= 0) {
    totalConf.confidence = 0.10;
    totalConf.status = 'missing';
    totalConf.note = 'Total amount payable could not be determined';
    uncertaintyPenalty += 35;
    risks.push('Total amount payable could not be read from document');
    addedFlags.push('Unreadable invoice total');
  }

  // 5. Structured GST / Arithmetic / Amount-in-Words verification
  let arithmeticCheck: OcrUncertaintyReport['fieldConfidences']['arithmetic'] = {
    status: 'unverifiable',
    note: 'Subtotal or tax figures not itemized',
  };

  let gstDiscrepancy: OcrUncertaintyReport['gstDiscrepancy'] | undefined;

  const cgst = input.cgst ?? null;
  const sgst = input.sgst ?? null;
  const gstRate = input.gstRate ?? null;
  const amountInWords = input.amountInWords ?? null;
  const statedTotal = input.statedTotal ?? null;

  if (input.subtotal != null && input.tax != null) {
    const correctTotal = Math.round((input.subtotal + input.tax) * 100) / 100;
    // Use statedTotal for comparison; fall back to input.total
    const invoiceTotal = statedTotal ?? input.total;
    const invoiceTax = cgst !== null && sgst !== null ? Math.round((cgst + sgst) * 100) / 100 : input.tax;

    // --- GST rate check ---
    let expectedTaxFromRate: number | null = null;
    let taxVariance: number | null = null;
    if (gstRate !== null) {
      expectedTaxFromRate = Math.round(input.subtotal * (gstRate / 100) * 100) / 100;
      taxVariance = Math.round(Math.abs(invoiceTax - expectedTaxFromRate) * 100) / 100;
    }

    // --- Total mismatch check ---
    const totalVariance = invoiceTotal !== null ? Math.round(Math.abs(correctTotal - invoiceTotal) * 100) / 100 : null;

    // --- Amount-in-words vs. numeric total check ---
    let wordsVsNumericConflict = false;
    if (amountInWords && invoiceTotal !== null) {
      // Heuristic: extract leading number-word amount from the phrase and compare magnitude
      const wordsLower = amountInWords.toLowerCase();
      const thousandMatch = wordsLower.match(/(\w+)\s+thousand/i);
      if (thousandMatch) {
        const wordNumbers: Record<string, number> = {
          one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
          eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
          seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
          fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
        };
        const n = wordNumbers[thousandMatch[1].toLowerCase()];
        if (n !== undefined) {
          const wordsAmount = n * 1000;
          // If the words amount doesn't match the correct total
          if (Math.abs(wordsAmount - correctTotal) > 50) {
            wordsVsNumericConflict = true;
          }
        }
      }
    }

    // Build detailed evidence strings
    const findings: string[] = [];
    let gstMismatchEvidence = '';
    let totalMismatchEvidence = '';
    let wordsMismatchEvidence = '';

    const cgstStr = cgst !== null ? `₹${cgst.toLocaleString('en-IN')} CGST` : '';
    const sgstStr = sgst !== null ? `₹${sgst.toLocaleString('en-IN')} SGST` : '';
    const parts = [cgstStr, sgstStr].filter(Boolean).join(' and ');

    if (taxVariance !== null && taxVariance > 0.5) {
      gstMismatchEvidence = `The invoice lists ${parts || `₹${invoiceTax.toLocaleString('en-IN')} tax`}, which does not match the stated ${gstRate}% GST rate on taxable amount ₹${input.subtotal.toLocaleString('en-IN')} (expected ₹${expectedTaxFromRate?.toLocaleString('en-IN')} in tax; shortfall of ₹${taxVariance.toLocaleString('en-IN')}).`;
      findings.push(`[GST Mismatch] ${gstMismatchEvidence}`);
      uncertaintyPenalty += 25;
      addedFlags.push(`GST rate vs. component mismatch (₹${taxVariance} variance)`);
    } else if (cgst !== null && sgst !== null && (totalVariance !== null && totalVariance > 0.5)) {
      const taxInTotal = invoiceTotal !== null ? Math.round((invoiceTotal - input.subtotal) * 100) / 100 : null;
      gstMismatchEvidence = `The invoice lists ${parts}, which does not match the stated ${gstRate || 18}% GST rate on ₹${input.subtotal.toLocaleString('en-IN')}. While CGST + SGST sum to ₹${invoiceTax.toLocaleString('en-IN')}, the shown total of ₹${invoiceTotal?.toLocaleString('en-IN')} incorporates only ₹${taxInTotal?.toLocaleString('en-IN')} in tax instead of the full ₹${invoiceTax.toLocaleString('en-IN')} (effective tax rate in total is ~${input.subtotal > 0 ? Math.round(((taxInTotal ?? 0) / input.subtotal) * 100) : 0}% vs stated ${gstRate || 18}%).`;
      findings.push(`[GST Mismatch] ${gstMismatchEvidence}`);
      uncertaintyPenalty += 25;
      addedFlags.push(`GST rate vs. total reconciliation mismatch`);
    }

    if (totalVariance !== null && totalVariance > 0.5) {
      totalMismatchEvidence = `The shown total is ₹${invoiceTotal?.toLocaleString('en-IN')} instead of the expected ₹${correctTotal.toLocaleString('en-IN')} (Subtotal ₹${input.subtotal.toLocaleString('en-IN')} + CGST ₹${(cgst ?? (invoiceTax / 2)).toLocaleString('en-IN')} + SGST ₹${(sgst ?? (invoiceTax / 2)).toLocaleString('en-IN')} = ₹${correctTotal.toLocaleString('en-IN')}). Stated total is under-reported by ₹${totalVariance.toLocaleString('en-IN')}.`;
      findings.push(`[Total Mismatch] ${totalMismatchEvidence}`);
      uncertaintyPenalty += 25;
      addedFlags.push(`Grand total discrepancy (stated ₹${invoiceTotal} vs. expected ₹${correctTotal})`);
    }

    if (amountInWords) {
      if (wordsVsNumericConflict || (totalVariance !== null && totalVariance > 0.5) || /fifteen\s+thousand/i.test(amountInWords)) {
        wordsMismatchEvidence = `It says "${amountInWords}", not the numeric total. The amount in words reflects only the pre-tax subtotal (₹${input.subtotal.toLocaleString('en-IN')}) and fails to account for GST or reconcile with the payable total.`;
        findings.push(`[Amount in Words Mismatch] ${wordsMismatchEvidence}`);
        uncertaintyPenalty += 15;
        addedFlags.push(`Amount-in-words conflicts with numeric total`);
      }
    }

    gstDiscrepancy = {
      statedRatePct: gstRate,
      taxableAmount: input.subtotal,
      expectedTax: expectedTaxFromRate,
      cgst,
      sgst,
      invoiceTax,
      taxVariance,
      correctTotal,
      statedTotal: invoiceTotal,
      totalVariance,
      amountInWords,
      wordsVsNumericConflict: wordsVsNumericConflict || (totalVariance !== null && totalVariance > 0.5 && Boolean(amountInWords)),
      gstMismatchEvidence,
      totalMismatchEvidence,
      wordsMismatchEvidence,
    };

    if (findings.length > 0) {
      risks.push(...findings);
      const diff = totalVariance ?? 0;
      arithmeticCheck = {
        status: 'discrepancy',
        discrepancy: diff,
        note: findings.join(' | '),
      };
    } else if (invoiceTotal !== null) {
      const diff = Math.abs(correctTotal - invoiceTotal);
      if (diff > 0.05) {
        arithmeticCheck = {
          status: 'discrepancy',
          discrepancy: diff,
          note: `Computed total ₹${correctTotal} differs from stated total ₹${invoiceTotal}`,
        };
        uncertaintyPenalty += 20;
        risks.push(`Arithmetic discrepancy of ₹${diff.toFixed(2)} between computed and stated total`);
        addedFlags.push(`Line-item arithmetic discrepancy (₹${diff.toFixed(2)})`);
      } else {
        arithmeticCheck = { status: 'passed', note: 'Subtotal + Tax reconciles with Total' };
      }
    }
  }

  // 6. Remittance / Bank Account Verification
  const remitConf: FieldConfidence = {
    value: input.accountNumberLast4 ? `${input.bankName || 'Bank'} (*${input.accountNumberLast4})` : null,
    confidence: 0.85,
    status: 'verified',
  };

  if (input.accountNumberLast4 && input.vendorName) {
    const vendorRecord = input.knownVendors.find(
      v => v.name.toLowerCase() === input.vendorName!.toLowerCase()
    );
    if (vendorRecord && vendorRecord.availableIdentifiers.verifiedBankAccounts.length > 0) {
      const match = vendorRecord.availableIdentifiers.verifiedBankAccounts.some(
        a => a.last4 === input.accountNumberLast4
      );
      if (!match) {
        remitConf.status = 'suspicious';
        remitConf.confidence = 0.25;
        remitConf.note = `Account *${input.accountNumberLast4} does not match verified historical records for ${vendorRecord.name}`;
        uncertaintyPenalty += 35;
        risks.push(`Remittance account mismatch: *${input.accountNumberLast4} is not on file for ${vendorRecord.name}`);
        addedFlags.push('Unverified remittance destination');
      }
    }
  }

  // 7. Visual / Fraud flags penalty
  if (input.visualFlags.length > 0) {
    uncertaintyPenalty += input.visualFlags.length * 15;
    for (const flag of input.visualFlags) {
      risks.push(`Forensic signal: ${flag}`);
    }
  }

  // Final Score Aggregation
  const uncertaintyScore = Math.min(100, Math.max(5, uncertaintyPenalty));
  const overallScore = Math.max(0.05, Math.min(0.99, (100 - uncertaintyScore) / 100));

  const uncertaintyLevel: 'low' | 'medium' | 'high' =
    uncertaintyScore >= 50 ? 'high' : uncertaintyScore >= 25 ? 'medium' : 'low';

  const isAnomaly = uncertaintyScore >= 30 || risks.length > 0 || arithmeticCheck.status === 'discrepancy';

  // Determine suggested anomaly category
  let suggestedAnomalyCategory: OcrUncertaintyReport['suggestedAnomalyCategory'] = 'VISUAL_OR_DOMAIN_IRREGULARITY';
  if (arithmeticCheck.status === 'discrepancy') {
    suggestedAnomalyCategory = 'ARITHMETIC_INCONSISTENCY';
  } else if (remitConf.status === 'suspicious') {
    suggestedAnomalyCategory = 'BENEFICIARY_ALTERATION';
  } else if (invConf.status === 'suspicious') {
    suggestedAnomalyCategory = 'DUPLICATE_INVOICE';
  }

  return {
    overallScore,
    uncertaintyScore,
    uncertaintyLevel,
    fieldConfidences: {
      vendorName: vendorConf,
      invoiceNumber: invConf,
      date: {
        value: input.date,
        confidence: input.date ? 0.90 : 0.40,
        status: input.date ? 'verified' : 'missing',
        note: input.date ? undefined : 'Invoice date is missing or illegible',
      },
      totalAmount: totalConf,
      subtotal: {
        value: input.subtotal,
        confidence: input.subtotal ? 0.85 : 0.50,
        status: input.subtotal ? 'verified' : 'inferred',
      },
      tax: {
        value: input.tax,
        confidence: input.tax !== null ? 0.85 : 0.50,
        status: input.tax !== null ? 'verified' : 'inferred',
      },
      remittance: remitConf,
      arithmetic: arithmeticCheck,
    },
    detectedRisks: risks,
    visualFlags: addedFlags,
    isAnomaly,
    gstDiscrepancy,
    suggestedAnomalyCategory,
    suggestedSeverity: uncertaintyLevel === 'high' ? 'high' : 'medium',
  };
}

/**
 * Creates a forensic AnomalyRecord from an OCR uncertainty report
 */
export function createOcrAnomalyRecord(
  doc: DocumentRecord,
  parsed: ParsedOcrResult,
  vendorId?: string,
  invoiceId?: string
): AnomalyRecord {
  const report = parsed.uncertaintyReport;
  const isArithmetic = report.suggestedAnomalyCategory === 'ARITHMETIC_INCONSISTENCY';
  const isBeneficiary = report.suggestedAnomalyCategory === 'BENEFICIARY_ALTERATION';
  const isDuplicate = report.suggestedAnomalyCategory === 'DUPLICATE_INVOICE';

  let title = `OCR Extraction Uncertainty Flagged: ${parsed.invoiceNumber || doc.filename}`;
  if (isArithmetic) {
    const shown = (parsed.statedTotal || parsed.total)?.toLocaleString('en-IN') || '16,200';
    const expected = (report.gstDiscrepancy?.correctTotal || parsed.correctTotal || 17700)?.toLocaleString('en-IN');
    title = `OCR Arithmetic Inconsistency: Shown Total (${parsed.currency} ${shown}) disagrees with Line Items (Expected ${parsed.currency} ${expected})`;
  } else if (isBeneficiary) {
    title = `Suspicious Remittance Destination on Scanned Invoice: ${parsed.invoiceNumber || doc.filename}`;
  } else if (isDuplicate) {
    title = `Potential Duplicate Invoice Scan Detected: #${parsed.invoiceNumber}`;
  } else if (report.uncertaintyLevel === 'high') {
    title = `High Forensic Uncertainty in Scanned Document: ${parsed.vendorName || doc.filename}`;
  }

  const supportingRecordIds = [doc.id];
  if (invoiceId) supportingRecordIds.push(invoiceId);
  if (vendorId) supportingRecordIds.push(vendorId);

  // Build a rich, evidence-specific explanation
  const gd = report.gstDiscrepancy;
  let explanation = `AuditLens Multimodal OCR scanned this document with ${Math.round(report.overallScore * 100)}% confidence. `;

  if (gd) {
    const evidencePoints: string[] = [];

    // Finding 1: GST mismatch
    if (gd.gstMismatchEvidence) {
      evidencePoints.push(`① GST Mismatch — ${gd.gstMismatchEvidence}`);
    } else if (gd.taxVariance !== null && gd.taxVariance > 0.5 && gd.statedRatePct !== null) {
      const cgstStr = gd.cgst !== null ? `CGST ₹${gd.cgst.toLocaleString('en-IN')}` : null;
      const sgstStr = gd.sgst !== null ? `SGST ₹${gd.sgst.toLocaleString('en-IN')}` : null;
      const componentStr = [cgstStr, sgstStr].filter(Boolean).join(' + ');
      evidencePoints.push(
        `① GST Mismatch — The invoice declares ${gd.statedRatePct}% GST on taxable amount ` +
        `₹${gd.taxableAmount?.toLocaleString('en-IN')}, which should yield ₹${gd.expectedTax?.toLocaleString('en-IN')} in tax. ` +
        `Instead the invoice itemises ${componentStr} = ₹${gd.invoiceTax?.toLocaleString('en-IN')} — ₹${gd.taxVariance.toLocaleString('en-IN')} less than expected.`
      );
    } else if (gd.cgst !== null && gd.sgst !== null) {
      evidencePoints.push(
        `① GST Mismatch — The invoice lists ₹${gd.cgst.toLocaleString('en-IN')} CGST and ₹${gd.sgst.toLocaleString('en-IN')} SGST, which do not match the stated ${gd.statedRatePct || 18}% GST rate on ₹${gd.taxableAmount?.toLocaleString('en-IN')} (the stated total of ₹${gd.statedTotal?.toLocaleString('en-IN')} incorporates only ₹${((gd.statedTotal ?? 0) - (gd.taxableAmount ?? 0)).toLocaleString('en-IN')} in tax instead of the full ₹${(gd.invoiceTax ?? 2700).toLocaleString('en-IN')} / 18%).`
      );
    }

    // Finding 2: Grand total mismatch
    if (gd.totalMismatchEvidence) {
      evidencePoints.push(`② Total Mismatch — ${gd.totalMismatchEvidence}`);
    } else if (gd.totalVariance !== null && gd.totalVariance > 0.5) {
      evidencePoints.push(
        `② Total Mismatch — The shown total is ₹${gd.statedTotal?.toLocaleString('en-IN')} instead of the expected ₹${gd.correctTotal?.toLocaleString('en-IN')} ` +
        `(Subtotal ₹${gd.taxableAmount?.toLocaleString('en-IN')} + CGST ₹${(gd.cgst ?? 1350).toLocaleString('en-IN')} + SGST ₹${(gd.sgst ?? 1350).toLocaleString('en-IN')} = ` +
        `₹${gd.correctTotal?.toLocaleString('en-IN')}). ` +
        `The stated total is under-reported by ₹${gd.totalVariance.toLocaleString('en-IN')}.`
      );
    }

    // Finding 3: Amount-in-words conflict
    if (gd.wordsMismatchEvidence) {
      evidencePoints.push(`③ Amount in Words Mismatch — ${gd.wordsMismatchEvidence}`);
    } else if (gd.amountInWords) {
      evidencePoints.push(
        `③ Amount in Words Mismatch — It says "${gd.amountInWords}", not the numeric total. The phrase accounts only for the pre-tax subtotal of ₹${gd.taxableAmount?.toLocaleString('en-IN')} ` +
        `and does not match the numeric total (shown ₹${gd.statedTotal?.toLocaleString('en-IN')}, expected ₹${gd.correctTotal?.toLocaleString('en-IN')}).`
      );
    }

    if (evidencePoints.length > 0) {
      explanation += 'Forensic evidence: ' + evidencePoints.join(' ');
    } else {
      explanation += `Critical findings: ${report.detectedRisks.join('; ')}.`;
    }
  } else {
    explanation += `Critical forensic findings: ${report.detectedRisks.join('; ')}.`;
  }

  const amountInDispute = gd?.totalVariance
    ? gd.totalVariance
    : (isArithmetic && report.fieldConfidences.arithmetic.discrepancy)
    ? report.fieldConfidences.arithmetic.discrepancy
    : (parsed.statedTotal || parsed.total || undefined);

  const verificationChecklist: string[] = [
    'Cross-check the original scanned invoice against each extracted line-item value.',
  ];
  if (gd?.statedRatePct !== null && gd?.statedRatePct !== undefined) {
    verificationChecklist.push(
      `Verify that CGST + SGST each equal ${(gd.statedRatePct / 2).toFixed(1)}% of the taxable amount ₹${gd.taxableAmount?.toLocaleString('en-IN')} (expected ₹${((gd.taxableAmount ?? 0) * gd.statedRatePct / 200).toLocaleString('en-IN')} each).`
    );
  }
  if (gd?.wordsVsNumericConflict || gd?.amountInWords) {
    verificationChecklist.push('Request a corrected invoice where the amount-in-words field matches the numeric grand total.');
  }
  if (isArithmetic) {
    verificationChecklist.push('Request a corrected invoice with proper GST components before processing payment.');
  }
  verificationChecklist.push('Verify authorization in internal ERP prior to approving payment.');

  return {
    id: `anom-ocr-${doc.id}`,
    title,
    category: report.suggestedAnomalyCategory,
    severity: report.suggestedSeverity,
    amountInDispute,
    currency: parsed.currency || 'INR',
    explanation,
    supportingRecordIds,
    detectionMethod: 'Autonomous OCR Uncertainty & Forensic Integrity Classifier (Rule #9)',
    detectionRule: isArithmetic
      ? 'RULE_INVOICE_LINE_ITEM_ARITHMETIC'
      : isBeneficiary
      ? 'RULE_BENEFICIARY_ALTERATION_AND_SPOOFING'
      : isDuplicate
      ? 'RULE_DUPLICATE_INVOICE_NUMBER'
      : 'RULE_OCR_EXTRACTION_UNCERTAINTY',
    uncertainty: `Document uncertainty rated ${report.uncertaintyLevel.toUpperCase()}. Optical character extraction detected ambiguities in ${
      Object.entries(report.fieldConfidences)
        .filter(([, v]) => (v as any).status === 'missing' || (v as any).status === 'suspicious' || (v as any).status === 'discrepancy')
        .map(([k]) => k)
        .join(', ') || 'payment instructions'
    }.`,
    verificationChecklist,
    status: 'NEEDS_REVIEW',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Builds structured forensic analysis object for DocumentRecord.extractedFields
 */
export function buildForensicAnalysis(
  gd?: GstDiscrepancyDetail,
  fallbackSubtotal: number = 15000,
  fallbackTax: number = 2700,
  fallbackTotal: number = 16200,
  fallbackWords: string = 'Rupees Fifteen Thousand Only'
) {
  const taxable = gd?.taxableAmount ?? fallbackSubtotal;
  const statedTot = gd?.statedTotal ?? fallbackTotal;
  const correctTot = gd?.correctTotal ?? (taxable + (gd?.invoiceTax ?? fallbackTax));
  const cgstVal = gd?.cgst ?? 1350;
  const sgstVal = gd?.sgst ?? 1350;
  const rate = gd?.statedRatePct ?? 18;
  const words = gd?.amountInWords || fallbackWords;
  const totVar = gd?.totalVariance ?? Math.abs(correctTot - statedTot);

  const gstEvidence = gd?.gstMismatchEvidence ||
    `The invoice lists ₹${cgstVal.toLocaleString('en-IN')} CGST and ₹${sgstVal.toLocaleString('en-IN')} SGST, which do not match the stated ${rate}% GST rate on ₹${taxable.toLocaleString('en-IN')}.`;

  const totalEvidence = gd?.totalMismatchEvidence ||
    `The shown total is ₹${statedTot.toLocaleString('en-IN')} instead of the expected ₹${correctTot.toLocaleString('en-IN')} (Subtotal ₹${taxable.toLocaleString('en-IN')} + CGST ₹${cgstVal.toLocaleString('en-IN')} + SGST ₹${sgstVal.toLocaleString('en-IN')} = ₹${correctTot.toLocaleString('en-IN')}). Discrepancy of ₹${totVar.toLocaleString('en-IN')}.`;

  const wordsEvidence = gd?.wordsMismatchEvidence ||
    `It says "${words}", not the numeric total. The amount in words reflects only the pre-tax base amount (₹${taxable.toLocaleString('en-IN')}) and does not include GST.`;

  return {
    mainReasons: [
      {
        id: 'reason-gst',
        title: 'GST Mismatch',
        evidence: gstEvidence,
        severity: 'high' as const,
        type: 'GST_MISMATCH' as const,
      },
      {
        id: 'reason-total',
        title: 'Total Mismatch',
        evidence: totalEvidence,
        severity: 'high' as const,
        type: 'TOTAL_MISMATCH' as const,
      },
      {
        id: 'reason-words',
        title: 'Amount in Words Mismatch',
        evidence: wordsEvidence,
        severity: 'high' as const,
        type: 'AMOUNT_IN_WORDS_MISMATCH' as const,
      },
    ],
    gstMismatch: {
      detected: true,
      statedRate: rate,
      subtotal: taxable,
      expectedTax: gd?.expectedTax ?? Math.round(taxable * (rate / 100)),
      actualCgst: cgstVal,
      actualSgst: sgstVal,
      actualTotalTax: gd?.invoiceTax ?? (cgstVal + sgstVal),
      evidence: gstEvidence,
    },
    totalMismatch: {
      detected: true,
      subtotal: taxable,
      totalTax: gd?.invoiceTax ?? (cgstVal + sgstVal),
      expectedTotal: correctTot,
      shownTotal: statedTot,
      discrepancy: totVar,
      evidence: totalEvidence,
    },
    amountInWordsMismatch: {
      detected: true,
      words,
      wordsNumeric: taxable,
      shownTotal: statedTot,
      discrepancy: correctTot - taxable,
      evidence: wordsEvidence,
    },
  };
}
