import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Bath, BedDouble, Boxes, Car, CheckCircle2, ChevronLeft, ChevronRight, FileImage,
  FileSpreadsheet, Globe, Image as ImageIcon, ImageDown, ImageOff, Link2, Loader2, Map, Plus,
  RefreshCw, Search, Sparkles, Trash2, Upload, UserCheck, type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderPortalMetricCard } from '@/components/builder-portal/ui/BuilderPortalMetricCard';
import { useDebounce } from '@/hooks/useDebounce';
import {
  importBuilderStockUrl,
  useAcknowledgeStockSelection, useBuilderStockItems, useBuilderStockSelections,
  useBuilderStockUploads, useDeleteBuilderStockSource, useEnrichPendingStockImages,
  useRecoverStockSourceImages, useSetBuilderStockAvailability, uploadBuilderStockFile,
  type StockImportSummary, type StockUploadProgress, type StockUploadResult,
} from '@/lib/builderStockQueries';
import {
  formatFileSize, primaryStockImage, stockFileAcceptAttribute, stockImageStageSummary,
  stockItemConfiguration, stockItemLocality, stockItemPrice, stockItemTitle,
  MAX_STOCK_FILE_BYTES, STOCK_AVAILABILITY_CLASSES, STOCK_AVAILABILITY_LABELS,
  STOCK_IMAGE_STAGE_BADGES, STOCK_SELECTION_STATUS_LABELS, STOCK_UPLOAD_STATUS_CLASSES,
  STOCK_UPLOAD_STATUS_LABELS, STOCK_SOURCE_TYPE_LABELS, stockSourceLabel,
  type BuilderStockItem, type BuilderStockUpload, type StockAvailability,
  type StockImageStage, type StockSelectionStatus, type StockUploadStatus,
} from '@/lib/builderStock';
import { isNonBlockingSourceNotice } from '../../../supabase/functions/_shared/builderStock/sourceAccessNotice.pure';

/**
 * Builder Portal — Stock List.
 *
 * The builder's side of the Stock List → Property Marketplace feature: upload a
 * schedule in whatever format the sales team keeps it in, watch it import, and
 * see which of the resulting properties a Command Centre adviser has selected
 * for a buyer.
 *
 * Nothing here names an organisation. The server holds the active organisation
 * on the session and scopes every query to it, so this page cannot ask for
 * another builder's stock even if somebody edits its state.
 *
 * The upload control accepts every format the reader supports, not PDFs — the
 * `accept` attribute is derived from `STOCK_EXTENSIONS`, so the picker and the
 * server's classifier cannot drift apart.
 */

const AVAILABILITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All availability' },
  { value: 'available', label: 'Available' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'contracted', label: 'Under contract' },
  { value: 'sold', label: 'Sold' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'unknown', label: 'Not stated' },
];

const SETTABLE_AVAILABILITY: StockAvailability[] = [
  'available', 'on_hold', 'reserved', 'contracted', 'sold', 'settled', 'withdrawn',
];

/**
 * Only the steps a builder is actually waiting on.
 *
 * "Processing supplied images" and "Finding images" used to sit at the end of
 * this list. They were not steps of the import — they were the browser driving
 * image work, and one of them held this dialog open for twenty minutes on a
 * list that had already imported in nineteen seconds. Imagery is the backend's
 * now, so the last thing the builder waits for is the properties being saved.
 */
const PHASE_LABEL: Record<StockUploadProgress['phase'], string> = {
  requesting: 'Preparing the upload',
  uploading: 'Uploading the file',
  processing: 'Reading the properties',
  done: 'Finished',
};

const PHASE_PERCENT: Record<StockUploadProgress['phase'], number> = {
  requesting: 15, uploading: 45, processing: 80, done: 100,
};

export default function BuilderStockList() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState('all');
  const [uploadFilter, setUploadFilter] = useState('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search, 300);

  const [progress, setProgress] = useState<StockUploadProgress | null>(null);
  const [lastSummary, setLastSummary] = useState<StockImportSummary | null>(null);
  /**
   * Properties the backend still owes imagery, as the import reported it.
   *
   * Held beside the summary rather than inside it because it is a fact about
   * the QUEUE and not about the file: the summary says what was read and
   * saved, this says what is still being worked on without anybody waiting.
   */
  const [lastImageWorkPending, setLastImageWorkPending] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [pendingDelete, setPendingDelete] = useState<BuilderStockUpload | null>(null);

  useEffect(() => { setPage(1); }, [debounced, availability, uploadFilter]);

  const uploadsQuery = useBuilderStockUploads(1);
  const selectionsQuery = useBuilderStockSelections(1);
  const itemsQuery = useBuilderStockItems({
    search: debounced.trim(),
    availability: availability === 'all' ? '' : availability,
    uploadId: uploadFilter === 'all' ? '' : uploadFilter,
    page,
    pageSize: 25,
  });

  const setAvailabilityMutation = useSetBuilderStockAvailability();
  const acknowledge = useAcknowledgeStockSelection();
  const enrichPending = useEnrichPendingStockImages();
  const deleteSource = useDeleteBuilderStockSource();
  const recoverImages = useRecoverStockSourceImages();

  const records = itemsQuery.data?.records ?? [];
  const pagination = itemsQuery.data?.pagination;
  const uploads = uploadsQuery.data?.records ?? [];
  const selections = selectionsQuery.data?.records ?? [];

  const pendingSelections = useMemo(
    () => selections.filter((selection) => selection.status === 'selected'),
    [selections],
  );

  const refreshAll = useCallback(() => {
    void itemsQuery.refetch();
    void uploadsQuery.refetch();
    void selectionsQuery.refetch();
  }, [itemsQuery, uploadsQuery, selectionsQuery]);

  const reportImport = useCallback((result: StockUploadResult) => {
    const imported = result.summary;
    setLastSummary(imported);
    setLastImageWorkPending(result.imageWorkPending);
    toast({
      title: 'Stock list imported',
      description: `${imported.imported} new and ${imported.updated} updated from ${imported.detected} propert${imported.detected === 1 ? 'y' : 'ies'}.`
        + (result.imageWorkPending
          ? ' Images are still being found — you can close this page.'
          : ''),
    });
    refreshAll();
  }, [refreshAll, toast]);

  const reportImportFailure = useCallback((error: unknown) => {
    const failure = error as Error & { code?: string };
    const duplicate = failure.code === 'duplicate_file';
    /**
     * A REQUEST THAT NEVER ANSWERED DID NOT NECESSARILY FAIL.
     *
     * `transport_failed` means the browser got no response at all, so this
     * page does not know whether the import ran — and in production it HAD
     * run. Announcing "could not be imported" there is not a cautious message,
     * it is a false one, and it is what led to the same list being imported
     * twice. The sources list is refreshed below either way, so the honest
     * heading sends the reader to the answer rather than away from it.
     */
    /*
     * A DEADLINE IS THE SAME KIND OF SILENCE. `deadline_exceeded` is this
     * page's own clock giving up on a request that never answered — which is
     * precisely the state `transport_failed` describes, reached deliberately
     * rather than by the socket dying. Both mean the browser does not know,
     * and neither may be reported as a failed import.
     */
    const undetermined = failure.code === 'transport_failed'
      || failure.code === 'deadline_exceeded';
    toast({
      title: duplicate
        ? 'Already imported'
        : undetermined
          ? 'This import did not report back'
          : 'The stock list could not be imported',
      description: undetermined
        ? `${failure.message} If it appears in your sources below, it worked.`
        : failure.message,
      variant: duplicate || undetermined ? 'default' : 'destructive',
    });
    void uploadsQuery.refetch();
  }, [toast, uploadsQuery]);

  /**
   * Re-read one source and attach the imagery it supplied.
   *
   * For stock that is already imported: the properties, their prices, their
   * availability and every client selection stay exactly where they are, and
   * only the pictures change.
   */
  const recoverSourceImages = useCallback((upload: BuilderStockUpload) => {
    recoverImages.mutate(upload.id, {
      onSuccess: (response) => {
        const result = response.results?.[0];
        if (result?.error) {
          toast({
            title: 'That source could not be read again',
            description: result.error,
            variant: 'destructive',
          });
          return;
        }
        const stored = result?.images_stored ?? 0;
        toast({
          title: stored
            ? `${stored} supplied image${stored === 1 ? '' : 's'} recovered`
            : 'No supplied images were found',
          description: stored
            ? `${result?.primary_updated ?? 0} propert${(result?.primary_updated ?? 0) === 1 ? 'y' : 'ies'} now show the builder's own photograph.`
            : 'This source does not carry a photograph for any of its properties.',
        });
        refreshAll();
      },
      onError: (error: unknown) => {
        toast({
          title: 'The source images could not be recovered',
          description: (error as Error).message,
          variant: 'destructive',
        });
      },
    });
  }, [recoverImages, refreshAll, toast]);

  const handleFile = useCallback(async (file: File) => {
    if (file.size > MAX_STOCK_FILE_BYTES) {
      toast({
        title: 'That file is too large',
        description: `The limit is ${Math.round(MAX_STOCK_FILE_BYTES / (1024 * 1024))} MB.`,
        variant: 'destructive',
      });
      return;
    }

    setLastSummary(null);
    setLastImageWorkPending(0);
    try {
      const result = await uploadBuilderStockFile(file, setProgress);
      reportImport(result);
    } catch (error) {
      reportImportFailure(error);
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [reportImport, reportImportFailure]);

  /**
   * A linked source. The browser sends the address and nothing else — the
   * server fetches it, snapshots it and runs the same import a file gets.
   */
  const handleUrl = useCallback(async () => {
    const value = sourceUrl.trim();
    if (!value) return;
    setLastSummary(null);
    setLastImageWorkPending(0);
    try {
      const result = await importBuilderStockUrl(value, setProgress);
      reportImport(result);
      setSourceUrl('');
      setAddOpen(false);
    } catch (error) {
      reportImportFailure(error);
    } finally {
      setProgress(null);
    }
  }, [reportImport, reportImportFailure, sourceUrl]);

  const busy = progress !== null;

  const summary = [
    { label: 'Properties listed', value: pagination?.total ?? records.length, icon: Boxes },
    { label: 'Stock lists uploaded', value: uploadsQuery.data?.pagination.total ?? uploads.length, icon: FileSpreadsheet },
    { label: 'Awaiting your acknowledgement', value: pendingSelections.length, icon: UserCheck },
  ];

  return (
    <BuilderPortalShell
      title="Stock List"
      description="Upload your available stock in whatever format you keep it, and see which properties have been selected for a buyer."
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={itemsQuery.isFetching || busy}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', itemsQuery.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={busy}>
            {busy
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <Plus className="mr-2 h-4 w-4" aria-hidden />}
            Add stock list
          </Button>
        </>
      }
    >
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        accept={stockFileAcceptAttribute()}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) { setAddOpen(false); void handleFile(file); }
        }}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {summary.map(({ label, value, icon }) => (
          <BuilderPortalMetricCard key={label} icon={icon} label={label} value={value} />
        ))}
      </div>

      {progress ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="text-sm font-medium">{PHASE_LABEL[progress.phase]}</div>
            <Progress value={PHASE_PERCENT[progress.phase]} />
            <p className="text-xs text-muted-foreground">
              Images are found in the background once the properties are saved. You can close this page as soon as the import finishes.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {lastSummary
        ? <ImportSummaryCard summary={lastSummary} imageWorkPending={lastImageWorkPending} />
        : null}

      {pendingSelections.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Selected for a buyer</CardTitle>
            <CardDescription>
              A Command Centre adviser has selected these properties from your stock list.
              Acknowledge each one to confirm you have seen it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingSelections.map((selection) => (
              <div
                key={selection.id}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {selection.stock_item
                      ? stockItemTitle(selection.stock_item as never)
                      : 'A property from your stock'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Selected {new Date(selection.selected_at).toLocaleString('en-AU')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={acknowledge.isPending}
                  onClick={() => {
                    acknowledge.mutate(selection.id, {
                      onSuccess: () => toast({ title: 'Acknowledged' }),
                      onError: (error) => toast({
                        title: 'Could not acknowledge',
                        description: (error as Error).message,
                        variant: 'destructive',
                      }),
                    });
                  }}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden />
                  Acknowledge
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="gap-4">
          <div className="min-w-0">
            <CardTitle className="text-base">Your stock</CardTitle>
            <CardDescription>
              Properties imported from your stock lists. These are what the Command Centre sees.
            </CardDescription>
          </div>
          {/*
            One toolbar rather than three stacked controls. The search takes the
            slack (`flex-1` over a `basis-64` floor) and the two filters hold a
            fixed compact width, so at narrow widths they wrap onto their own
            line instead of forcing the card wider than the column.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-64">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search address, suburb, development or reference"
                className="h-9 w-full pl-9"
                aria-label="Search stock"
              />
            </div>
            <Select value={availability} onValueChange={setAvailability}>
              <SelectTrigger
                className="h-9 w-full min-w-0 sm:w-44"
                aria-label="Filter by availability"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVAILABILITY_FILTERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={uploadFilter} onValueChange={setUploadFilter}>
              <SelectTrigger
                className="h-9 w-full min-w-0 sm:w-56"
                aria-label="Filter by stock list"
              >
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stock lists</SelectItem>
                {uploads.map((upload) => (
                  <SelectItem key={upload.id} value={upload.id}>
                    {upload.original_filename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {itemsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading your stock…
            </div>
          ) : itemsQuery.isError ? (
            <div className="py-12 text-center text-sm text-destructive">
              {(itemsQuery.error as Error).message}
            </div>
          ) : !records.length ? (
            <div className="py-12 text-center">
              <Boxes className="mx-auto h-10 w-10 text-muted-foreground/50" aria-hidden />
              <p className="mt-3 text-sm font-medium">
                {debounced || availability !== 'all' || uploadFilter !== 'all'
                  ? 'No stock matches those filters'
                  : 'No stock has been uploaded yet'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {debounced || availability !== 'all' || uploadFilter !== 'all'
                  ? 'Clear the filters to see everything you have uploaded.'
                  : 'Upload a spreadsheet, CSV, Word document, PDF or photograph of your schedule.'}
              </p>
            </div>
          ) : (
            <>
              {/*
                Two presentations of the same rows, the same data and the same
                controls.

                The cut is 1400px rather than a named breakpoint because it is
                measured, not chosen: a 288px sidebar and the content gutters
                leave ~1030px there, which is the width at which six columns
                seat "Under contract" in a select and "Builder supplied" on a
                badge without either being cut short. Below it the identical
                fields stack into cards — a complete card beats a squeezed row,
                and neither presentation needs a scroller.
              */}
              <div className="hidden min-[1400px]:block">
                <Table className="table-fixed">
                  <TableHeader>
                    {/* Percentages, not rem: the columns divide whatever the
                        content area is, so the table can never be wider than
                        the card that holds it. */}
                    <TableRow>
                      <TableHead className="w-[26%] px-3">Property</TableHead>
                      <TableHead className="w-[14%] px-3">Configuration</TableHead>
                      <TableHead className="w-[14%] px-3">Price</TableHead>
                      <TableHead className="w-[15%] px-3">Images</TableHead>
                      <TableHead className="w-[18%] px-3">Availability</TableHead>
                      <TableHead className="w-[13%] px-3">Selected</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {records.map((item) => (
                      <StockRow
                        key={item.id}
                        item={item}
                        saving={setAvailabilityMutation.isPending}
                        onAvailabilityChange={(next) => {
                          setAvailabilityMutation.mutate(
                            { stockItemId: item.id, availability: next },
                            {
                              onError: (error) => toast({
                                title: 'Could not update availability',
                                description: (error as Error).message,
                                variant: 'destructive',
                              }),
                            },
                          );
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>

              <ul className="space-y-3 min-[1400px]:hidden">
                {records.map((item) => (
                  <StockCard
                    key={item.id}
                    item={item}
                    saving={setAvailabilityMutation.isPending}
                    onAvailabilityChange={(next) => {
                      setAvailabilityMutation.mutate(
                        { stockItemId: item.id, availability: next },
                        {
                          onError: (error) => toast({
                            title: 'Could not update availability',
                            description: (error as Error).message,
                            variant: 'destructive',
                          }),
                        },
                      );
                    }}
                  />
                ))}
              </ul>

              {pagination && pagination.total_pages > 1 ? (
                <div className="mt-4 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Page {pagination.page} of {pagination.total_pages} · {pagination.total} properties
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline" size="sm" disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                      Previous
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      disabled={page >= pagination.total_pages}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Stock list sources</CardTitle>
            <CardDescription>
              Every stock list you have added — uploaded or linked — and what happened to it.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={enrichPending.isPending}
            onClick={() => {
              enrichPending.mutate(undefined, {
                onSuccess: (result) => toast({
                  title: result.processed
                    ? `Images found for ${result.processed} propert${result.processed === 1 ? 'y' : 'ies'}`
                    : 'Nothing was waiting for images',
                  description: result.remaining ? `${result.remaining} still to go.` : undefined,
                }),
                onError: (error) => toast({
                  title: 'Image lookup could not run',
                  description: (error as Error).message,
                  variant: 'destructive',
                }),
              });
            }}
          >
            {enrichPending.isPending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
            Retry image lookup
          </Button>
        </CardHeader>
        <CardContent>
          {!uploads.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No stock lists have been added yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>Properties</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uploads.map((upload) => (
                    <TableRow key={upload.id}>
                      <TableCell>
                        <p className="max-w-[18rem] truncate text-sm font-medium" title={stockSourceLabel(upload)}>
                          {stockSourceLabel(upload)}
                        </p>
                        <p className="max-w-[18rem] truncate text-xs text-muted-foreground">
                          {upload.source_type === 'url' && upload.source_url
                            ? upload.source_url
                            : formatFileSize(upload.byte_size)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-medium">
                          {upload.source_type === 'url'
                            ? <Link2 className="mr-1 h-3 w-3" aria-hidden />
                            : <Upload className="mr-1 h-3 w-3" aria-hidden />}
                          {STOCK_SOURCE_TYPE_LABELS[upload.source_type] ?? upload.source_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(upload.created_at).toLocaleString('en-AU')}
                      </TableCell>
                      <TableCell className="text-sm">
                        {upload.records_detected
                          ? `${upload.records_imported} new · ${upload.records_updated} updated`
                          : '—'}
                        {upload.records_failed ? (
                          <span className="block text-xs text-warning">
                            {upload.records_failed} could not be saved
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn('font-medium', STOCK_UPLOAD_STATUS_CLASSES[upload.status as StockUploadStatus])}
                        >
                          {STOCK_UPLOAD_STATUS_LABELS[upload.status as StockUploadStatus] ?? upload.status}
                        </Badge>
                        {upload.error_message ? (
                          /*
                           * A SOURCE-ACCESS ERROR IS AN ERROR, AND THE UPLOAD
                           * STILL SUCCEEDED.
                           *
                           * Both facts have to survive the same row. A Google
                           * Sheet shared so anyone with the link may view it
                           * answers for its property rows and can still refuse
                           * the workbook its link targets live in — so the
                           * import is complete, the badge says so, and this
                           * says what could not be reached. Muted grey read as
                           * a footnote and nobody saw it; failing the upload
                           * would send a builder to re-import a list that is
                           * already in.
                           */
                          <p
                            className={cn(
                              'mt-1 flex max-w-[22rem] items-start gap-1.5 text-xs',
                              isNonBlockingSourceNotice(upload.error_code)
                                ? 'rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive'
                                : 'text-muted-foreground',
                            )}
                          >
                            {isNonBlockingSourceNotice(upload.error_code) ? (
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            ) : null}
                            <span>{upload.error_message}</span>
                          </p>
                        ) : null}
                        {upload.image_stage_summary
                          && Object.keys(upload.image_stage_summary).length ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Images: {Object.entries(upload.image_stage_summary)
                              .map(([stage, states]) =>
                                `${stage.replace(/_/g, ' ')} ${states.ready ?? 0}`)
                              .join(' · ')}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {/*
                          Recover the imagery this source supplied.
                          For stock that is already imported: the source is read
                          again and the builder's own photographs are attached to
                          the properties they came from. Nothing is re-imported,
                          so prices, availability and client selections are
                          untouched — deleting and re-uploading a stock list to
                          fix a picture is not a repair.
                        */}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={recoverImages.isPending || deleteSource.isPending || busy}
                          onClick={() => recoverSourceImages(upload)}
                          aria-label={`Recover source images for ${stockSourceLabel(upload)}`}
                        >
                          <ImageDown className="h-4 w-4" aria-hidden />
                          <span className="sr-only sm:not-sr-only sm:ml-2">Source images</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={deleteSource.isPending || busy}
                          onClick={() => setPendingDelete(upload)}
                          aria-label={`Delete ${stockSourceLabel(upload)}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                          <span className="sr-only sm:not-sr-only sm:ml-2">Delete</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add a source: a file from this computer, or an address to fetch. */}
      <Dialog open={addOpen} onOpenChange={(open) => { if (!busy) setAddOpen(open); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a stock list</DialogTitle>
            <DialogDescription>
              Upload a file, or paste a link and we will fetch it for you.
              Both are read the same way.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="file">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="file">
                <Upload className="mr-2 h-4 w-4" aria-hidden />
                Upload file
              </TabsTrigger>
              <TabsTrigger value="url">
                <Link2 className="mr-2 h-4 w-4" aria-hidden />
                Add from URL
              </TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="space-y-3 pt-4">
              <p className="text-sm text-muted-foreground">
                Spreadsheets (XLSX, XLS, ODS, CSV), documents (DOCX, ODT, RTF, PDF),
                web pages (HTML), data (JSON, XML), presentations (PPTX) and
                photographs of a printed schedule.
              </p>
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  : <Upload className="mr-2 h-4 w-4" aria-hidden />}
                Choose a file
              </Button>
            </TabsContent>

            <TabsContent value="url" className="space-y-3 pt-4">
              <div className="space-y-2">
                <Label htmlFor="builder-stock-url">Stock list URL</Label>
                <Input
                  id="builder-stock-url"
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://example.com/stock-list"
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy && sourceUrl.trim()) void handleUrl();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  A web page, a direct link to a spreadsheet or PDF, or a Notion page
                  you have shared publicly. The page is saved at the moment it is
                  imported, so later edits do not change what was brought in.
                </p>
              </div>
              <Button
                className="w-full"
                disabled={busy || !sourceUrl.trim()}
                onClick={() => void handleUrl()}
              >
                {busy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  : <Link2 className="mr-2 h-4 w-4" aria-hidden />}
                Import stock list
              </Button>
            </TabsContent>
          </Tabs>

          {progress ? (
            <div className="space-y-2">
              <Progress value={PHASE_PERCENT[progress.phase]} />
              <p className="text-xs text-muted-foreground">{PHASE_LABEL[progress.phase]}</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/*
        Deletion is explicit and says what it will do. A builder removing a
        source is saying "this should no longer supply stock", not "erase the
        record" — so the copy names the marketplace consequence and the fact
        that selections already made are kept.
      */}
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDelete ? stockSourceLabel(pendingDelete) : ''}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Properties this stock list is currently supplying will be removed from
              the Builder Stock marketplace straight away. Properties a newer stock
              list also supplies will stay. Any property already selected for a buyer
              keeps its record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSource.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteSource.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!pendingDelete) return;
                deleteSource.mutate(pendingDelete.id, {
                  onSuccess: (result) => {
                    const removed = result.removed;
                    toast({
                      title: 'Stock list deleted',
                      description: removed.archived === 1
                        ? '1 property was removed from the marketplace.'
                        : `${removed.archived} properties were removed from the marketplace.`,
                    });
                    setPendingDelete(null);
                    refreshAll();
                  },
                  // The source stays visible on failure — the UI never pretends
                  // a delete happened.
                  onError: (error) => toast({
                    title: 'The stock list could not be deleted',
                    description: (error as Error).message,
                    variant: 'destructive',
                  }),
                });
              }}
            >
              {deleteSource.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                : <Trash2 className="mr-2 h-4 w-4" aria-hidden />}
              Delete stock list
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BuilderPortalShell>
  );
}

function ImportSummaryCard(
  { summary, imageWorkPending }: { summary: StockImportSummary; imageWorkPending: number },
) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Last import</CardTitle>
        <CardDescription>
          {summary.detected} propert{summary.detected === 1 ? 'y was' : 'ies were'} read from the file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-4">
          <span><strong className="tabular-nums">{summary.imported}</strong> new</span>
          <span><strong className="tabular-nums">{summary.updated}</strong> updated</span>
          {summary.failed ? (
            <span className="text-warning">
              <strong className="tabular-nums">{summary.failed}</strong> not saved
            </span>
          ) : null}
        </div>
        {/*
          * SAID PLAINLY, BECAUSE A FINISHED IMPORT IS NOT A FINISHED PICTURE.
          *
          * The dialog no longer waits for imagery, so this is the only place a
          * builder learns there is still work — and the only honest reading of
          * a successful import is "the properties are saved, the pictures are
          * coming". Claiming otherwise by saying nothing is what a summary of
          * a completed import would otherwise imply.
          */}
        {imageWorkPending ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Images are still being found for {imageWorkPending} propert{imageWorkPending === 1 ? 'y' : 'ies'}. This continues on our
            servers — you do not need to keep this page open.
          </p>
        ) : null}
        {summary.warnings.map((warning) => (
          <p key={warning} className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {warning}
          </p>
        ))}
        {summary.failures.length ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {summary.failures.map((failure, index) => (
              <li key={`${failure.label}-${index}`}>
                <span className="font-medium text-foreground">{failure.label}</span> — {failure.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stock row presentation
//
// One set of field renderers, drawn either into a table cell (xl and up) or
// into a stacked card (below xl), so the two presentations cannot drift. Every
// one of them reads the same fields the previous single table row read, and
// none of them decides anything: no filtering, no derived availability, no
// selection state of its own.
// ---------------------------------------------------------------------------

/**
 * The selection badge's tint, drawn only from the availability palette this
 * module already ships — no new colour values. Selection statuses are the
 * server's; nothing here adds one.
 */
const SELECTION_STATUS_CLASSES: Record<StockSelectionStatus, string> = {
  selected: STOCK_AVAILABILITY_CLASSES.on_hold,
  builder_acknowledged: STOCK_AVAILABILITY_CLASSES.contracted,
  progressed: STOCK_AVAILABILITY_CLASSES.contracted,
  completed: STOCK_AVAILABILITY_CLASSES.available,
  withdrawn: STOCK_AVAILABILITY_CLASSES.sold,
};

/** Short forms of the image-stage labels, for chips too narrow for the full one. */
const STOCK_IMAGE_STAGE_SHORT_LABELS: Record<StockImageStage, string> = {
  uploaded_document: 'Stock list',
  google_maps: 'Street View',
  internet_search: 'Online',
};

const STOCK_IMAGE_STAGE_ICONS: Record<StockImageStage, LucideIcon> = {
  uploaded_document: FileImage,
  google_maps: Map,
  internet_search: Globe,
};

/**
 * The amount, and whatever the builder's file said around it.
 *
 * Presentation only: the string `stockItemPrice` returns is split at the first
 * currency figure and both halves are printed, in the order they were written.
 * Nothing is dropped or reformatted — "From $749,000" keeps its "From", and the
 * full line is carried on `title` as well. A price is the offer; setting the
 * qualifier a size down makes the figure scannable without editing it.
 */
const PRICE_AMOUNT = /^([\s\S]*?\$\s?[\d,]+(?:\.\d+)?)\s*([\s\S]*)$/;

function splitPriceLine(price: string | null): { amount: string; qualifier: string | null } {
  if (!price) return { amount: '—', qualifier: null };
  const match = PRICE_AMOUNT.exec(price.trim());
  if (!match) return { amount: price, qualifier: null };
  return { amount: match[1], qualifier: match[2] || null };
}

function PropertyIdentity({ item }: { item: BuilderStockItem }) {
  const title = stockItemTitle(item);
  const locality = stockItemLocality(item);
  return (
    <div className="min-w-0">
      {/* Wraps to a second line rather than truncating: an address is what
          identifies the property, and half of one identifies nothing. */}
      <p className="break-words text-sm font-medium leading-snug text-foreground">{title}</p>
      {locality || item.external_reference ? (
        <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">
          {locality}
          {locality && item.external_reference ? ' · ' : ''}
          {item.external_reference ? `Ref ${item.external_reference}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Bedrooms, bathrooms and car spaces as three compact chips instead of a
 * sentence. The words are kept for screen readers and on hover, so nothing the
 * text form said is lost.
 */
function ConfigurationChips({ item, hideWhenEmpty = false }: {
  item: BuilderStockItem;
  /** Cards omit an absent field; a table column still needs its placeholder. */
  hideWhenEmpty?: boolean;
}) {
  const configuration = stockItemConfiguration(item);
  if (!configuration) {
    return hideWhenEmpty ? null : <span className="text-sm text-muted-foreground">—</span>;
  }

  const parts: Array<{ icon: LucideIcon; value: number; label: string }> = [];
  if (item.bedrooms !== null && item.bedrooms !== undefined) {
    parts.push({ icon: BedDouble, value: item.bedrooms, label: 'bed' });
  }
  if (item.bathrooms !== null && item.bathrooms !== undefined) {
    parts.push({ icon: Bath, value: item.bathrooms, label: 'bath' });
  }
  if (item.car_spaces !== null && item.car_spaces !== undefined) {
    parts.push({ icon: Car, value: item.car_spaces, label: 'car' });
  }

  return (
    <ul className="flex flex-wrap items-center gap-1" title={configuration}>
      {parts.map(({ icon: Icon, value, label }) => (
        <li
          key={label}
          className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 px-1 py-0.5 text-xs leading-none text-foreground"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="tabular-nums">{value}</span>
          <span className="sr-only">{`${value} ${label}`}</span>
        </li>
      ))}
    </ul>
  );
}

function PriceBlock({ item }: { item: BuilderStockItem }) {
  const price = stockItemPrice(item);
  const { amount, qualifier } = splitPriceLine(price);
  return (
    <div className="min-w-0" title={price ?? undefined}>
      <p className="break-words text-sm font-semibold tabular-nums leading-snug text-foreground">
        {amount}
      </p>
      {qualifier ? (
        <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">{qualifier}</p>
      ) : null}
    </div>
  );
}

/**
 * What imagery this property has, and where each stage got to.
 *
 * The same two facts the text readout carried — which image the card would draw,
 * and the per-stage ready counts — as a badge and three chips. A stage that
 * found nothing is drawn dashed and muted rather than being written out, and
 * its full label and reason stay on the element for hover and screen readers.
 */
function ImageSources({ item, showLabels = false }: { item: BuilderStockItem; showLabels?: boolean }) {
  const image = primaryStockImage(item);
  const stages = stockImageStageSummary(item);

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Badge
        variant="outline"
        title={image ? STOCK_IMAGE_STAGE_BADGES[image.source_stage] : 'No image yet'}
        className={cn(
          'max-w-full gap-1 px-1.5 py-0 text-[11px] font-medium',
          image
            ? STOCK_AVAILABILITY_CLASSES.available
            : 'border-dashed border-border/70 bg-muted/30 text-muted-foreground',
        )}
      >
        {image
          ? <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />
          : <ImageOff className="h-3 w-3 shrink-0" aria-hidden />}
        <span className="truncate">
          {image ? STOCK_IMAGE_STAGE_BADGES[image.source_stage] : 'No image yet'}
        </span>
      </Badge>

      <ul className="flex flex-wrap items-center gap-1">
        {stages.map((stage) => {
          const Icon = STOCK_IMAGE_STAGE_ICONS[stage.stage];
          const found = stage.ready > 0;
          return (
            <li
              key={stage.stage}
              title={found ? `${stage.label}: ${stage.ready}` : `${stage.label}: ${stage.note ?? 'none'}`}
              className={cn(
                'inline-flex max-w-full items-center gap-0.5 rounded-md border px-1 py-0.5 text-[11px] leading-none',
                found
                  ? 'border-border/60 bg-muted/30 text-foreground'
                  : 'border-dashed border-border/60 text-muted-foreground',
              )}
            >
              <Icon className="h-3 w-3 shrink-0" aria-hidden />
              {showLabels ? (
                <span className="truncate">{STOCK_IMAGE_STAGE_SHORT_LABELS[stage.stage]}</span>
              ) : null}
              <span className="tabular-nums">{found ? stage.ready : '—'}</span>
              <span className="sr-only">
                {stage.label}: {found ? `${stage.ready} available` : (stage.note ?? 'none')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The availability control. Same value, same options, same handler and same
 * accessible name as before — only the trigger's width is now the column's
 * rather than a fixed 10rem that the column had to grow to fit.
 */
function AvailabilityControl({
  item, saving, onAvailabilityChange, className,
}: {
  item: BuilderStockItem;
  saving: boolean;
  onAvailabilityChange: (next: string) => void;
  className?: string;
}) {
  return (
    <Select
      value={item.availability_status}
      onValueChange={onAvailabilityChange}
      disabled={saving}
    >
      <SelectTrigger
        className={cn('h-9 w-full min-w-0', className)}
        aria-label={`Availability for ${stockItemTitle(item)}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {item.availability_status === 'unknown' ? (
          <SelectItem value="unknown">{STOCK_AVAILABILITY_LABELS.unknown}</SelectItem>
        ) : null}
        {SETTABLE_AVAILABILITY.map((status) => (
          <SelectItem key={status} value={status}>{STOCK_AVAILABILITY_LABELS[status]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The selection state. The statuses are the server's, rendered with the labels
 * this module already publishes; "Not selected" names the absence the em-dash
 * used to stand for and is not a status the data can hold.
 */
function SelectionStatus({ item }: { item: BuilderStockItem }) {
  if (!item.latest_selection) {
    return <span className="text-xs text-muted-foreground">Not selected</span>;
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        // Wraps inside the column instead of widening it — the status is the
        // one thing on this row that must never be pushed off the edge.
        'max-w-full whitespace-normal px-1.5 py-0.5 text-[11px] font-medium leading-tight',
        SELECTION_STATUS_CLASSES[item.latest_selection.status]
          ?? STOCK_AVAILABILITY_CLASSES.on_hold,
      )}
    >
      {STOCK_SELECTION_STATUS_LABELS[item.latest_selection.status]}
    </Badge>
  );
}

interface StockPresentationProps {
  item: BuilderStockItem;
  saving: boolean;
  onAvailabilityChange: (next: string) => void;
}

/** xl and up: the six-column table row. */
function StockRow({ item, saving, onAvailabilityChange }: StockPresentationProps) {
  return (
    <TableRow>
      <TableCell className="px-3 py-3 align-top">
        <PropertyIdentity item={item} />
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <ConfigurationChips item={item} />
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <PriceBlock item={item} />
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <ImageSources item={item} />
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <AvailabilityControl
          item={item}
          saving={saving}
          onAvailabilityChange={onAvailabilityChange}
        />
      </TableCell>
      <TableCell className="px-3 py-3 align-top">
        <SelectionStatus item={item} />
      </TableCell>
    </TableRow>
  );
}

/** Below xl: the same fields stacked, so nothing has to be scrolled to. */
function StockCard({ item, saving, onAvailabilityChange }: StockPresentationProps) {
  return (
    <li className="builder-portal-soft-panel p-4 transition-colors hover:bg-muted/30">
      {/* The badge drops to its own line rather than squeezing the address into
          a four-line column on a narrow phone. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-56">
          <PropertyIdentity item={item} />
        </div>
        <SelectionStatus item={item} />
      </div>

      <div className="mt-3 grid gap-3 border-t border-border/50 pt-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <PriceBlock item={item} />
          <ConfigurationChips item={item} hideWhenEmpty />
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:items-end">
          <ImageSources item={item} showLabels />
          <AvailabilityControl
            item={item}
            saving={saving}
            onAvailabilityChange={onAvailabilityChange}
            className="sm:w-48"
          />
        </div>
      </div>
    </li>
  );
}
