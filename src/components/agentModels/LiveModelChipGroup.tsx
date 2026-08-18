/**
 * Renders every slot on an agent surface as a row of live badges.
 * Use on surfaces with multiple model slots (e.g. Report Q&A → 4 slots).
 */

import type { AgentSurfaceId } from '@/lib/agentModels/agentKeys';
import { useAgentSurface } from '@/hooks/useAgentModels';
import { LiveModelBadge } from './LiveModelBadge';
import { cn } from '@/lib/utils';
import { isClientFacingDeployment } from '@/lib/clientFacing';

export type LiveModelChipGroupProps = {
  surfaceId: AgentSurfaceId;
  size?: 'sm' | 'md';
  showSlot?: boolean;
  className?: string;
};

export function LiveModelChipGroup({
  surfaceId,
  size = 'sm',
  showSlot = true,
  className,
}: LiveModelChipGroupProps) {
  const { slots } = useAgentSurface(surfaceId);
  // Every chip in the group self-gates to null on a client-facing deployment;
  // dropping the wrapper too keeps the toolbar from carrying an empty box.
  if (isClientFacingDeployment()) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {slots.map((slot) => (
        <LiveModelBadge
          key={slot.agentKey}
          agentKey={slot.agentKey}
          size={size}
          showSlot={showSlot && slots.length > 1}
        />
      ))}
    </div>
  );
}
