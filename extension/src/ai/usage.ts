import type { AISettings } from '../core/settings';

/** Daily token / cost accounting used to enforce the user's cost limit. */
export interface DailyUsage {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
  cacheHits: number;
}

export interface UsagePersistence {
  load(): Promise<DailyUsage | null>;
  save(u: DailyUsage): Promise<void>;
}

const today = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

export class UsageTracker {
  private usage: DailyUsage = { day: today(), requests: 0, promptTokens: 0, completionTokens: 0, costUSD: 0, cacheHits: 0 };
  private listeners = new Set<(u: DailyUsage) => void>();

  constructor(private persistence?: UsagePersistence) {}

  async init(): Promise<void> {
    const stored = await this.persistence?.load();
    if (stored && stored.day === today()) this.usage = stored;
  }

  private roll(): void {
    if (this.usage.day !== today()) this.usage = { day: today(), requests: 0, promptTokens: 0, completionTokens: 0, costUSD: 0, cacheHits: 0 };
  }

  /** `model`: which of the two models ran; the deep one may have its own prices. */
  record(ai: AISettings, promptTokens: number, completionTokens: number, model: 'fast' | 'deep' = 'fast'): void {
    this.roll();
    this.usage.requests++;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    const inPrice = model === 'deep' ? (ai.deepInputPricePerM ?? ai.inputPricePerM) : ai.inputPricePerM;
    const outPrice = model === 'deep' ? (ai.deepOutputPricePerM ?? ai.outputPricePerM) : ai.outputPricePerM;
    if (ai.mode !== 'device') this.usage.costUSD += (promptTokens * inPrice + completionTokens * outPrice) / 1_000_000;
    void this.persistence?.save(this.usage);
    this.listeners.forEach((l) => l(this.get()));
  }

  /** Minutes of audio sent for transcription count toward the same daily cost limit. */
  recordAudio(seconds: number, pricePerMinute: number): void {
    this.roll();
    this.usage.requests++;
    this.usage.costUSD += (Math.max(0, seconds) / 60) * Math.max(0, pricePerMinute);
    void this.persistence?.save(this.usage);
    this.listeners.forEach((l) => l(this.get()));
  }

  recordCacheHit(): void {
    this.roll();
    this.usage.cacheHits++;
  }

  get(): DailyUsage {
    this.roll();
    return { ...this.usage };
  }

  overBudget(dailyBudgetUSD: number): boolean {
    return dailyBudgetUSD > 0 && this.get().costUSD >= dailyBudgetUSD;
  }

  subscribe(fn: (u: DailyUsage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
