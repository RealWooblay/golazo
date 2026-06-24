/**
 * Kind↔question consistency. The client derives the countdown label from the KIND: period /
 * stoppage kinds show "until full-time / half-time" (they settle on the whistle); every other
 * kind shows a numeric timer (it settles on a deadline). So period/whistle WORDING on a
 * non-period kind is a lie — the "verbage is messed up" bug. triggerWordingProblem catches it.
 */
import { describe, expect, it } from 'vitest';
import { triggerWordingProblem } from './ai/marketTuning';

describe('triggerWordingProblem', () => {
  it('flags period/whistle wording on a timer-settled kind', () => {
    expect(triggerWordingProblem('score_in_window', 'Panama to equalize before the final whistle?')).toBeTruthy();
    expect(triggerWordingProblem('goal_in_window', 'A goal before full-time?')).toBeTruthy();
    expect(triggerWordingProblem('shot_or_corner_in_window', 'One more in stoppage?')).toBeTruthy();
    expect(triggerWordingProblem('goal_in_window', 'Will we see a goal before half-time?')).toBeTruthy();
  });

  it('allows period/whistle wording on the kinds that DO settle on the whistle', () => {
    expect(triggerWordingProblem('goal_in_stoppage', 'Added time — goal before the whistle?')).toBeNull();
    expect(triggerWordingProblem('goal_in_extra_time', 'Can Panama find an equaliser in ET?')).toBeNull();
    // A goal-window market explicitly opened as a period market (isPeriod) is fine too.
    expect(triggerWordingProblem('goal_in_window', 'Stoppage — one more before full-time?', true)).toBeNull();
  });

  it('does not flag normal window / versus / count wording', () => {
    expect(triggerWordingProblem('score_in_window', 'Panama laying siege — do they SCORE in the next 2 minutes?')).toBeNull();
    expect(triggerWordingProblem('shot_or_corner_in_window', 'Panama pushing forward — a SHOT or CORNER this spell?')).toBeNull();
    expect(triggerWordingProblem('next_shot', 'Who threatens next — Panama or Croatia?')).toBeNull();
    expect(triggerWordingProblem('over_corners', 'More than 3 corners in the next few minutes?')).toBeNull();
    expect(triggerWordingProblem('goal_in_window', 'A goal in the next few minutes? (either team)')).toBeNull();
  });
});
