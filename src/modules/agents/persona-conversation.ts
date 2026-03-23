/**
 * Persona Conversation — multiple personas within 1 bot discuss a topic.
 *
 * Commander receives user message → decides which personas should participate
 * → each persona responds in turn, seeing previous responses
 * → each response sent to Telegram as separate message with persona prefix
 */

import { AgentRunner, type LLMEngine } from "./agent-runner.js";
import { getDb } from "../../db/connection.js";
import { agentTemplates } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";

export interface Persona {
  name: string;
  emoji: string;
  systemPrompt: string;
  role: string;
}

export interface PersonaMessage {
  persona: Persona;
  content: string;
}

/**
 * Get all personas for a tenant (from agent_templates with role != "commander")
 */
export async function getPersonas(tenantId?: string): Promise<Persona[]> {
  const db = getDb();
  const templates = await db.select().from(agentTemplates)
    .where(eq(agentTemplates.status, "active"));

  return templates
    .filter(t => t.role !== "commander")
    .map(t => ({
      name: t.name,
      emoji: (t.capabilities as any)?.emoji ?? "🤖",
      systemPrompt: t.systemPrompt,
      role: t.role,
    }));
}

/**
 * Commander decides which personas should participate in this conversation.
 * Returns list of persona names in order they should speak.
 */
export async function routeToPersonas(input: {
  userMessage: string;
  availablePersonas: Persona[];
  engine: LLMEngine;
  workerApiBase: string;
  workerApiKey: string;
  workerModel: string;
}): Promise<string[]> {
  if (input.availablePersonas.length === 0) return [];

  const personaList = input.availablePersonas
    .map(p => `${p.emoji} ${p.name} (${p.role}): ${p.systemPrompt.substring(0, 80)}`)
    .join("\n");

  try {
    const resp = await fetch(`${input.workerApiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.workerApiKey}`,
      },
      body: JSON.stringify({
        model: input.workerModel,
        messages: [{
          role: "user",
          content: `User hỏi: "${input.userMessage}"

Personas có sẵn:
${personaList}

Personas nào nên tham gia trả lời? Trả lời tên personas cách nhau bằng dấu phẩy, theo thứ tự nên trả lời.
Nếu câu hỏi đơn giản chỉ cần 1 persona → trả 1 tên.
Nếu cần trao đổi → trả 2-3 tên (persona đầu nói trước, persona sau phản hồi).
Chỉ trả lời tên, không giải thích.`,
        }],
        max_tokens: 50,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return [input.availablePersonas[0].name];
    const data = (await resp.json()) as any;
    const answer = data.choices?.[0]?.message?.content ?? "";
    const names = answer.split(",").map((n: string) => n.trim()).filter(Boolean);

    // Validate names exist
    const valid = names.filter((n: string) =>
      input.availablePersonas.some(p => p.name.toLowerCase().includes(n.toLowerCase()))
    );

    return valid.length > 0 ? valid : [input.availablePersonas[0].name];
  } catch {
    return [input.availablePersonas[0].name];
  }
}

/**
 * Run multi-persona conversation.
 * Each persona speaks in turn, seeing all previous responses.
 * Returns messages in order — caller sends each as separate Telegram message.
 */
export async function runPersonaConversation(input: {
  userMessage: string;
  personas: Persona[];
  participantNames: string[];
  conversationHistory: { role: string; content: string }[];
  executeTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  engine: LLMEngine;
  maxRounds?: number;
}): Promise<PersonaMessage[]> {
  const messages: PersonaMessage[] = [];
  const maxRounds = input.maxRounds ?? 3;
  let roundMessages: string[] = [];

  for (let round = 0; round < maxRounds; round++) {
    for (const name of input.participantNames) {
      const persona = input.personas.find(p =>
        p.name.toLowerCase().includes(name.toLowerCase())
      );
      if (!persona) continue;

      // Build context: previous personas' responses in this conversation
      const prevContext = roundMessages.length > 0
        ? `\n\nCuộc trao đổi trước đó:\n${roundMessages.join("\n")}`
        : "";

      const isLastSpeaker = name === input.participantNames[input.participantNames.length - 1]
        && round === maxRounds - 1;

      const systemPrompt = `${persona.systemPrompt}

Bạn là ${persona.emoji} ${persona.name}. Luôn bắt đầu response bằng chủ ngữ rõ ràng.
${prevContext}

User hỏi: "${input.userMessage}"

Quy tắc:
- Trả lời ngắn gọn (2-4 câu)
- Nếu cần hỏi persona khác → tag @TênPersona
- Nếu cần gọi tool → gọi bình thường
${isLastSpeaker ? "- Đây là lượt cuối — đưa ra kết luận." : ""}`;

      const runner = new AgentRunner({
        agent: { id: `persona_${persona.name}`, name: persona.name } as any,
        engine: input.engine,
        tools: [],
        systemPrompt,
        executeTool: input.executeTool,
        maxToolLoops: 3,
      });

      try {
        const result = await runner.think(input.userMessage, input.conversationHistory);
        const content = result.text.trim();

        messages.push({ persona, content });
        roundMessages.push(`${persona.emoji} ${persona.name}: ${content}`);

        // If response doesn't tag another persona → conversation done
        const tagsAnother = input.participantNames.some(n =>
          n !== name && content.toLowerCase().includes(`@${n.toLowerCase()}`)
        );

        if (!tagsAnother && round > 0) {
          // No more tags, conversation naturally ended
          return messages;
        }
      } catch (e: any) {
        messages.push({
          persona,
          content: `⚠️ ${persona.name} gặp lỗi: ${e.message.substring(0, 50)}`,
        });
      }
    }
  }

  return messages;
}
