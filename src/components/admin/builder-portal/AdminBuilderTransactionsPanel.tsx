import { useCallback, useEffect, useState } from 'react';
import { KanbanSquare, Link2, Loader2, Plus, Receipt, RefreshCw, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import {
  TRANSACTION_STATUS_CLASSES, TRANSACTION_STATUS_LABELS, TRANSACTION_TYPE_LABELS,
  allowedTransactionTransitions, formatTransactionMoney,
  type BuilderTransactionStatus, type BuilderTransactionType,
} from '@/lib/builderTransactions';

/**
 * Internal Builder transaction administration.
 *
 * Mirrors `AdminBuilderInventoryPanel`. Every call goes through
 * `invokeSecureFunction`, which carries the staff session and the CSRF token;
 * `builder-transactions-admin` re-checks the `builder_portal_admin` module
 * permission server-side, so nothing here is the authorization control.
 *
 * This is the INTERNAL surface. It never links to the external /builder/* portal.
 *
 * DATA BOUNDARY: the case panel lists case identity only. No Legal matter, no
 * Finance file and no client financial position is requested or displayed.
 */

interface AdminProject { id: string; name: string; project_reference: string | null }

interface AdminTransaction {
  id: string;
  project_id: string;
  unit_id: string | null;
  organisation_id: string;
  client_id: string | null;
  transaction_reference: string | null;
  transaction_type: BuilderTransactionType;
  status: BuilderTransactionStatus;
  purchaser_name: string | null;
  contract_price: number | null;
  estimated_settlement_date: string | null;
  row_version: number;
}

interface AdminCase {
  id: string;
  case_type: string;
  shared_lifecycle_status: string;
  property_address_normalized: string | null;
  opened_at: string;
}

interface AdminCaseLink {
  id: string;
  case_id: string;
  builder_transaction_id: string | null;
  link_source: string;
  linked_at: string;
}

interface AdminPipelineColumn {
  stage_key: string;
  stage_label: string;
  stage_order: number;
  is_terminal: boolean;
  count: number;
}

export function AdminBuilderTransactionsPanel({ canEdit }: { canEdit: boolean }) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [transactions, setTransactions] = useState<AdminTransaction[]>([]);
  const [pipeline, setPipeline] = useState<AdminPipelineColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [clientTarget, setClientTarget] = useState<AdminTransaction | null>(null);
  const [caseTarget, setCaseTarget] = useState<AdminTransaction | null>(null);
  const [cases, setCases] = useState<AdminCase[]>([]);
  const [caseLink, setCaseLink] = useState<AdminCaseLink | null>(null);

  const call = useCallback(async (operation: string, payload: Record<string, unknown> = {}) => {
    const { data, error: invokeError } = await invokeSecureFunction(
      'builder-transactions-admin', { operation, ...payload });
    if (invokeError || (data as any)?.error) {
      throw new Error((data as any)?.error || invokeError?.message || 'The request failed');
    }
    return data as any;
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const { data } = await invokeSecureFunction(
        'builder-projects-admin', { operation: 'list_projects', page: 1, page_size: 100 });
      const records = ((data as any)?.records ?? []) as AdminProject[];
      setProjects(records);
      setProjectId((current) => current || records[0]?.id || '');
    } catch (loadError: any) {
      setError(loadError?.message || 'Projects could not be loaded');
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    if (!projectId) { setTransactions([]); setPipeline([]); setLoading(false); return; }
    setLoading(true);
    try {
      const [listData, pipelineData] = await Promise.all([
        call('list_transactions', { project_id: projectId, page: 1, page_size: 200 }),
        call('pipeline', { project_id: projectId }),
      ]);
      setTransactions(listData.records ?? []);
      setPipeline(pipelineData.columns ?? []);
      setError(null);
    } catch (loadError: any) {
      setError(loadError?.message || 'Transactions could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [call, projectId]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadTransactions(); }, [loadTransactions]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      toast.success(label);
      await loadTransactions();
      return true;
    } catch (actionError: any) {
      toast.error(actionError?.message || 'The request failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createTransaction = async (form: FormData) => {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const ok = await run('Transaction created', () => call('create_transaction', {
      project_id: projectId,
      organisation_id: String(form.get('organisation_id') || ''),
      transaction_reference: String(form.get('transaction_reference') || ''),
      transaction_type: String(form.get('transaction_type') || 'off_the_plan'),
      purchaser_name: String(form.get('purchaser_name') || ''),
      contract_price: String(form.get('contract_price') || '') || null,
      reason: 'Created from Command Centre',
    }));
    if (ok) setCreateOpen(false);
  };

  /**
   * Status changes always carry the row_version the panel loaded. A stale value
   * is rejected by the server with 409 rather than silently overwritten.
   */
  const changeStatus = (transaction: AdminTransaction, status: string) => {
    const reason = window.prompt('Give a reason for this change');
    if (!reason || !reason.trim()) return;
    void run('Transaction status updated', () => call('set_status', {
      transaction_id: transaction.id,
      expected_version: transaction.row_version,
      status,
      reason: reason.trim(),
    }));
  };

  const saveClient = async (form: FormData) => {
    if (!clientTarget) return;
    const ok = await run('Client updated', () => call('set_client', {
      transaction_id: clientTarget.id,
      expected_version: clientTarget.row_version,
      client_id: String(form.get('client_id') || '') || null,
      reason: String(form.get('reason') || 'Updated from Command Centre'),
    }));
    if (ok) setClientTarget(null);
  };

  const openCases = async (transaction: AdminTransaction) => {
    setCaseTarget(transaction);
    setCases([]);
    setCaseLink(null);
    try {
      const [caseData, detail] = await Promise.all([
        call('list_client_cases', { transaction_id: transaction.id }),
        call('get_transaction', { transaction_id: transaction.id }),
      ]);
      setCases(caseData.records ?? []);
      setCaseLink(detail.case_link ?? null);
    } catch (caseError: any) {
      toast.error(caseError?.message || 'Cases could not be loaded');
    }
  };

  const linkCase = async (caseId: string) => {
    if (!caseTarget) return;
    const ok = await run('Case linked', () => call('link_case', {
      transaction_id: caseTarget.id, case_id: caseId,
      reason: 'Linked from Command Centre',
    }));
    if (ok) setCaseTarget(null);
  };

  const unlinkCase = async () => {
    if (!caseTarget) return;
    const ok = await run('Case unlinked', () => call('unlink_case', {
      transaction_id: caseTarget.id, reason: 'Unlinked from Command Centre',
    }));
    if (ok) setCaseTarget(null);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Transactions</CardTitle>
            <CardDescription>
              Sales for one project, their lifecycle, client link and shared-case link.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-64" aria-label="Choose a project">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void loadTransactions()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />Refresh
            </Button>
            <Button size="sm" disabled={!canEdit || !projectId} onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />New transaction
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
          ) : null}

          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading transactions" />
            </div>
          ) : !projectId ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Choose a project to manage its transactions.
            </p>
          ) : (
            <>
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <KanbanSquare className="h-4 w-4 text-primary" aria-hidden />Pipeline
                </h3>
                {!pipeline.length ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                    No pipeline stages returned.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pipeline.map((column) => (
                      <Badge key={column.stage_key} variant="outline">
                        {column.stage_label}: {column.count}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Receipt className="h-4 w-4 text-primary" aria-hidden />
                  Transactions ({transactions.length})
                </h3>
                {!transactions.length ? (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No transactions recorded for this project.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Reference</TableHead>
                          <TableHead className="hidden md:table-cell">Type</TableHead>
                          <TableHead>Price</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {transactions.map((transaction) => (
                          <TableRow key={transaction.id}>
                            <TableCell>
                              <span className="font-medium">
                                {transaction.transaction_reference || 'No reference'}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {transaction.purchaser_name || 'No purchaser'} · v{transaction.row_version}
                              </span>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              {TRANSACTION_TYPE_LABELS[transaction.transaction_type]}
                            </TableCell>
                            <TableCell>{formatTransactionMoney(transaction.contract_price)}</TableCell>
                            <TableCell>
                              <Select
                                value=""
                                disabled={!canEdit || busy}
                                onValueChange={(value) => changeStatus(transaction, value)}
                              >
                                <SelectTrigger
                                  className="w-44"
                                  aria-label={`Change status for ${transaction.transaction_reference || 'transaction'}`}
                                >
                                  <SelectValue
                                    placeholder={TRANSACTION_STATUS_LABELS[transaction.status]}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {allowedTransactionTransitions(transaction.status).map((next) => (
                                    <SelectItem key={next} value={next}>
                                      {TRANSACTION_STATUS_LABELS[next]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex flex-wrap justify-end gap-1">
                                <Button
                                  size="sm" variant="outline" disabled={!canEdit}
                                  onClick={() => setClientTarget(transaction)}
                                >
                                  <UserPlus className="mr-2 h-4 w-4" aria-hidden />Client
                                </Button>
                                <Button
                                  size="sm" variant="outline" disabled={!canEdit}
                                  onClick={() => void openCases(transaction)}
                                >
                                  <Link2 className="mr-2 h-4 w-4" aria-hidden />Case
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New transaction</DialogTitle>
            <DialogDescription>
              The organisation must be a party to the selected project; the database re-checks it.
            </DialogDescription>
          </DialogHeader>
          <form
            id="builder-transaction-form"
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createTransaction(new FormData(event.currentTarget));
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="txn_organisation">Organisation ID</Label>
              <Input id="txn_organisation" name="organisation_id" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn_reference">Reference</Label>
              <Input id="txn_reference" name="transaction_reference" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn_type">Type</Label>
              <select
                id="txn_type" name="transaction_type" defaultValue="off_the_plan"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {(Object.keys(TRANSACTION_TYPE_LABELS) as BuilderTransactionType[]).map((value) => (
                  <option key={value} value={value}>{TRANSACTION_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn_purchaser">Purchaser name</Label>
              <Input id="txn_purchaser" name="purchaser_name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn_price">Contract price</Label>
              <Input id="txn_price" name="contract_price" type="number" min={0} step="1" />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" form="builder-transaction-form" disabled={busy}>
              Create transaction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(clientTarget)} onOpenChange={(open) => { if (!open) setClientTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Client link</DialogTitle>
            <DialogDescription>
              Setting the client is what makes a shared case possible. Leave blank to clear it.
            </DialogDescription>
          </DialogHeader>
          <form
            id="builder-client-form"
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveClient(new FormData(event.currentTarget));
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="txn_client">Client ID</Label>
              <Input id="txn_client" name="client_id" defaultValue={clientTarget?.client_id ?? ''} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn_client_reason">Reason</Label>
              <Input id="txn_client_reason" name="reason" />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClientTarget(null)}>Cancel</Button>
            <Button type="submit" form="builder-client-form" disabled={busy}>Save client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(caseTarget)} onOpenChange={(open) => { if (!open) setCaseTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Shared case</DialogTitle>
            <DialogDescription>
              Case identity only. No legal matter, finance file or client financial position is
              read here.
            </DialogDescription>
          </DialogHeader>
          {caseLink ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">Currently linked</p>
              <p className="text-xs text-muted-foreground">
                Source {caseLink.link_source} · {new Date(caseLink.linked_at).toLocaleString('en-AU')}
              </p>
              <Button
                className="mt-3" size="sm" variant="outline" disabled={busy}
                onClick={() => void unlinkCase()}
              >
                Unlink
              </Button>
            </div>
          ) : !caseTarget?.client_id ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              This transaction has no client, so it cannot join a case.
            </p>
          ) : !cases.length ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              This client has no cases.
            </p>
          ) : (
            <ul className="space-y-2">
              {cases.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <div>
                    <p className="font-medium">{entry.case_type}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.property_address_normalized || 'No address'} · {entry.shared_lifecycle_status}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => void linkCase(entry.id)}>
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCaseTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
