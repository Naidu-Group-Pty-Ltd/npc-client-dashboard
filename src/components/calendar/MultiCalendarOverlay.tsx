import { useMemo, useState } from 'react';
import { Layers, Eye, EyeOff, Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Calendar {
  id: string;
  name: string;
  eventColor?: string;
  isActive?: boolean;
}

interface MultiCalendarOverlayProps {
  calendars: Calendar[];
  events: Array<{
    id: string;
    calendarId?: string;
    startTime?: string;
  }>;
  visibleCalendars: Set<string>;
  onToggleCalendar: (calendarId: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  /** Outlook integration */
  outlookEnabled?: boolean;
  outlookVisible?: boolean;
  onToggleOutlook?: () => void;
  outlookEventCount?: number;
  microsoftEmail?: string | null;
}

export function MultiCalendarOverlay({
  calendars,
  events,
  visibleCalendars,
  onToggleCalendar,
  onShowAll,
  onHideAll,
  outlookEnabled,
  outlookVisible,
  onToggleOutlook,
  outlookEventCount = 0,
  microsoftEmail,
}: MultiCalendarOverlayProps) {
  const [viewMode, setViewMode] = useState<'list' | 'compact'>('list');

  // Count events per calendar
  const eventCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    events.forEach(e => {
      if (e.calendarId) {
        counts[e.calendarId] = (counts[e.calendarId] || 0) + 1;
      }
    });
    return counts;
  }, [events]);

  const allVisible = calendars.every(c => visibleCalendars.has(c.id));
  const noneVisible = calendars.every(c => !visibleCalendars.has(c.id));
  const visibleCount = calendars.filter(c => visibleCalendars.has(c.id)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Layers className="h-4 w-4" />
          Calendar Overlay
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onShowAll}
            disabled={allVisible}
          >
            <Eye className="h-3 w-3 mr-1" />
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onHideAll}
            disabled={noneVisible}
          >
            <EyeOff className="h-3 w-3 mr-1" />
            None
          </Button>
        </div>
      </div>

      {/* Status summary */}
      <Card className="p-3 bg-muted/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex -space-x-1">
              {calendars.slice(0, 5).map((cal, idx) => (
                <div
                  key={cal.id}
                  className={cn(
                    'w-4 h-4 rounded-full border-2 border-background',
                    !visibleCalendars.has(cal.id) && 'opacity-30'
                  )}
                  style={{ backgroundColor: cal.eventColor || '#3b82f6', zIndex: 5 - idx }}
                />
              ))}
              {calendars.length > 5 && (
                <div className="w-4 h-4 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[8px] font-medium">
                  +{calendars.length - 5}
                </div>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {visibleCount} of {calendars.length} visible
            </span>
          </div>
          <Badge variant="outline" className="text-xs">
            {events.filter(e => visibleCalendars.has(e.calendarId || '')).length} events shown
          </Badge>
        </div>
      </Card>

      {/* Outlook calendar entry */}
      {microsoftEmail && onToggleOutlook && (
        <button
          onClick={onToggleOutlook}
          className={cn(
            'w-full p-3 rounded-lg border text-left transition-all',
            'hover:bg-muted/50',
            outlookVisible
              ? 'border-[hsl(207,89%,41%)]/30 bg-[hsl(207,89%,41%)]/5'
              : 'border-border/50 opacity-60 hover:opacity-100'
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div
                  className={cn('w-4 h-4 rounded-full transition-all', !outlookVisible && 'opacity-40')}
                  style={{ backgroundColor: '#0078d4' }}
                />
                {outlookVisible && (
                  <Check className="absolute -top-1 -right-1 h-3 w-3 text-success bg-background rounded-full" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium">Outlook</p>
                <p className="text-xs text-muted-foreground">
                  {outlookEventCount} event{outlookEventCount !== 1 ? 's' : ''} · {microsoftEmail}
                </p>
              </div>
            </div>
            <Switch
              checked={!!outlookVisible}
              onCheckedChange={onToggleOutlook}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </button>
      )}

      {/* Calendar list */}
      <div className="space-y-2">
          {calendars.map(calendar => {
            const isVisible = visibleCalendars.has(calendar.id);
            const eventCount = eventCounts[calendar.id] || 0;

            return (
              <button
                key={calendar.id}
                onClick={() => onToggleCalendar(calendar.id)}
                className={cn(
                  'w-full p-3 rounded-lg border text-left transition-all',
                  'hover:bg-muted/50',
                  isVisible
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border/50 opacity-60 hover:opacity-100'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div
                        className={cn(
                          'w-4 h-4 rounded-full transition-all',
                          !isVisible && 'opacity-40'
                        )}
                        style={{ backgroundColor: calendar.eventColor || '#3b82f6' }}
                      />
                      {isVisible && (
                        <Check className="absolute -top-1 -right-1 h-3 w-3 text-success bg-background rounded-full" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium truncate max-w-[150px]">{calendar.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {eventCount} event{eventCount !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={isVisible}
                    onCheckedChange={() => onToggleCalendar(calendar.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </button>
            );
          })}
      </div>

      {/* Color legend */}
      <div className="pt-2 border-t">
        <p className="text-xs text-muted-foreground mb-2">Quick toggle by clicking colors:</p>
        <div className="flex flex-wrap gap-1.5">
          {calendars.map(cal => (
            <button
              key={cal.id}
              onClick={() => onToggleCalendar(cal.id)}
              title={cal.name}
              className={cn(
                'w-5 h-5 rounded-md transition-all hover:scale-110',
                !visibleCalendars.has(cal.id) && 'opacity-30 grayscale'
              )}
              style={{ backgroundColor: cal.eventColor || '#3b82f6' }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
