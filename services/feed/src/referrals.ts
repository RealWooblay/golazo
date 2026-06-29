import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Market } from '@golazo/core';
import {
  canonicalWalletAccountId,
  isWalletAccountId,
} from '@golazo/core';

export interface ReferralCode {
  code: string;
  ownerId: string;
  ownerLabel?: string;
  payoutBps: number;
  active: boolean;
  createdAt: number;
}

export interface ReferralAttribution {
  userId: string;
  code: string;
  ownerId: string;
  attributedAt: number;
  source?: string;
}

export interface ReferralLedgerEntry {
  id: string;
  marketId: string;
  userId: string;
  code: string;
  ownerId: string;
  stake: number;
  grossFee: number;
  referrerCut: number;
  platformNetFee: number;
  rakeBps: number;
  payoutBps: number;
  asset: string;
  settledAt: number;
  paidAt?: number;
  payoutTx?: string;
}

interface StoredReferralState {
  codes: ReferralCode[];
  attributions: ReferralAttribution[];
  ledger: ReferralLedgerEntry[];
}

type ReferralJournalEvent =
  | { t: 'code_created'; code: ReferralCode }
  | { t: 'code_active'; code: string; active: boolean }
  | { t: 'attributed'; attribution: ReferralAttribution }
  | { t: 'ledger_entries'; entries: ReferralLedgerEntry[] }
  | { t: 'paid'; ids: string[]; paidAt: number; payoutTx?: string };

export interface ReferralSummary {
  code?: string;
  ownerId?: string;
  attributedUsers: number;
  volume: number;
  grossFees: number;
  referrerEarned: number;
  referrerPaid: number;
  referrerUnpaid: number;
  platformNetFees: number;
  entries: number;
  recent: ReferralLedgerEntry[];
}

export interface ReferralProfile {
  userId: string;
  attribution?: ReferralAttribution;
  ownedCodes: ReferralCode[];
  summary: ReferralSummary;
}

export interface ReferralEstimate {
  volume: number;
  rakeBps: number;
  payoutBps: number;
  grossFee: number;
  referrerEarns: number;
  platformKeeps: number;
}

export class ReferralManager {
  private readonly codes = new Map<string, ReferralCode>();
  private readonly attributions = new Map<string, ReferralAttribution>();
  private readonly ledger: ReferralLedgerEntry[] = [];
  private readonly ledgerIds = new Set<string>();

  constructor(
    private readonly opts: {
      storePath?: string;
      rakeBps: number;
      defaultPayoutBps: number;
      asset?: string;
      now?: () => number;
    },
  ) {
    this.load();
    if (opts.storePath) {
      this.ensureStoreDir();
      const timer = setInterval(() => this.flush(), 5_000);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  createCode(input: {
    code?: string;
    ownerId: string;
    ownerLabel?: string;
    payoutBps?: number;
  }): ReferralCode {
    const ownerId = input.ownerId?.trim();
    if (!ownerId) throw new Error('ownerId required');
    const code = input.code ? normalizeCode(input.code) : this.generateCode(ownerId);
    if (!code) throw new Error('code required');
    if (this.codes.has(code)) throw new Error('code already exists');

    const payoutBps = clampBps(input.payoutBps ?? this.opts.defaultPayoutBps);
    const row: ReferralCode = {
      code,
      ownerId,
      ...(input.ownerLabel?.trim() ? { ownerLabel: input.ownerLabel.trim().slice(0, 80) } : {}),
      payoutBps,
      active: true,
      createdAt: this.now(),
    };
    this.codes.set(code, row);
    this.persist({ t: 'code_created', code: row });
    return row;
  }

  setCodeActive(codeRaw: string, active: boolean): ReferralCode {
    const code = normalizeCode(codeRaw);
    const row = this.codes.get(code);
    if (!row) throw new Error('unknown referral code');
    row.active = active;
    this.persist({ t: 'code_active', code, active });
    return row;
  }

  attribute(input: { userId: string; code: string; source?: string }): {
    ok: boolean;
    created: boolean;
    attribution?: ReferralAttribution;
    reason?: string;
  } {
    const canonical = canonicalWalletAccountId(input.userId ?? '');
    const code = normalizeCode(input.code);
    if (!canonical) return { ok: false, created: false, reason: 'wallet account required' };
    const ref = this.codes.get(code);
    if (!ref || !ref.active) return { ok: false, created: false, reason: 'unknown referral code' };
    if (this.isOwnReferral(canonical, code, ref.ownerId)) {
      return { ok: false, created: false, reason: 'cannot use your own code' };
    }

    const existing = this.attributions.get(canonical);
    if (existing) {
      return { ok: true, created: false, attribution: existing };
    }

    const ownerId = canonicalWalletAccountId(ref.ownerId) ?? ref.ownerId;
    const row: ReferralAttribution = {
      userId: canonical,
      code,
      ownerId,
      attributedAt: this.now(),
      ...(input.source?.trim() ? { source: input.source.trim().slice(0, 500) } : {}),
    };
    this.attributions.set(canonical, row);
    this.persist({ t: 'attributed', attribution: row });
    return { ok: true, created: true, attribution: row };
  }

  attributionFor(userId: string): ReferralAttribution | undefined {
    const trimmed = userId.trim();
    const canonical = canonicalWalletAccountId(trimmed);
    if (canonical) return this.attributions.get(canonical);
    return this.attributions.get(trimmed);
  }

  codesForOwner(ownerIdRaw: string): ReferralCode[] {
    const ownerId = ownerIdRaw.trim();
    if (!ownerId) return [];
    const canonical = canonicalWalletAccountId(ownerId) ?? ownerId;
    return [...this.codes.values()]
      .filter((row) => {
        const rowOwner = canonicalWalletAccountId(row.ownerId) ?? row.ownerId;
        return rowOwner === canonical || row.ownerId === ownerId;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  profile(userIdRaw: string, ownerLabel?: string): ReferralProfile {
    const userId = userIdRaw.trim();
    const canonical = canonicalWalletAccountId(userId);
    if (canonical) {
      this.ensureOwnedCode(canonical, ownerLabel);
    }
    const ownedCodes = canonical ? this.codesForOwner(canonical) : [];
    const id = canonical ?? userId;
    return {
      userId: id,
      ...(this.attributionFor(id) ? { attribution: this.attributionFor(id)! } : {}),
      ownedCodes,
      summary: canonical ? this.summary({ ownerId: canonical }) : emptyReferralSummary(),
    };
  }

  /** Every user gets exactly one shareable partner code (created on first profile load). */
  ensureOwnedCode(userIdRaw: string, ownerLabel?: string): ReferralCode {
    const ownerId = canonicalWalletAccountId(userIdRaw) ?? userIdRaw.trim();
    if (!isWalletAccountId(ownerId)) throw new Error('wallet account required');
    const existing = this.codesForOwner(ownerId);
    if (existing[0]) return existing[0];
    return this.createCode({
      code: this.generateUserCode(),
      ownerId,
      ...(ownerLabel?.trim() ? { ownerLabel: ownerLabel.trim().slice(0, 80) } : {}),
    });
  }

  estimate(volume: number, codeRaw?: string): ReferralEstimate {
    const code = codeRaw ? normalizeCode(codeRaw) : undefined;
    const payoutBps = code ? (this.codes.get(code)?.payoutBps ?? this.opts.defaultPayoutBps) : this.opts.defaultPayoutBps;
    const cleanVolume = Number.isFinite(volume) && volume > 0 ? volume : 0;
    const grossFee = cleanVolume * (this.opts.rakeBps / 10_000);
    const referrerEarns = Math.min(grossFee, cleanVolume * (payoutBps / 10_000));
    return {
      volume: cleanVolume,
      rakeBps: this.opts.rakeBps,
      payoutBps,
      grossFee,
      referrerEarns,
      platformKeeps: grossFee - referrerEarns,
    };
  }

  recordMarketSettlement(market: Market): { entries: ReferralLedgerEntry[]; totalOwed: number } {
    const settlement = market.settlement;
    if (!settlement || settlement.outcome === 'VOID') return { entries: [], totalOwed: 0 };

    const entries: ReferralLedgerEntry[] = [];
    market.bets.forEach((bet, idx) => {
      const attr = this.attributions.get(bet.userId);
      if (!attr) return;
      const code = this.codes.get(attr.code);
      if (!code || !code.active) return;

      const id = `ref_${market.id}_${idx}_${hashId(bet.userId)}`;
      if (this.ledgerIds.has(id)) return;

      const est = this.estimate(bet.stake, code.code);
      const row: ReferralLedgerEntry = {
        id,
        marketId: market.id,
        userId: bet.userId,
        code: code.code,
        ownerId: code.ownerId,
        stake: bet.stake,
        grossFee: est.grossFee,
        referrerCut: est.referrerEarns,
        platformNetFee: est.platformKeeps,
        rakeBps: this.opts.rakeBps,
        payoutBps: code.payoutBps,
        asset: this.opts.asset ?? 'USX',
        settledAt: this.now(),
      };
      this.ledger.push(row);
      this.ledgerIds.add(row.id);
      entries.push(row);
    });

    if (entries.length) this.persist({ t: 'ledger_entries', entries });
    return {
      entries,
      totalOwed: entries.reduce((sum, row) => sum + row.referrerCut, 0),
    };
  }

  summary(filter: { code?: string; ownerId?: string } = {}): ReferralSummary {
    const code = filter.code ? normalizeCode(filter.code) : undefined;
    const ownerId = filter.ownerId?.trim();
    const rows = this.ledger.filter((row) => {
      if (code && row.code !== code) return false;
      if (ownerId && row.ownerId !== ownerId) return false;
      return true;
    });
    const users = new Set(
      [...this.attributions.values()]
        .filter((row) => {
          if (code && row.code !== code) return false;
          const rowOwner = canonicalWalletAccountId(row.ownerId) ?? row.ownerId;
          const filterOwner = ownerId ? (canonicalWalletAccountId(ownerId) ?? ownerId) : undefined;
          if (filterOwner && rowOwner !== filterOwner && row.ownerId !== ownerId) return false;
          const referred = canonicalWalletAccountId(row.userId);
          if (!referred) return false;
          if (referred === rowOwner) return false;
          return true;
        })
        .map((row) => canonicalWalletAccountId(row.userId)!),
    );
    const referrerEarned = rows.reduce((sum, row) => sum + row.referrerCut, 0);
    const referrerPaid = rows.reduce((sum, row) => sum + (row.paidAt ? row.referrerCut : 0), 0);
    return {
      ...(code ? { code } : {}),
      ...(ownerId ? { ownerId } : {}),
      attributedUsers: users.size,
      volume: rows.reduce((sum, row) => sum + row.stake, 0),
      grossFees: rows.reduce((sum, row) => sum + row.grossFee, 0),
      referrerEarned,
      referrerPaid,
      referrerUnpaid: referrerEarned - referrerPaid,
      platformNetFees: rows.reduce((sum, row) => sum + row.platformNetFee, 0),
      entries: rows.length,
      recent: rows.slice(-25).reverse(),
    };
  }

  markPaid(filter: { code?: string; ownerId?: string; payoutTx?: string; paidAt?: number }): {
    marked: number;
    amount: number;
  } {
    const code = filter.code ? normalizeCode(filter.code) : undefined;
    const ownerId = filter.ownerId?.trim();
    if (!code && !ownerId) throw new Error('code or ownerId required');
    const paidAt = filter.paidAt ?? this.now();
    let marked = 0;
    let amount = 0;
    const ids: string[] = [];
    for (const row of this.ledger) {
      if (row.paidAt) continue;
      if (code && row.code !== code) continue;
      if (ownerId && row.ownerId !== ownerId) continue;
      row.paidAt = paidAt;
      if (filter.payoutTx?.trim()) row.payoutTx = filter.payoutTx.trim();
      marked += 1;
      amount += row.referrerCut;
      ids.push(row.id);
    }
    if (marked) {
      this.persist({
        t: 'paid',
        ids,
        paidAt,
        ...(filter.payoutTx?.trim() ? { payoutTx: filter.payoutTx.trim() } : {}),
      });
    }
    return { marked, amount };
  }

  snapshot(): StoredReferralState {
    return {
      codes: [...this.codes.values()],
      attributions: [...this.attributions.values()],
      ledger: [...this.ledger],
    };
  }

  flush(): void {
    if (!this.opts.storePath) return;
    try {
      this.ensureStoreDir();
      const tmp = `${this.opts.storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 });
      renameSync(tmp, this.opts.storePath);
      writeFileSync(this.journalPath(), '', { mode: 0o600 });
    } catch (err) {
      console.warn(`[golazo/referrals] could not persist store: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!this.opts.storePath) return;
    if (!existsSync(this.opts.storePath) && !existsSync(this.journalPath())) return;
    try {
      if (existsSync(this.opts.storePath)) {
        const raw = JSON.parse(readFileSync(this.opts.storePath, 'utf8')) as Partial<StoredReferralState>;
        this.applySnapshot(raw);
      }
      if (existsSync(this.journalPath())) {
        const lines = readFileSync(this.journalPath(), 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.applyJournal(JSON.parse(trimmed) as ReferralJournalEvent);
        }
      }
      console.log(
        `[golazo/referrals] restored ${this.codes.size} codes, ` +
          `${this.attributions.size} attributions, ${this.ledger.length} ledger rows`,
      );
    } catch (err) {
      console.warn(`[golazo/referrals] could not read store: ${(err as Error).message}`);
    }
  }

  private applySnapshot(raw: Partial<StoredReferralState>): void {
    for (const row of raw.codes ?? []) {
      this.applyCode(row);
    }
    for (const row of raw.attributions ?? []) {
      this.applyAttribution(row);
    }
    for (const row of raw.ledger ?? []) {
      this.applyLedgerEntry(row);
    }
  }

  private applyJournal(ev: ReferralJournalEvent): void {
    if (!ev || typeof ev !== 'object') return;
    if (ev.t === 'code_created') {
      this.applyCode(ev.code);
    } else if (ev.t === 'code_active') {
      const code = normalizeCode(ev.code);
      const row = this.codes.get(code);
      if (row) row.active = ev.active;
    } else if (ev.t === 'attributed') {
      this.applyAttribution(ev.attribution);
    } else if (ev.t === 'ledger_entries') {
      for (const row of ev.entries ?? []) this.applyLedgerEntry(row);
    } else if (ev.t === 'paid') {
      const ids = new Set(ev.ids ?? []);
      for (const row of this.ledger) {
        if (!ids.has(row.id)) continue;
        row.paidAt = ev.paidAt;
        if (ev.payoutTx) row.payoutTx = ev.payoutTx;
      }
    }
  }

  private applyCode(row: Partial<ReferralCode>): void {
    const code = normalizeCode(row.code ?? '');
    if (!code || !row.ownerId) return;
    this.codes.set(code, {
      code,
      ownerId: row.ownerId,
      ...(row.ownerLabel ? { ownerLabel: row.ownerLabel } : {}),
      payoutBps: clampBps(row.payoutBps),
      active: row.active !== false,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt! : this.now(),
    });
  }

  private applyAttribution(row: Partial<ReferralAttribution>): void {
    if (!row.userId || !row.code || !row.ownerId) return;
    if (this.attributions.has(row.userId)) return;
    this.attributions.set(row.userId, {
      userId: row.userId,
      code: normalizeCode(row.code),
      ownerId: row.ownerId,
      attributedAt: Number.isFinite(row.attributedAt) ? row.attributedAt! : this.now(),
      ...(row.source ? { source: row.source } : {}),
    });
  }

  private applyLedgerEntry(row: Partial<ReferralLedgerEntry>): void {
    if (!row.id || !row.marketId || !row.userId || !row.code || !row.ownerId) return;
    if (this.ledgerIds.has(row.id)) return;
    this.ledger.push(row as ReferralLedgerEntry);
    this.ledgerIds.add(row.id);
  }

  private persist(ev: ReferralJournalEvent): void {
    if (!this.opts.storePath) return;
    try {
      this.ensureStoreDir();
      appendFileSync(this.journalPath(), `${JSON.stringify(ev)}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn(`[golazo/referrals] could not append journal: ${(err as Error).message}`);
    }
  }

  private ensureStoreDir(): void {
    if (!this.opts.storePath) return;
    mkdirSync(dirname(this.opts.storePath), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(this.opts.storePath), 0o700);
    } catch {
      /* best effort */
    }
  }

  private journalPath(): string {
    return `${this.opts.storePath}.journal`;
  }

  private generateUserCode(): string {
    for (let i = 0; i < 30; i++) {
      const code = `GO${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!this.codes.has(code)) return code;
    }
    return this.generateCode('user');
  }

  private generateCode(ownerId: string): string {
    const base = normalizeCode(ownerId).slice(0, 10) || 'PARTNER';
    for (let i = 0; i < 20; i++) {
      const suffix = Math.floor(Math.random() * 1_000_000).toString(36).toUpperCase().padStart(4, '0');
      const code = `${base}-${suffix}`;
      if (!this.codes.has(code)) return code;
    }
    throw new Error('could not generate unique code');
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private isOwnReferral(userId: string, code: string, ownerId: string): boolean {
    const owner = canonicalWalletAccountId(ownerId) ?? ownerId;
    if (owner === userId) return true;
    return this.codesForOwner(userId).some((row) => row.code === code);
  }
}

function emptyReferralSummary(): ReferralSummary {
  return {
    attributedUsers: 0,
    volume: 0,
    grossFees: 0,
    referrerEarned: 0,
    referrerPaid: 0,
    referrerUnpaid: 0,
    platformNetFees: 0,
    entries: 0,
    recent: [],
  };
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

function clampBps(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.round(raw as number) : 100;
  return Math.max(0, Math.min(10_000, n));
}

function hashId(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
  return (h >>> 0).toString(36);
}
