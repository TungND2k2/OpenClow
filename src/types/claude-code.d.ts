declare module "@anthropic-ai/claude-code" {
  interface QueryOptions {
    prompt: string;
    systemPrompt?: string;
    options?: {
      maxTurns?: number;
      [key: string]: unknown;
    };
  }

  interface QueryMessage {
    type: string;
    content?: string;
    [key: string]: unknown;
  }

  export function query(options: QueryOptions): AsyncIterable<QueryMessage>;
}
