import { useCallback, useEffect, useState } from 'react';
import { Building2, HardHat, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
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
  ACCESS_ROLE_LABELS, PROJECT_STATUS_LABELS, PROJECT_TYPE_LABELS,
  type BuilderProjectStatus, type BuilderProjectType,
} from '@/lib/builderProjects';

/**
 * Internal Builder project administration (Phase 3).
 *
 * Mirrors `AdminLegalMattersPanel` and the matter-access half of
 * `SolicitorPortalAdmin`. Every call goes through `invokeSecureFunction`, which
 * carries the staff session and the CSRF token; the function re-checks the
 * `builder_portal_admin` module permission server-side, so nothing here is the
 * authorization control.
 *
 * This is the INTERNAL surface. It never links to the external /builder/* portal.
 */

interface AdminProject {
  id: string;
  name: string;
  project_reference: string | null;
  project_type: BuilderProjectType;
  status: BuilderProjectStatus;
  developer_organisation_id: string | null;
  builder_organisation_id: string | null;
  address_line: string | null;
  suburb: string | null;
  row_version: number;
}

interface AdminOrganisation { id: string; legal_name: string; trading_name: string | null; org_type: string }

interface AdminAccessGrant {
  id: string;
  project_id: string;
  builder_user_id?: string;
  organisation_id: string;
  organisation_side: 'developer' | 'builder';
  access_role: string;
  valid_from: string;
  valid_until: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  row_version: number;
}

export function AdminBuilderProjectsPanel({ canEdit }: { canEdit: boolean }) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [organisations, setOrganisations] = useState<AdminOrganisation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [accessProject, setAccessProject] = useState<AdminProject | null>(null);
  const [accessGrants, setAccessGrants] = useState<AdminAccessGrant[]>([]);
  const [grantUserId, setGrantUserId] = useState('');
  const [grantSide, setGrantSide] = useState<'developer' | 'builder'>('builder');
  const [grantRole, setGrantRole] = useState('team_member');
  const [grantValidUntil, setGrantValidUntil] = useState('');

  const call = useCallback(async (operation: string, payload: Record<string, unknown> = {}) => {
    const { data, error: invokeError } = await invokeSecureFunction(
      'builder-projects-admin', { operation, ...payload });
    if (invokeError || (data as any)?.error) {
      throw new Error((data as any)?.error || invokeError?.message || 'The request failed');
    }
    return data as any;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [projectData, organisationData] = await Promise.all([
        call('list_projects', { page: 1, page_size: 100 }),
        invokeSecureFunction('builder-portal-admin', { operation: 'list_organisations' })
          .then(({ data }) => (data as any)?.records ?? []),
      ]);
      setProjects(projectData.records ?? []);
      setOrganisations(organisationData ?? []);
      setError(null);
    } catch (loadError: any) {
      setError(loadError?.message || 'Projects could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  const organisationName = (id: string | null) => {
    if (!id) return '—';
    const organisation = organisations.find((entry) => entry.id === id);
    return organisation ? organisation.trading_name || organisation.legal_name : id.slice(0, 8);
  };

  const openAccess = async (project: AdminProject) => {
    setAccessProject(project);
    setAccessGrants([]);
    try {
      const detail = await call('get_project', { project_id: project.id });
      setAccessGrants(detail.access ?? []);
    } catch (accessError: any) {
      toast.error(accessError?.message || 'Access could not be loaded');
    }
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await call('create_project', {
        name: String(form.get('name') || ''),
        project_reference: String(form.get('project_reference') || '') || null,
        project_type: String(form.get('project_type') || 'house_and_land'),
        developer_organisation_id: String(form.get('developer_organisation_id') || '') || null,
        builder_organisation_id: String(form.get('builder_organisation_id') || '') || null,
        address_line: String(form.get('address_line') || '') || null,
        suburb: String(form.get('suburb') || '') || null,
      });
      toast.success('Project created');
      setCreateOpen(false);
      await load();
    } catch (createError: any) {
      toast.error(createError?.message || 'The project could not be created');
    } finally {
      setBusy(false);
    }
  };

  const handleGrant = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessProject || !grantUserId.trim()) return;
    setBusy(true);
    try {
      // An existing grant for this user and project must carry its version:
      // the server rejects an update that omits it.
      const existing = accessGrants.find(
        (grant) => grant.builder_user_id === grantUserId.trim() && !grant.revoked_at);
      await call('upsert_project_access', {
        builder_user_id: grantUserId.trim(),
        project_id: accessProject.id,
        organisation_side: grantSide,
        access_role: grantRole,
        valid_until: grantValidUntil || null,
        ...(existing ? { expected_version: existing.row_version } : {}),
        reason: 'Granted from Command Centre',
      });
      toast.success('Project access granted');
      setGrantUserId('');
      setGrantValidUntil('');
      await openAccess(accessProject);
    } catch (grantError: any) {
      toast.error(grantError?.message || 'Access could not be granted');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (grant: AdminAccessGrant) => {
    if (!accessProject) return;
    setBusy(true);
    try {
      await call('revoke_project_access', {
        access_id: grant.id,
        expected_version: grant.row_version,
        reason: 'Revoked from Command Centre',
      });
      toast.success('Project access revoked');
      await openAccess(accessProject);
    } catch (revokeError: any) {
      toast.error(revokeError?.message || 'Access could not be revoked');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardHat className="h-4 w-4 text-primary" aria-hidden />Projects and project access
          </CardTitle>
          <CardDescription>
            Projects carry a developer organisation and a builder organisation. Portal users see a
            project only when they hold an explicit, unrevoked, in-window grant.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} aria-hidden />
            Refresh
          </Button>
          {canEdit ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />New project
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading projects" />
          </div>
        ) : !projects.length ? (
          <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No projects yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Developer</TableHead>
                  <TableHead>Builder</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <span className="font-medium">{project.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {project.project_reference ? `${project.project_reference} · ` : ''}
                        {PROJECT_TYPE_LABELS[project.project_type]}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{organisationName(project.developer_organisation_id)}</TableCell>
                    <TableCell className="text-sm">{organisationName(project.builder_organisation_id)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{PROJECT_STATUS_LABELS[project.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => void openAccess(project)}>
                        <ShieldCheck className="mr-2 h-4 w-4" aria-hidden />Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* ── Create project ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project needs at least one organisation. The developer and builder must differ.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-project-name">Project name</Label>
              <Input id="admin-project-name" name="name" required />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="admin-project-reference">Reference</Label>
                <Input id="admin-project-reference" name="project_reference" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-project-type">Type</Label>
                <select
                  id="admin-project-type" name="project_type" defaultValue="house_and_land"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {Object.entries(PROJECT_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="admin-project-developer">Developer organisation</Label>
                <select
                  id="admin-project-developer" name="developer_organisation_id" defaultValue=""
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {organisations.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.trading_name || organisation.legal_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-project-builder">Builder organisation</Label>
                <select
                  id="admin-project-builder" name="builder_organisation_id" defaultValue=""
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {organisations.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.trading_name || organisation.legal_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="admin-project-address">Address</Label>
                <Input id="admin-project-address" name="address_line" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-project-suburb">Suburb</Label>
                <Input id="admin-project-suburb" name="suburb" />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Project access ── */}
      <Dialog open={Boolean(accessProject)} onOpenChange={(open) => !open && setAccessProject(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Project access — {accessProject?.name}</DialogTitle>
            <DialogDescription>
              A grant must run through an organisation the user actually belongs to, on a side the
              project actually has. The database refuses anything else.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!accessGrants.length ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No access granted yet.
              </p>
            ) : (
              <div className="space-y-2">
                {accessGrants.map((grant) => (
                  <div
                    key={grant.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="truncate">{grant.builder_user_id}</span>
                        {grant.revoked_at ? <Badge variant="secondary">Revoked</Badge> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {ACCESS_ROLE_LABELS[grant.access_role] || grant.access_role}
                        {' · '}via {grant.organisation_side}
                        {grant.valid_until ? ` · expires ${new Date(grant.valid_until).toLocaleDateString('en-AU')}` : ''}
                      </p>
                    </div>
                    {!grant.revoked_at && canEdit ? (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleRevoke(grant)}>
                        <Trash2 className="mr-2 h-4 w-4" aria-hidden />Revoke
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {canEdit ? (
              <form onSubmit={handleGrant} className="space-y-3 rounded-lg border border-border/60 p-4">
                <p className="text-sm font-medium">Grant access</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="grant-user">Builder Portal user id</Label>
                    <Input
                      id="grant-user" value={grantUserId}
                      onChange={(event) => setGrantUserId(event.target.value)}
                      placeholder="uuid" required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="grant-side">Organisation side</Label>
                    <Select value={grantSide} onValueChange={(value) => setGrantSide(value as 'developer' | 'builder')}>
                      <SelectTrigger id="grant-side"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="developer">Developer</SelectItem>
                        <SelectItem value="builder">Builder</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="grant-role">Access role</Label>
                    <Select value={grantRole} onValueChange={setGrantRole}>
                      <SelectTrigger id="grant-role"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(ACCESS_ROLE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="grant-until">Expires (optional)</Label>
                    <Input
                      id="grant-until" type="date" value={grantValidUntil}
                      onChange={(event) => setGrantValidUntil(event.target.value)}
                    />
                  </div>
                </div>
                <Button type="submit" size="sm" disabled={busy || !grantUserId.trim()}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                  Grant access
                </Button>
              </form>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
