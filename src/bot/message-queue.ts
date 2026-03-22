/**
 * In-memory message queue with concurrent workers.
 *
 * Flow:
 *   Telegram poll → enqueue(job) → workers pick up → process → send response
 *
 * Features:
 * - Configurable concurrency (default 5 parallel workers)
 * - Auto-retry on failure (max 3)
 * - Job timeout (60s default)
 * - Backpressure — reject when queue full
 * - Priority queue — admin messages first
 * - Metrics tracking
 */

export interface QueueJob {
  id: string;
  chatId: number | string;
  userId: string;
  userName: string;
  userRole: string;
  text: string;
  tenantId: string;
  botToken: string; // token of the bot this message came from
  priority: number; // lower = higher priority. admin=1, user=5
  createdAt: number;
  retries: number;
  maxRetries: number;
}

export interface QueueMetrics {
  enqueued: number;
  processed: number;
  failed: number;
  retried: number;
  avgProcessingMs: number;
  currentQueueSize: number;
  activeWorkers: number;
}

type JobHandler = (job: QueueJob) => Promise<void>;

export class MessageQueue {
  private queue: QueueJob[] = [];
  private activeJobs = new Map<string, { job: QueueJob; startedAt: number }>();
  private handler: JobHandler;
  private concurrency: number;
  private maxQueueSize: number;
  private jobTimeoutMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  // Metrics
  private metrics: QueueMetrics = {
    enqueued: 0,
    processed: 0,
    failed: 0,
    retried: 0,
    avgProcessingMs: 0,
    currentQueueSize: 0,
    activeWorkers: 0,
  };
  private totalProcessingMs = 0;

  constructor(
    handler: JobHandler,
    options?: {
      concurrency?: number;
      maxQueueSize?: number;
      jobTimeoutMs?: number;
    }
  ) {
    this.handler = handler;
    this.concurrency = options?.concurrency ?? 5;
    this.maxQueueSize = options?.maxQueueSize ?? 100;
    this.jobTimeoutMs = options?.jobTimeoutMs ?? 60000;
  }

  /**
   * Add a job to the queue.
   */
  enqueue(job: QueueJob): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      console.error(`[Queue] FULL (${this.maxQueueSize}) — dropping message from ${job.userName}`);
      return false;
    }

    // Insert sorted by priority (lower number = higher priority)
    const insertIdx = this.queue.findIndex((j) => j.priority > job.priority);
    if (insertIdx === -1) {
      this.queue.push(job);
    } else {
      this.queue.splice(insertIdx, 0, job);
    }

    this.metrics.enqueued++;
    this.metrics.currentQueueSize = this.queue.length;

    console.error(
      `[Queue] +1 ${job.userName}[${job.userRole}] (queue: ${this.queue.length}, active: ${this.activeJobs.size})`
    );

    return true;
  }

  /**
   * Start processing loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.processLoop();
    console.error(`[Queue] Started (concurrency: ${this.concurrency}, max: ${this.maxQueueSize})`);
  }

  /**
   * Stop processing.
   */
  stop(): void {
    this.running = false;
    console.error(`[Queue] Stopping (${this.activeJobs.size} active, ${this.queue.length} queued)`);
  }

  /**
   * Get current metrics.
   */
  getMetrics(): QueueMetrics {
    return {
      ...this.metrics,
      currentQueueSize: this.queue.length,
      activeWorkers: this.activeJobs.size,
      avgProcessingMs:
        this.metrics.processed > 0
          ? Math.round(this.totalProcessingMs / this.metrics.processed)
          : 0,
    };
  }

  /**
   * Main processing loop.
   */
  private async processLoop(): Promise<void> {
    while (this.running) {
      // Check for timed-out jobs
      this.checkTimeouts();

      // Fill available worker slots
      while (this.activeJobs.size < this.concurrency && this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.metrics.currentQueueSize = this.queue.length;
        this.processJob(job); // fire and forget — runs concurrently
      }

      // Small delay to prevent busy-wait
      await sleep(50);
    }
  }

  /**
   * Process a single job.
   */
  private async processJob(job: QueueJob): Promise<void> {
    const startedAt = Date.now();
    this.activeJobs.set(job.id, { job, startedAt });
    this.metrics.activeWorkers = this.activeJobs.size;

    try {
      await this.handler(job);

      const durationMs = Date.now() - startedAt;
      this.metrics.processed++;
      this.totalProcessingMs += durationMs;

      console.error(
        `[Queue] ✓ ${job.userName} done (${durationMs}ms, queue: ${this.queue.length})`
      );
    } catch (e: any) {
      const durationMs = Date.now() - startedAt;
      console.error(`[Queue] ✗ ${job.userName} failed (${durationMs}ms): ${e.message}`);

      if (job.retries < job.maxRetries) {
        job.retries++;
        this.metrics.retried++;
        console.error(`[Queue] ↻ Retry ${job.retries}/${job.maxRetries} for ${job.userName}`);
        this.queue.push(job); // re-enqueue at end
      } else {
        this.metrics.failed++;
        console.error(`[Queue] ✗ Max retries reached for ${job.userName}, dropping`);
      }
    } finally {
      this.activeJobs.delete(job.id);
      this.metrics.activeWorkers = this.activeJobs.size;
    }
  }

  /**
   * Check and handle timed-out jobs.
   */
  private checkTimeouts(): void {
    const now = Date.now();
    for (const [id, { job, startedAt }] of this.activeJobs) {
      if (now - startedAt > this.jobTimeoutMs) {
        console.error(`[Queue] ⏱ Timeout: ${job.userName} (${Math.round((now - startedAt) / 1000)}s)`);
        // Don't kill the promise — just log. The AbortSignal in fetch will handle it.
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
