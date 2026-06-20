import { describe, it, expect } from 'vitest';
import { ROOM_CODE_LEN, makeRoomCode } from './rooms';

describe('room codes', () => {
  it('default length is 7', () => {
    expect(ROOM_CODE_LEN).toBe(7);
    expect(makeRoomCode(() => 0)).toHaveLength(7);
  });
});
