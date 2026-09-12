import { describe, expect, it } from 'vitest';
import {
  CONSTRUCTION_STAGE_SEQUENCE,
  CONSTRUCTION_STAGE_SHORT_LABELS,
  CONSTRUCTION_STATUS_SEQUENCE,
  isOffSequenceStatus,
  railIndexFromStages,
  railIndexFromStatus,
  railNoteForStatus,
  railStationsFromStages,
  railStationsFromStatuses,
  stageDwellAnnotation,
} from '@/lib/builderConstructionRail.pure';
import {
  CONSTRUCTION_STAGE_KEY_LABELS,
  type BuilderConstructionStage,
  type BuilderConstructionStageKey,
  type BuilderConstructionStageStatus,
} from '@/lib/builderConstruction';

const stage = (
  id: string,
  stage_key: BuilderConstructionStageKey,
  sequence_number: number,
  status: BuilderConstructionStageStatus,
  actual_start_date: string | null = null,
): BuilderConstructionStage => ({
  id,
  construction_case_id: 'case-1',
  name: CONSTRUCTION_STAGE_KEY_LABELS[stage_key],
  stage_key,
  sequence_number,
  status,
  planned_start_date: null,
  planned_end_date: null,
  actual_start_date,
  actual_end_date: null,
  percent_complete: 0,
  notes: null,
  row_version: 1,
  created_at: '2026-09-01T00:00:00Z',
} as BuilderConstructionStage);

describe('builderConstructionRail — off-sequence is never a position', () => {
  it('refuses a position for on_hold and cancelled', () => {
    // These ARE real statuses. They are not points on the line: a paused build
    // is somewhere on the extent and the status does not say where. Placing
    // them at an index invents a fact; placing them at the end would say a
    // cancelled build had completed.
    expect(railIndexFromStatus('on_hold')).toBeNull();
    expect(railIndexFromStatus('cancelled')).toBeNull();
    expect(isOffSequenceStatus('on_hold')).toBe(true);
    expect(isOffSequenceStatus('cancelled')).toBe(true);
  });

  it('keeps them out of the drawn extent entirely', () => {
    expect(CONSTRUCTION_STATUS_SEQUENCE).not.toContain('on_hold');
    expect(CONSTRUCTION_STATUS_SEQUENCE).not.toContain('cancelled');
  });

  it('states the absence rather than leaving an unmarked line to be read', () => {
    expect(railNoteForStatus('on_hold')).toMatch(/not recorded/i);
    expect(railNoteForStatus('cancelled')).toMatch(/no stage is current/i);
    expect(railNoteForStatus('under_construction')).toBeNull();
  });

  it('refuses an unknown or missing status rather than guessing', () => {
    expect(railIndexFromStatus('teleported')).toBeNull();
    expect(railIndexFromStatus(null)).toBeNull();
    expect(railIndexFromStatus(undefined)).toBeNull();
  });

  it('places the statuses that ARE on the line, in order', () => {
    expect(railIndexFromStatus('not_started')).toBe(0);
    expect(railIndexFromStatus('completed')).toBe(CONSTRUCTION_STATUS_SEQUENCE.length - 1);
    const drawn = railStationsFromStatuses();
    expect(drawn).toHaveLength(CONSTRUCTION_STATUS_SEQUENCE.length);
    expect(drawn[0].label).toBe('Not started');
  });
});

describe('builderConstructionRail — a short label can never rename a station', () => {
  it('is a prefix of the full label it stands for', () => {
    // The rail DRAWS `short` and SPEAKS `label`. Keeping one a prefix of the
    // other is what makes shortening safe: the two cannot come to name
    // different things.
    for (const [key, short] of Object.entries(CONSTRUCTION_STAGE_SHORT_LABELS)) {
      const full = CONSTRUCTION_STAGE_KEY_LABELS[key as BuilderConstructionStageKey];
      expect(short).toBeTruthy();
      expect(full.toLowerCase().startsWith(short!.toLowerCase())).toBe(true);
    }
  });

  it('never shortens a station that does not need it', () => {
    expect(CONSTRUCTION_STAGE_SHORT_LABELS.base).toBeUndefined();
    expect(CONSTRUCTION_STAGE_SHORT_LABELS.frame).toBeUndefined();
  });
});

describe('builderConstructionRail — the build’s own stages are the extent', () => {
  it('orders by sequence_number and drops `other`', () => {
    // `other` declares no place in the sequence, so it cannot be given one.
    const stations = railStationsFromStages([
      stage('c', 'frame', 3, 'not_started'),
      stage('x', 'other', 2, 'complete'),
      stage('a', 'site_preparation', 1, 'complete'),
    ]);
    expect(stations.map((s) => s.label)).toEqual(['Site preparation', 'Frame']);
    expect(stations[0].short).toBe('Site prep');
  });

  it('stands at the stage in progress', () => {
    const stages = [
      stage('a', 'site_preparation', 1, 'complete'),
      stage('b', 'base', 2, 'complete'),
      stage('c', 'frame', 3, 'in_progress'),
      stage('d', 'lockup', 4, 'not_started'),
    ];
    expect(railIndexFromStages(stages)).toBe(2);
  });

  it('stands at the last completed stage when none is in progress', () => {
    // A build that has finished lock-up and not begun fixing stands at lock-up.
    const stages = [
      stage('a', 'site_preparation', 1, 'complete'),
      stage('b', 'base', 2, 'complete'),
      stage('c', 'frame', 3, 'not_started'),
    ];
    expect(railIndexFromStages(stages)).toBe(1);
  });

  it('has no position when nothing has started', () => {
    // Saying it stands at the first station would claim work that has not
    // happened.
    const stages = [
      stage('a', 'site_preparation', 1, 'not_started'),
      stage('b', 'base', 2, 'not_started'),
    ];
    expect(railIndexFromStages(stages)).toBeNull();
    expect(railIndexFromStages([])).toBeNull();
  });

  it('never returns an index outside the stations it built', () => {
    // The rail treats an out-of-range index as absent rather than clamping,
    // but it must never be handed one.
    const stages = [
      stage('a', 'site_preparation', 1, 'complete'),
      stage('x', 'other', 2, 'in_progress'),
    ];
    const stations = railStationsFromStages(stages);
    const at = railIndexFromStages(stages);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(stations.length);
  });
});

describe('builderConstructionRail — the catalogue order', () => {
  it('runs site preparation through handover and excludes `other`', () => {
    expect(CONSTRUCTION_STAGE_SEQUENCE).toEqual([
      'site_preparation', 'base', 'frame', 'lockup', 'fixing',
      'practical_completion', 'handover',
    ]);
    expect(CONSTRUCTION_STAGE_SEQUENCE).not.toContain('other');
  });
});

describe('builderConstructionRail — the extent is measured, never estimated', () => {
  const now = Date.parse('2026-09-12T09:00:00Z');

  it('counts whole days at the station', () => {
    expect(stageDwellAnnotation('2026-09-04T09:00:00Z', now)).toBe('8 days');
    expect(stageDwellAnnotation('2026-09-11T09:00:00Z', now)).toBe('1 day');
    expect(stageDwellAnnotation('2026-09-12T08:00:00Z', now)).toBe('Today');
  });

  it('says nothing where the stage was never dated', () => {
    // Absent, not estimated — a stage with no recorded start carries no
    // annotation rather than one inferred from its neighbours.
    expect(stageDwellAnnotation(null, now)).toBeNull();
    expect(stageDwellAnnotation(undefined, now)).toBeNull();
    expect(stageDwellAnnotation('not a date', now)).toBeNull();
  });

  it('says nothing for a start in the future', () => {
    expect(stageDwellAnnotation('2026-10-01T00:00:00Z', now)).toBeNull();
  });

  it('takes its clock as a parameter so it can be tested without one', () => {
    expect(stageDwellAnnotation('2026-09-04T09:00:00Z', now))
      .toBe(stageDwellAnnotation('2026-09-04T09:00:00Z', now));
  });
});
