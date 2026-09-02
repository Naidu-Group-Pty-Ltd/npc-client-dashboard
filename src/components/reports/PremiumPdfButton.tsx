import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { logActivityDirect } from "@/hooks/useActivityLogger";
import { FlattenPdfIconButton } from "@/components/common/FlattenPdfIconButton";
import { saveTemplateDocument } from "@/lib/reportTemplate/templateDocument";
import { produceInvestmentDocument } from "@/lib/reports/investment/deliverInvestmentPdf";
import type { PdfDesignOptions } from "./premiumPdfDesign";

interface PremiumPdfButtonProps {
  reportId: string;
  propertyAddress: string;
  includeCharts?: boolean;
  includeHeroImages?: boolean;
  includeSparklines?: boolean;
  designOptions?: PdfDesignOptions;
}

/**
 * Premium PDF — the standard delivery chain, from the panel.
 *
 * This button used to carry the chain itself (chosen template →
 * `render-investment-report-pdf`), and it was the only surface in the product
 * that had it; the page's primary Download shipped a `.txt` and Send-to-Client
 * shipped whatever `pdf_url` held. The chain lives in
 * `deliverInvestmentPdf.ts` now and every surface asks it — this button is one
 * caller among equals, keeping its design controls and the flatten companion.
 */
export function PremiumPdfButton({
  reportId,
  propertyAddress,
  includeCharts = true,
  includeHeroImages = false,
  includeSparklines = true,
  designOptions,
}: PremiumPdfButtonProps) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const doc = await produceInvestmentDocument(reportId, {
        includeCharts,
        includeHeroImages,
        includeSparklines,
        designOptions,
      });

      logActivityDirect({
        actionType: "report_pdf_downloaded",
        entityType: "investment_report",
        entityId: reportId,
        entityName: propertyAddress,
        metadata: { format: "pdf", source: "premium_weasyprint", designOptions },
      });

      saveTemplateDocument({ blob: doc.blob, fileName: doc.fileName, templateId: doc.templateId ?? "" });

      toast({
        title: "Premium PDF ready",
        description: doc.engine === "template"
          ? "Rendered with your report template. Your download should begin shortly."
          : "Rendered with the standard layout. Your download should begin shortly.",
      });
    } catch (err: any) {
      console.error("[PremiumPdfButton]", err);
      toast({
        title: "Premium PDF failed",
        description: err?.message || "Try the standard PDF or retry shortly.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const renderForFlatten = useCallback(async (): Promise<{ blob: Blob; fileName: string }> => {
    const doc = await produceInvestmentDocument(reportId, {
      includeCharts,
      includeHeroImages,
      includeSparklines,
      designOptions,
    });
    await logActivityDirect({
      actionType: "report_pdf_downloaded",
      entityType: "investment_report",
      entityId: reportId,
      entityName: propertyAddress,
      metadata: { format: "pdf", source: "premium_weasyprint", flattened: true, designOptions },
    });
    return { blob: doc.blob, fileName: doc.fileName };
  }, [reportId, propertyAddress, includeCharts, includeHeroImages, includeSparklines, designOptions]);

  return (
    <div className="inline-flex items-center gap-1">
      <Button
        variant="default"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        className="bg-gradient-to-r from-primary to-primary/70 hover:from-primary/90 hover:to-primary/60"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4 mr-1" />
        )}
        {loading ? "Rendering…" : "Premium PDF"}
      </Button>
      <FlattenPdfIconButton
        getPdfBlob={async () => (await renderForFlatten()).blob}
        filename={`investment-report-${reportId}.pdf`}
        disabled={loading}
      />
    </div>
  );
}
