// AI Cost Tracking Utilities

// Model pricing per million tokens (USD)
const MODEL_PRICING = {
  "gpt-4o-mini": {
    input: 0.15,    // $0.150 per 1M input tokens
    output: 0.60,   // $0.600 per 1M output tokens
  },
  "claude-haiku": {
    input: 0.80,    // $0.80 per 1M input tokens
    output: 4.00,   // $4.00 per 1M output tokens
  },
  "gpt-4o": {
    input: 2.50,    // $2.50 per 1M input tokens
    output: 10.00,  // $10.00 per 1M output tokens
  },
};

export type ModelType = keyof typeof MODEL_PRICING;

export interface TokenUsage {
  input: number;
  output: number;
}

/**
 * Calculate cost for a given model and token usage
 * @param tokens Token usage breakdown
 * @param model Model name
 * @returns Cost in USD
 */
export function calculateCost(tokens: TokenUsage, model: ModelType): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`Unknown model pricing: ${model}, returning 0 cost`);
    return 0;
  }

  const inputCost = (tokens.input / 1_000_000) * pricing.input;
  const outputCost = (tokens.output / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Cost tracker for aggregating costs across a scan
 */
export class CostTracker {
  private tier1Tokens: Record<string, TokenUsage> = {};
  private tier2Tokens: Record<string, TokenUsage> = {};

  /**
   * Add Tier 1 token usage
   */
  addTier1(tokens: TokenUsage, model: string): void {
    if (!this.tier1Tokens[model]) {
      this.tier1Tokens[model] = { input: 0, output: 0 };
    }
    this.tier1Tokens[model].input += tokens.input;
    this.tier1Tokens[model].output += tokens.output;
  }

  /**
   * Add Tier 2 token usage
   */
  addTier2(tokens: TokenUsage, model: string): void {
    if (!this.tier2Tokens[model]) {
      this.tier2Tokens[model] = { input: 0, output: 0 };
    }
    this.tier2Tokens[model].input += tokens.input;
    this.tier2Tokens[model].output += tokens.output;
  }

  /**
   * Get total costs and token usage
   */
  getTotals(): {
    tier1TokensUsed: Record<string, number>;
    tier2TokensUsed: Record<string, number>;
    tier1CostUsd: number;
    tier2CostUsd: number;
    totalCostUsd: number;
  } {
    // Calculate Tier 1 costs
    let tier1CostUsd = 0;
    const tier1TokensUsed: Record<string, number> = {};

    for (const [model, tokens] of Object.entries(this.tier1Tokens)) {
      const totalTokens = tokens.input + tokens.output;
      tier1TokensUsed[model] = totalTokens;
      tier1CostUsd += calculateCost(tokens, model as ModelType);
    }

    // Calculate Tier 2 costs
    let tier2CostUsd = 0;
    const tier2TokensUsed: Record<string, number> = {};

    for (const [model, tokens] of Object.entries(this.tier2Tokens)) {
      const totalTokens = tokens.input + tokens.output;
      tier2TokensUsed[model] = totalTokens;
      tier2CostUsd += calculateCost(tokens, model as ModelType);
    }

    return {
      tier1TokensUsed,
      tier2TokensUsed,
      tier1CostUsd,
      tier2CostUsd,
      totalCostUsd: tier1CostUsd + tier2CostUsd,
    };
  }

  /**
   * Reset all counters
   */
  reset(): void {
    this.tier1Tokens = {};
    this.tier2Tokens = {};
  }
}
