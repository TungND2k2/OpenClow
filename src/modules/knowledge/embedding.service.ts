/**
 * Embedding Service — local vector embeddings using transformers.js
 *
 * Model: all-MiniLM-L6-v2 (384 dimensions, ~80MB, runs on CPU)
 * Used for: semantic search in knowledge_entries
 *
 * First call loads model (~5s). Subsequent calls are instant.
 */

let _pipeline: any = null;

async function getEmbeddingPipeline() {
  if (_pipeline) return _pipeline;

  try {
    const { pipeline } = await import("@xenova/transformers");
    _pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.error("[Embedding] Model loaded: all-MiniLM-L6-v2 (384d)");
    return _pipeline;
  } catch (e: any) {
    console.error(`[Embedding] Model load failed: ${e.message}. Falling back to keyword matching.`);
    return null;
  }
}

/**
 * Generate embedding vector for text.
 * Returns Float32Array(384) or null if model unavailable.
 */
export async function embed(text: string): Promise<number[] | null> {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return null;

  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, 384);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * Pre-warm the model on startup (optional).
 */
export async function warmupEmbedding(): Promise<boolean> {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return false;
  // Warm up with a test embedding
  await embed("warmup test");
  return true;
}
