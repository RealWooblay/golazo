import { describe, it, expect } from 'vitest';
import { parseGoalSource } from './playPhase';

describe('parseGoalSource — ESPN goal text, not commentary keywords', () => {
  it('YES when ESPN says the goal came from the free kick', () => {
    expect(
      parseGoalSource(
        'Goal! Brazil 1-0. Casemiro (Brazil) header from a direct free kick.',
        'goal_from_free_kick',
      ),
    ).toBe('yes');
  });

  it('NO when ESPN says assisted — recycled possession after wall', () => {
    expect(
      parseGoalSource(
        'Goal! Brazil 2-0. Vinícius Júnior (Brazil) right footed shot from the left side of the box. Assisted by Lucas Paquetá with a through ball.',
        'goal_from_free_kick',
      ),
    ).toBe('no');
  });

  it('NO for corner market when goal is a through-ball assist', () => {
    expect(
      parseGoalSource(
        'Goal! Kane (England) right footed shot. Assisted by Saka with a through ball.',
        'goal_from_corner',
      ),
    ).toBe('no');
  });
});
