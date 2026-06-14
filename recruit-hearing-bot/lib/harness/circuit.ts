// lib/harness/circuit.ts
// サーキットブレーカ。AIが連続失敗したら一定時間「バイパス（呼ばない）」して、
// 無駄な待ち時間（タイムアウト連発）を避け、即フォールバックへ倒す。
// web_hearing の aiCircuit.ts を MVP 向けに簡素化したもの。

export type AiFailType =
  | "timeout"
  | "auth"
  | "rate"
  | "server"
  | "bad_output"
  | "unknown";

type CircuitState = {
  failures: number[]; // 失敗時刻(ms)
  openUntil: number; // この時刻まではAIを呼ばない
  lastFailure?: { at: number; type: AiFailType; message?: string };
};

function now() {
  return Date.now();
}

function prune(failures: number[], windowMs: number) {
  const t = now();
  while (failures.length && t - failures[0] > windowMs) failures.shift();
}

/** デフォルトでカウントする失敗種別（bad_output / rate はノイズになりやすいので除外） */
const DEFAULT_COUNT_TYPES: Set<AiFailType> = new Set([
  "timeout",
  "auth",
  "server",
  "unknown",
]);

export class AICircuit {
  private st: CircuitState = { failures: [], openUntil: 0 };

  constructor(
    readonly name: string,
    private readonly opts: {
      windowMs: number;
      threshold: number;
      cooldownMs: number;
      countTypes?: Set<AiFailType>;
    }
  ) {}

  private countTypes(): Set<AiFailType> {
    return this.opts.countTypes ?? DEFAULT_COUNT_TYPES;
  }

  /** 今はAIを呼ばない方がよい（遮断中）か */
  shouldBypass(): boolean {
    return now() < this.st.openUntil;
  }

  recordSuccess(): void {
    this.st.failures = [];
    this.st.openUntil = 0;
  }

  recordFailure(type: AiFailType = "unknown", message?: string): void {
    const t = now();
    this.st.lastFailure = { at: t, type, message };
    if (!this.countTypes().has(type)) return;

    prune(this.st.failures, this.opts.windowMs);
    this.st.failures.push(t);

    if (this.st.failures.length >= this.opts.threshold) {
      this.st.openUntil = t + this.opts.cooldownMs;
      this.st.failures = [];
    }
  }

  status() {
    return {
      name: this.name,
      bypass: this.shouldBypass(),
      openUntil: this.st.openUntil,
      failuresInWindow: this.st.failures.length,
      lastFailure: this.st.lastFailure,
    };
  }
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const windowMs = num("AI_FAIL_WINDOW_MS", 60_000);
const threshold = num("AI_FAIL_THRESHOLD", 3);
const cooldownMs = num("AI_COOLDOWN_MS", 90_000);

// 用途ごとに回路を分け、片方の失敗がもう片方に波及しないようにする。
export const circuits = {
  classify: new AICircuit("classify", { windowMs, threshold, cooldownMs }),
  answer: new AICircuit("answer", { windowMs, threshold, cooldownMs }),
  deepen: new AICircuit("deepen", { windowMs, threshold, cooldownMs }),
} as const;

export type CircuitName = keyof typeof circuits;
