import { parseOcrText, calculateOcrUncertainty, createOcrAnomalyRecord, buildForensicAnalysis } from '../src/engine/ocrEngine';
import { DocumentRecord } from '../src/types';

console.log('===========================================================');
console.log(' AUDITLENS OCR & FORENSIC DISCREPANCY UNIT TEST (USER CASE)');
console.log('===========================================================\n');

const rawInvoiceText = `
TAX INVOICE
Vendor: Skyline Tech Solutions Pvt Ltd
Invoice No: INV-2026-9042
Date: 2026-10-18

Description: Cloud Infrastructure Maintenance Services
Subtotal: ₹15,000.00
GST @ 18%
CGST (9%): ₹1,350.00
SGST (9%): ₹1,350.00

Total: ₹16,200.00
Amount in words: Rupees Fifteen Thousand Only

Bank Details:
Bank: State Bank of India
A/c No: 009182736451
IFSC: SBIN0001234
`;

const parsed = parseOcrText(rawInvoiceText, 'Skyline_Invoice_16200.pdf', 0.94);

console.log('--- 1. OCR Extraction Verification ---');
console.log(`Subtotal: ₹${parsed.subtotal}`);
console.log(`CGST: ₹${parsed.cgst}`);
console.log(`SGST: ₹${parsed.sgst}`);
console.log(`GST Rate: ${parsed.gstRate}%`);
console.log(`Tax: ₹${parsed.tax}`);
console.log(`Stated Total (Printed on invoice): ₹${parsed.statedTotal}`);
console.log(`Extracted Total: ₹${parsed.total}`);
console.log(`Correct / Expected Total: ₹${parsed.correctTotal}`);
console.log(`Amount in Words: "${parsed.amountInWords}"`);

let passed = true;

if (parsed.statedTotal !== 16200) {
  console.error(`FAIL: Stated total should be 16200, got ${parsed.statedTotal}`);
  passed = false;
} else {
  console.log('✓ PASS: Stated Total correctly read as 16,200');
}

if (parsed.total !== 16200) {
  console.error(`FAIL: Total displayed should be 16200 (the stated amount), got ${parsed.total}`);
  passed = false;
} else {
  console.log('✓ PASS: Extracted Total correctly preserved as 16,200 (not overwritten to 17,700)');
}

if (parsed.correctTotal !== 17700) {
  console.error(`FAIL: Correct total should be 17700, got ${parsed.correctTotal}`);
  passed = false;
} else {
  console.log('✓ PASS: Correct / Expected total calculated as 17,700');
}

const mockDoc: DocumentRecord = {
  id: 'doc-test-1',
  filename: 'Skyline_Invoice_16200.pdf',
  type: 'invoice_pdf',
  uploadDate: '2026-10-24',
  processingStatus: 'flagged',
  extractedFields: {
    ...parsed,
    expectedTotal: parsed.correctTotal,
  },
  sourceReference: 'Manual Test Ingest',
  visualFlags: parsed.visualFlags,
};

const anomaly = createOcrAnomalyRecord(mockDoc, parsed);
const forensicAnalysis = buildForensicAnalysis(parsed.uncertaintyReport.gstDiscrepancy);

console.log('\n--- 2. Forensic Anomaly & Evidence Verification ---');
console.log(`Anomaly Title: "${anomaly.title}"`);
console.log(`Dispute Amount (Variance): ₹${anomaly.amountInDispute}`);
console.log(`Explanation:\n${anomaly.explanation}\n`);

console.log('--- 3. Primary Reasons in Forensic Analysis ---');
forensicAnalysis.mainReasons.forEach((r, i) => {
  console.log(`Reason ${i + 1} [${r.title}]:`);
  console.log(`  Evidence: ${r.evidence}`);
});

// Check Reason 1: GST Mismatch
const reason1 = forensicAnalysis.mainReasons.find(r => r.type === 'GST_MISMATCH');
if (reason1 && reason1.evidence.includes('1,350') && reason1.evidence.includes('15,000')) {
  console.log('✓ PASS: Reason 1 (GST Mismatch) properly states evidence with 1,350 CGST/SGST and 15,000 base');
} else {
  console.error('FAIL: Reason 1 (GST Mismatch) not properly specified');
  passed = false;
}

// Check Reason 2: Total Mismatch
const reason2 = forensicAnalysis.mainReasons.find(r => r.type === 'TOTAL_MISMATCH');
if (reason2 && reason2.evidence.includes('16,200') && reason2.evidence.includes('17,700')) {
  console.log('✓ PASS: Reason 2 (Total Mismatch) properly states evidence with shown 16,200 vs expected 17,700');
} else {
  console.error('FAIL: Reason 2 (Total Mismatch) not properly specified');
  passed = false;
}

// Check Reason 3: Amount in Words Mismatch
const reason3 = forensicAnalysis.mainReasons.find(r => r.type === 'AMOUNT_IN_WORDS_MISMATCH');
if (reason3 && reason3.evidence.includes('Rupees Fifteen Thousand Only')) {
  console.log('✓ PASS: Reason 3 (Amount in Words Mismatch) properly states evidence with "Rupees Fifteen Thousand Only"');
} else {
  console.error('FAIL: Reason 3 (Amount in Words Mismatch) not properly specified');
  passed = false;
}

console.log('\n-----------------------------------------------------------');
if (passed) {
  console.log('ALL 3 REASONS AND TOTAL AMOUNT PROPERLY VERIFIED (100% PASS)!');
  process.exit(0);
} else {
  console.error('TESTS FAILED');
  process.exit(1);
}
