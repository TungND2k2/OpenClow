/**
 * Token Manager — context window management.
 *
 * Estimates token count and truncates context to fit within limits.
 * Priority order (highest to lowest):
 *   1. System prompt (never truncated)
 *   2. Form state (active form)
 *   3. Resource summary
 *   4. Knowledge context
 *   5. Recent messages (last 5)
 *   6. Older messages (truncated first)
 *
 * Token estimation: ~4 chars = 1 token (rough but fast).
 * Claude context: ~100K tokens, but we target ~8K for speed.
 */

export interface ContextParts {
  systemPrompt: string;
  formContext: string;
  resourceContext: string;
  knowledgeContext: string;
  conversationHistory: { role: string; content: string }[];
}

export interface ManagedContext {
  systemPrompt: string;
  history: { role: string; content: string }[];
  totalTokens: number;
  truncated: boolean;
}

// Rough token estimation: 4 chars ≈ 1 token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Manage context to fit within token budget.
 *
 * @param parts — all context parts
 * @param maxTokens — target token budget (default 8000 for speed)
 */
export function manageContext(parts: ContextParts, maxTokens: number = 8000): ManagedContext {
  // Priority 1: System prompt (always included)
  const promptTokens = estimateTokens(parts.systemPrompt);

  // Priority 2: Form + Resource + Knowledge (append to prompt)
  const formTokens = estimateTokens(parts.formContext);
  const resourceTokens = estimateTokens(parts.resourceContext);
  const knowledgeTokens = estimateTokens(parts.knowledgeContext);

  const fixedTokens = promptTokens + formTokens + resourceTokens + knowledgeTokens;
  const historyBudget = maxTokens - fixedTokens;

  let truncated = false;
  let history = [...parts.conversationHistory];

  if (historyBudget <= 0) {
    // No room for history — keep last 2 messages only
    history = history.slice(-2);
    truncated = true;
  } else {
    // Fit history into budget — keep recent, drop old
    let totalHistoryTokens = 0;
    const kept: typeof history = [];

    // Always keep last 5 messages
    const recent = history.slice(-5);
    const older = history.slice(0, -5);

    for (const msg of recent) {
      totalHistoryTokens += estimateTokens(msg.content);
      kept.push(msg);
    }

    // Add older messages if budget allows (most recent first)
    for (let i = older.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(older[i].content);
      if (totalHistoryTokens + msgTokens > historyBudget) {
        truncated = true;
        break;
      }
      totalHistoryTokens += msgTokens;
      kept.unshift(older[i]);
    }

    history = kept;
  }

  // Build final prompt with all context appended
  const fullPrompt = [
    parts.systemPrompt,
    parts.formContext,
    parts.resourceContext,
    parts.knowledgeContext,
  ].filter(Boolean).join("\n");

  const totalTokens = estimateTokens(fullPrompt) + history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  return {
    systemPrompt: fullPrompt,
    history,
    totalTokens,
    truncated,
  };
}
