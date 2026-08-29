import React from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import jsPDF from 'jspdf';
import { fetchGlobalReportSettings } from '@/hooks/useGlobalReportSettings';
import { drawJsPDFDisclaimerPage } from '@/utils/pdfDisclaimerPage';

interface QAPDFGeneratorProps {
  content: string;
  title: string;
  reportNames: string[];
  onComplete?: () => void;
}

export const QAPDFGenerator: React.FC<QAPDFGeneratorProps> = ({ 
  content, 
  title, 
  reportNames,
  onComplete 
}) => {
  const [isGenerating, setIsGenerating] = React.useState(false);

  const sanitizeForPDF = (text: string): string => {
    let clean = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
    clean = clean.replace(/%æ\s*/g, '- ');
    clean = clean.replace(/[≤≥→←↑↓•·…—–''""″′]/g, (ch) => {
      const map: Record<string, string> = {
        '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '↑': '^', '↓': 'v',
        '•': '-', '·': '-', '…': '...', '—': '--', '–': '-',
        '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
        '″': '"', '′': "'",
      };
      return map[ch] || ch;
    });
    clean = clean.replace(/"d\$/g, '<=$');
    clean = clean.replace(/[^\x00-\x7F]/g, (ch) => {
      if (/[àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ×÷]/.test(ch)) return ch;
      return '';
    });
    return clean;
  };

  const generatePDF = async () => {
    setIsGenerating(true);
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 20;
      const usableWidth = pageWidth - margin * 2;
      let yPos = margin;

      const globalSettings = await fetchGlobalReportSettings();
      const contact = globalSettings.contactDetails;
      const disclaimerSettings = globalSettings.disclaimer;

      const ensureSpace = (needed: number) => {
        if (yPos + needed > pageHeight - 25) {
          doc.addPage();
          yPos = margin;
        }
      };

      // ============= COVER PAGE =============
      let coverImageLoaded = false;
      try {
        const coverResponse = await fetch('/templates/npc-qa-cover.jpg');
        if (coverResponse.ok) {
          const coverBlob = await coverResponse.blob();
          const coverDataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(coverBlob);
          });
          doc.addImage(coverDataUrl, 'JPEG', 0, 0, pageWidth, pageHeight);
          coverImageLoaded = true;
        }
      } catch (e) {
        console.warn('Cover template not loaded, using fallback:', e);
      }

      if (!coverImageLoaded) {
        doc.setFillColor(15, 18, 25);
        doc.rect(0, 0, pageWidth, pageHeight, 'F');
        doc.setDrawColor(191, 155, 80);
        doc.setLineWidth(0.8);
        doc.line(pageWidth * 0.3, pageHeight * 0.42, pageWidth * 0.7, pageHeight * 0.42);
      }

      const dateStr = new Date().toLocaleDateString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      // ============= CONTENT PAGES =============
      doc.addPage();
      yPos = margin;

      // Content page header
      doc.setFillColor(15, 23, 42);
      doc.rect(0, 0, pageWidth, 35, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text(contact.company_name || 'Property Report', margin, 15);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text('Investment Property Analysis', margin, 22);
      doc.text(`Generated: ${dateStr}`, margin, 28);
      
      yPos = 45;
      doc.setTextColor(0, 0, 0);

      // Detect markdown table block
      const isTableLine = (line: string) => line.trim().startsWith('|') && line.trim().endsWith('|');
      const isSeparatorLine = (line: string) => /^\|[\s\-:]+(\|[\s\-:]+)+\|$/.test(line.trim());

      const drawTable = (tableLines: string[]) => {
        const parseRow = (line: string) =>
          line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => sanitizeForPDF(c.trim()));

        const header = parseRow(tableLines[0]);
        const bodyLines = tableLines.slice(2);
        const rows = bodyLines.map(parseRow);
        const colCount = header.length;

        const colWidths: number[] = [];
        const totalChars = header.reduce((sum, h, i) => {
          const maxLen = Math.max(h.length, ...rows.map(r => (r[i] || '').length));
          colWidths.push(maxLen);
          return sum + maxLen;
        }, 0);
        const colWidthsMM = colWidths.map(w => Math.max((w / totalChars) * usableWidth, 25));
        const totalMM = colWidthsMM.reduce((a, b) => a + b, 0);
        const scale = usableWidth / totalMM;
        const finalWidths = colWidthsMM.map(w => w * scale);

        const cellPadding = 2;
        const baseCellLineHeight = 3.8;

        // Helper: calculate the row height based on wrapped text in each cell
        const calcRowHeight = (cells: string[], fontSize: number): number => {
          doc.setFontSize(fontSize);
          let maxLines = 1;
          for (let c = 0; c < colCount; c++) {
            const cellText = cells[c] || '';
            const wrapped = doc.splitTextToSize(cellText, finalWidths[c] - cellPadding * 2);
            if (wrapped.length > maxLines) maxLines = wrapped.length;
          }
          return maxLines * baseCellLineHeight + 4;
        };

        // Calculate header row height
        doc.setFontSize(8);
        const headerRowH = calcRowHeight(header, 8);

        const minTableHeight = Math.min(headerRowH + rows.slice(0, 2).reduce((s, r) => s + calcRowHeight(r, 8), 0) + 4, 60);
        ensureSpace(minTableHeight);

        let xPos = margin;
        doc.setFillColor(240, 245, 255);
        doc.rect(margin, yPos - 5, usableWidth, headerRowH, 'F');
        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(15, 23, 42);
        for (let i = 0; i < colCount; i++) {
          const wrapped = doc.splitTextToSize(header[i], finalWidths[i] - cellPadding * 2);
          doc.text(wrapped, xPos + cellPadding, yPos);
          xPos += finalWidths[i];
        }
        doc.setDrawColor(200, 210, 230);
        doc.setLineWidth(0.3);
        doc.line(margin, yPos + headerRowH - 5, margin + usableWidth, yPos + headerRowH - 5);
        yPos += headerRowH;

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 51, 51);
        doc.setFontSize(8);
        for (const row of rows) {
          const dynRowH = calcRowHeight(row, 8);
          ensureSpace(dynRowH + 2);
          xPos = margin;
          for (let i = 0; i < colCount; i++) {
            const cellText = row[i] || '';
            const wrapped = doc.splitTextToSize(cellText, finalWidths[i] - cellPadding * 2);
            doc.text(wrapped, xPos + cellPadding, yPos);
            xPos += finalWidths[i];
          }
          doc.setDrawColor(230, 230, 230);
          doc.line(margin, yPos + dynRowH - 5, margin + usableWidth, yPos + dynRowH - 5);
          yPos += dynRowH;
        }
        yPos += 4;
      };

      const lines = content.split('\n');
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Collect table block
        if (isTableLine(trimmed)) {
          const tableLines: string[] = [];
          while (i < lines.length && isTableLine(lines[i].trim())) {
            if (!isSeparatorLine(lines[i].trim()) || tableLines.length === 1) {
              tableLines.push(lines[i]);
            }
            i++;
          }
          if (tableLines.length >= 2) {
            drawTable(tableLines);
          }
          continue;
        }

        ensureSpace(8);

        if (!trimmed) {
          yPos += 4;
          i++;
          continue;
        }

        // H1
        if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
          ensureSpace(20);
          yPos += 4;
          doc.setFontSize(16);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(15, 23, 42);
          const h1Text = sanitizeForPDF(trimmed.replace(/^# /, ''));
          const wrappedH1 = doc.splitTextToSize(h1Text, usableWidth);
          doc.text(wrappedH1, margin, yPos);
          yPos += wrappedH1.length * 7 + 2;
          doc.setDrawColor(59, 130, 246);
          doc.setLineWidth(0.5);
          doc.line(margin, yPos, pageWidth - margin, yPos);
          yPos += 6;
          i++;
          continue;
        }

        // H2
        if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
          ensureSpace(18);
          yPos += 3;
          doc.setFontSize(13);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(37, 99, 235);
          const h2Text = sanitizeForPDF(trimmed.replace(/^## /, ''));
          const wrappedH2 = doc.splitTextToSize(h2Text, usableWidth);
          doc.text(wrappedH2, margin, yPos);
          yPos += wrappedH2.length * 6 + 4;
          i++;
          continue;
        }

        // H3
        if (trimmed.startsWith('### ') && !trimmed.startsWith('#### ')) {
          ensureSpace(16);
          yPos += 2;
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(30, 64, 175);
          const h3Text = sanitizeForPDF(trimmed.replace(/^### /, ''));
          const wrappedH3 = doc.splitTextToSize(h3Text, usableWidth);
          doc.text(wrappedH3, margin, yPos);
          yPos += wrappedH3.length * 5 + 3;
          i++;
          continue;
        }

        // H5 (must be checked before H4)
        if (trimmed.startsWith('##### ')) {
          ensureSpace(14);
          yPos += 2;
          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(71, 85, 105);
          const h5Text = sanitizeForPDF(trimmed.replace(/^#####+ /, ''));
          const wrappedH5 = doc.splitTextToSize(h5Text, usableWidth);
          doc.text(wrappedH5, margin, yPos);
          yPos += wrappedH5.length * 4.5 + 3;
          i++;
          continue;
        }

        // H4
        if (trimmed.startsWith('#### ')) {
          ensureSpace(14);
          yPos += 2;
          doc.setFontSize(10);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(51, 65, 85);
          const h4Text = sanitizeForPDF(trimmed.replace(/^####+ /, ''));
          const wrappedH4 = doc.splitTextToSize(h4Text, usableWidth);
          doc.text(wrappedH4, margin, yPos);
          yPos += wrappedH4.length * 4.5 + 3;
          i++;
          continue;
        }

        // Horizontal rule
        if (trimmed === '---' || trimmed === '***') {
          yPos += 2;
          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.3);
          doc.line(margin, yPos, pageWidth - margin, yPos);
          yPos += 4;
          i++;
          continue;
        }

        // Numbered list items
        if (/^\d+\.\s/.test(trimmed)) {
          doc.setFontSize(10);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(51, 51, 51);
          const match = trimmed.match(/^(\d+\.)\s(.*)$/);
          if (match) {
            const num = match[1];
            const text = sanitizeForPDF(match[2]);
            doc.setFont('helvetica', 'bold');
            doc.text(num, margin + 2, yPos);
            doc.setFont('helvetica', 'normal');
            const wrappedNum = doc.splitTextToSize(text, usableWidth - 12);
            ensureSpace(wrappedNum.length * 4.5 + 2);
            doc.text(wrappedNum, margin + 10, yPos);
            yPos += wrappedNum.length * 4.5 + 2;
          }
          i++;
          continue;
        }

        // Nested bullet points
        if (/^\s{2,}-\s/.test(line) || trimmed.startsWith('- -') || trimmed.startsWith('%æ')) {
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(80, 80, 80);
          const bulletText = trimmed.replace(/^-\s*-\s*/, '').replace(/^-\s/, '').replace(/^%æ\s*/, '');
          const cleanText = sanitizeForPDF(bulletText);
          const wrappedBullet = doc.splitTextToSize(cleanText, usableWidth - 16);
          ensureSpace(wrappedBullet.length * 4 + 2);
          doc.text('-', margin + 8, yPos);
          doc.text(wrappedBullet, margin + 14, yPos);
          yPos += wrappedBullet.length * 4 + 1.5;
          i++;
          continue;
        }

        // Bullet points
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          doc.setFontSize(10);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(51, 51, 51);
          const bulletText = trimmed.replace(/^[-*] /, '');
          const cleanText = sanitizeForPDF(bulletText);
          const wrappedBullet = doc.splitTextToSize(cleanText, usableWidth - 10);
          ensureSpace(wrappedBullet.length * 4.5 + 2);
          doc.text('•', margin + 2, yPos);
          doc.text(wrappedBullet, margin + 8, yPos);
          yPos += wrappedBullet.length * 4.5 + 1.5;
          i++;
          continue;
        }

        // Bold-only lines (rendered as styled sub-headings)
        if (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.startsWith('***')) {
          ensureSpace(14);
          yPos += 2;
          doc.setFontSize(10.5);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(30, 41, 59);
          const boldText = sanitizeForPDF(trimmed.replace(/^\*\*|\*\*$/g, ''));
          const wrappedBold = doc.splitTextToSize(boldText, usableWidth);
          doc.text(wrappedBold, margin, yPos);
          yPos += wrappedBold.length * 4.5 + 3;
          i++;
          continue;
        }

        // Italic/meta lines
        if (trimmed.startsWith('*') && trimmed.endsWith('*') && !trimmed.startsWith('**')) {
          doc.setFontSize(8);
          doc.setFont('helvetica', 'italic');
          doc.setTextColor(120, 120, 120);
          const metaText = trimmed.replace(/^\*|\*$/g, '');
          const wrappedMeta = doc.splitTextToSize(metaText, usableWidth);
          ensureSpace(wrappedMeta.length * 3.5 + 2);
          doc.text(wrappedMeta, margin, yPos);
          yPos += wrappedMeta.length * 3.5 + 2;
          i++;
          continue;
        }

        // Regular text
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 51, 51);
        const cleanLine = sanitizeForPDF(trimmed);
        const wrappedText = doc.splitTextToSize(cleanLine, usableWidth);
        ensureSpace(wrappedText.length * 4.5 + 2);
        doc.text(wrappedText, margin, yPos);
        yPos += wrappedText.length * 4.5 + 2;
        i++;
      }

      // ============= DISCLAIMER & CONTACT PAGE =============
      drawJsPDFDisclaimerPage(doc, contact, disclaimerSettings);

      // Footer on each page (skip cover page = page 1, skip disclaimer = last page)
      const totalPages = doc.getNumberOfPages();
      const companyFooterName = contact.company_name || 'Property Report';
      for (let p = 1; p <= totalPages; p++) {
        if (p === 1 || p === totalPages) continue;
        doc.setPage(p);
        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(150, 150, 150);
        doc.text(
          `${companyFooterName} -- Confidential -- Page ${p - 1} of ${totalPages - 2}`,
          pageWidth / 2,
          pageHeight - 8,
          { align: 'center' }
        );
      }

      const fileName = reportNames.length > 0 
        ? `Summary - ${reportNames.join(', ')}.pdf`
        : `Q&A Summary - ${new Date().toLocaleDateString('en-AU')}.pdf`;
      
      doc.save(fileName);

      toast.success('PDF Downloaded', {
        description: 'Your summary has been exported',
      });

      onComplete?.();
    } catch (error) {
      console.error('PDF generation error:', error);
      toast.error('Export failed', {
        description: 'Failed to generate PDF',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={generatePDF}
      disabled={isGenerating}
      className="gap-1.5"
    >
      {isGenerating ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      PDF
    </Button>
  );
};
