import { useQuery } from '@tanstack/react-query';
import { invokeSecureFunction } from '@/lib/secureInvoke';
import { formatFullName } from '@/utils/nameFormatting';
import { isAfter, startOfDay, subDays } from 'date-fns';

export interface UnifiedReminder {
  id: string;
  title: string;
  description: string | null;
  due_date: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'completed' | 'snoozed';
  source: 'client_reminder' | 'follow_up' | 'deal_milestone';
  source_label: string;
  reminder_type: string;
  client_id: string | null;
  client_name: string;
  deal_id?: string;
  completed_at: string | null;
  created_at: string;
  // For mutations
  raw_source: 'client_reminders' | 'clients' | 'client_deals';
  raw_id: string;
}

export function useAllReminders() {
  return useQuery({
    queryKey: ['all-reminders'],
    queryFn: async (): Promise<UnifiedReminder[]> => {
      // Fetch all three data sources in parallel
      const [remindersRes, clientsRes, dealsRes] = await Promise.all([
        invokeSecureFunction('get-client-data', {
          listMode: true,
          listOptions: {
            table: 'client_reminders',
            select: '*',
            orderBy: 'due_date',
            orderAsc: true,
          },
        }),
        invokeSecureFunction('get-client-data', {
          mode: 'list',
          listOptions: {
            select: 'id, primary_first_name, primary_surname, follow_up_date',
            orderBy: 'follow_up_date',
            orderAsc: true,
          },
        }),
        invokeSecureFunction('get-client-data', {
          listMode: true,
          listOptions: {
            table: 'client_deals',
            select: 'id, client_id, deal_type, property_address, settlement_date, finance_clause_expiry, land_settlement_date, expected_build_start, estimated_completion, clawback_expiry_date, current_stage',
            orderBy: 'settlement_date',
            orderAsc: true,
          },
        }),
      ]);

      const reminders: any[] = remindersRes.data?.records || [];
      const clients: any[] = clientsRes.data?.clients || [];
      const deals: any[] = dealsRes.data?.records || [];

      // Build client name map
      const clientMap: Record<string, string> = {};
      for (const c of clients) {
        const cl = c.client || c;
        clientMap[c.id || cl.id] = formatFullName(cl.primary_first_name, cl.primary_surname) || 'Unknown';
      }

      const unified: UnifiedReminder[] = [];

      // 1) Client Reminders. Team-scoped rows live in the same table but
      // belong to the Team tab — without this guard a team reminder was
      // listed here too, tagged "Client Reminder".
      for (const r of reminders) {
        if (r.reminder_scope === 'team') continue;
        unified.push({
          id: `cr-${r.id}`,
          title: r.title,
          description: r.description,
          due_date: r.due_date,
          priority: r.priority || 'medium',
          status: r.status === 'completed' ? 'completed' : 'pending',
          source: 'client_reminder',
          source_label: 'Client Reminder',
          reminder_type: r.reminder_type || 'general',
          client_id: r.client_id,
          client_name: clientMap[r.client_id] || 'Unknown',
          completed_at: r.completed_at,
          created_at: r.created_at,
          raw_source: 'client_reminders',
          raw_id: r.id,
        });
      }

      // 2) Client Follow-Ups
      for (const c of clients) {
        const cl = c.client || c;
        const followUpDate = cl.follow_up_date || c.follow_up_date;
        if (!followUpDate) continue;
        const clientId = c.id || cl.id;
        unified.push({
          id: `fu-${clientId}`,
          title: `Follow up with ${clientMap[clientId] || 'client'}`,
          description: null,
          due_date: followUpDate,
          priority: 'medium',
          status: 'pending',
          source: 'follow_up',
          source_label: 'Client Follow-Up',
          reminder_type: 'follow_up',
          client_id: clientId,
          client_name: clientMap[clientId] || 'Unknown',
          completed_at: null,
          created_at: followUpDate,
          raw_source: 'clients',
          raw_id: clientId,
        });
      }

      // 3) Deal Milestones
      const milestoneFields: { field: string; label: string; type: string; priority: 'high' | 'medium' | 'low' }[] = [
        { field: 'settlement_date', label: 'Settlement', type: 'settlement', priority: 'high' },
        { field: 'finance_clause_expiry', label: 'Finance Clause Expiry', type: 'finance', priority: 'high' },
        { field: 'land_settlement_date', label: 'Land Settlement', type: 'settlement', priority: 'high' },
        { field: 'expected_build_start', label: 'Build Start', type: 'construction', priority: 'medium' },
        { field: 'estimated_completion', label: 'Estimated Completion', type: 'construction', priority: 'medium' },
        { field: 'clawback_expiry_date', label: 'Clawback Expiry', type: 'clawback', priority: 'high' },
      ];

      for (const deal of deals) {
        const clientName = clientMap[deal.client_id] || 'Unknown';
        const address = deal.property_address || deal.current_stage || '';

        for (const m of milestoneFields) {
          const dateVal = deal[m.field];
          if (!dateVal) continue;

          unified.push({
            id: `dm-${deal.id}-${m.field}`,
            title: `${m.label} — ${clientName}`,
            description: address ? `Property: ${address}` : null,
            due_date: dateVal,
            priority: m.priority,
            status: 'pending',
            source: 'deal_milestone',
            source_label: 'Deal Milestone',
            reminder_type: m.type,
            client_id: deal.client_id,
            client_name: clientName,
            deal_id: deal.id,
            completed_at: null,
            created_at: deal.created_at || dateVal,
            raw_source: 'client_deals',
            raw_id: deal.id,
          });
        }
      }

      // Filter: only show items from yesterday onward (keep overdue visible)
      const cutoff = startOfDay(subDays(new Date(), 7));
      const filtered = unified.filter(r => {
        if (r.status === 'completed') return false;
        return isAfter(new Date(r.due_date), cutoff);
      });

      // Sort by due_date ascending
      filtered.sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());

      return filtered;
    },
    staleTime: 30000,
  });
}
