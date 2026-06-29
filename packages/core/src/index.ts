/**
 * @golazo/core — the framework-agnostic heart of GOLAZO.
 *
 * Read order to understand the whole system:
 *   1. types.ts      — the contracts every layer agrees on
 *   2. parimutuel.ts — pure pool-share parimutuel math
 *   3. engine.ts     — the market lifecycle state machine
 *   4. watcher.ts    — feed event -> bettable market trigger (rule baseline)
 *   5. sim.ts        — a fake match that emits the same feed a real provider would
 */
export * from './types';
export * from './parimutuel';
export * from './engine';
export * from './rooms';
export * from './watcher';
export * from './sim';
export * from './protocol';
export * from './points';
export * from './accountId';
