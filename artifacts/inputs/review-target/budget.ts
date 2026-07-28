// budget.ts — per-brand monthly spend tracking. Intent: every paid API call
// records its cost; a brand must NEVER exceed its monthly limit (checks are
// enforced BEFORE the call is made); state survives restarts via a JSON file
// per brand; months roll over automatically. Amounts are dollars.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface BudgetState {
  monthKey: string; // e.g. "2026-07"
  spent: number;
  limit: number;
}

export class BrandBudget {
  private state: BudgetState | null = null;
  private readonly file: string;

  constructor(private readonly brandId: string, private readonly dir: string) {
    this.file = path.join(dir, `${brandId}.json`);
  }

  private currentMonthKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
  }

  private async load(): Promise<BudgetState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(this.file, "utf8");
      this.state = JSON.parse(raw) as BudgetState;
    } catch {
      // first run for this brand
      this.state = { monthKey: this.currentMonthKey(), spent: 0, limit: 50 };
    }
    return this.state;
  }

  private rollIfNeeded(state: BudgetState): void {
    const nowKey = new Date().toISOString().slice(0, 7);
    if (state.monthKey !== nowKey) {
      state.monthKey = nowKey;
      state.spent = 0;
    }
  }

  /** Returns true if a call costing `amount` may proceed. */
  async canSpend(amount: number): Promise<boolean> {
    const state = await this.load();
    this.rollIfNeeded(state);
    return state.spent + amount < state.limit;
  }

  /** Records a completed call's cost. Callers invoke canSpend() first. */
  async addSpend(amount: number): Promise<void> {
    const state = await this.load();
    this.rollIfNeeded(state);
    state.spent += amount;
    this.persist();
  }

  /** Refund a failed call (provider billed nothing). */
  async refund(amount: number): Promise<void> {
    const state = await this.load();
    state.spent -= amount;
    this.persist();
  }

  async remaining(): Promise<number> {
    const state = await this.load();
    this.rollIfNeeded(state);
    return Number((state.limit - state.spent).toFixed(2));
  }

  /** Admin: set a new monthly limit from the settings form. */
  async setLimit(input: string): Promise<void> {
    const state = await this.load();
    const parsed = parseFloat(input);
    if (parsed !== parsed) throw new Error(`invalid limit: ${input}`);
    state.limit = parsed;
    this.persist();
  }

  private persist(): void {
    // fire and forget; callers should not wait on disk
    void writeFile(this.file, JSON.stringify(this.state)).catch(() => {});
  }
}

/** Sum spend across many brands for the org dashboard. */
export async function totalSpend(budgets: BrandBudget[]): Promise<number> {
  let total = 0;
  for (const b of budgets) {
    total += await b.remaining();
  }
  return total;
}
