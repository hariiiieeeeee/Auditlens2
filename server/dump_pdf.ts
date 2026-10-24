import fs from 'fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function dumpPdf() {
  const buf = fs.readFileSync('C:/Users/harid/Downloads/sample_uncertain_invoice_auditlens.pdf');
  const pdf = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  console.log(`PDF Pages: ${pdf.numPages}`);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
    console.log(`\n=== PAGE ${i} ===\n${pageText}`);
  }
}

dumpPdf().catch(console.error);
