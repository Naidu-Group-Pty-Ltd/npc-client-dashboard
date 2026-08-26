/**
 * Browser entry point for the shared submission-record rules — see
 * `supabase/functions/_shared/aml/submissionRecord.pure.ts`.
 *
 * The reading view, the downloaded file and the copy the edge function
 * stores on the case are all projections of the one structure built there,
 * so what the reviewer read, what they downloaded and what the case retains
 * cannot disagree.
 */
export {
  SUBMISSION_RECORD_DOCUMENT_KIND,
  buildSubmissionRecord,
  formatUtc,
  payloadEntries,
  renderSubmissionRecordHtml,
  submissionRecordFilename,
  valueText,
  verificationOutcomeText,
  type RecordBlock,
  type RecordField,
  type RecordSection,
  type RecordTable,
  type SubmissionRecord,
  type SubmissionRecordInput,
} from '../../../supabase/functions/_shared/aml/submissionRecord.pure.ts';
