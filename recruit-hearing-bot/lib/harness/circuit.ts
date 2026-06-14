// lib/harness/circuit.ts
// サーキットブレーカ。AIが連続失敗したら一定時間「バイパス（呼ばない）」して、
// 無駄な待ち時間（タイムアウト連発）を避け、即フォールバックへ倒す。
// web_hearing の aiCircuit.ts を MVP 向けに簡素化したもの。

export type AiFailType =
  | "timeout"
  | "network"
  | "auth"
  | "rate"
  | "server"
  | "bad_output"
  | "unknown";

type FailEvent = { at: number; type: AiFailType };

type CircuitState = {
  failures: FailEvent[]; // 失敗イベント（時刻＋種別）
  openUntil: number; // この時刻まではAIを呼ばない
  lastFailure?: { at: number; type: AiFailType; message?: string };
};

function now() {
  return Date.now();
}

function prune(failures: FailEvent[], windowMs: number) {
  const t = now();
  while (failures.length && t - failures[0].at > windowMs) failures.shift();
}

/** デフォルトでカウントする失敗種別（bad_output / rate はノイズになりやすいので除外） */
const DEFAULT_COUNT_TYPES: Set<AiFailType> = new Set([
  "timeout",
  "network",
  "auth",
  "server",
  "unknown",
]);

/**
 * 「すぐに遮断（固定質問フォールバックへ）」する失敗種別。
 * ネットワーク障害は一過性でないことが多く、毎ターン待ち時間を出さないよう少ない回数で倒す。
 */
const FAST_TRIP_TYPES: Set<AiFailType> = new Set(["network"]);

export class AICircuit {
  private st: CircuitState = { failures: [], openUntil: 0 };

  constructor(
    readonly name: string,
    private readonly opts: {
      windowMs: number;
      threshold: number;
      cooldownMs: number;
      /** ネットワーク等の即遮断対象を倒す失敗回数（threshold より小さく） */
      fastThreshold?: number;
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
    // 1回でも成功すれば回線は生きている → グローバルなネットワーク遮断も解除。
    networkGuard.recordSuccess();
  }

  recordFailure(
    type: AiFailType = "unknown",
    message?: string,
    retryAfterMs?: number
  ): void {
    const t = now();
    this.st.lastFailure = { at: t, type, message };

    // ネットワーク障害はどのフェーズで起きても全体へ反映（全フェーズを固定質問へ倒す）。
    if (type === "network") networkGuard.recordNetworkFailure();

    // エラーコードで“すぐ判断”できる種別は、連続失敗を待たずに即バックオフする。
    //  - rate(429): サーバ提示の待ち時間(retryAfterMs)があれば尊重、無ければ cooldownMs。
    //  - auth(401/403): セッション中に自然回復しないので cooldownMs バックオフ。
    // いずれも鍵/クォータは全フェーズ共通なので、グローバルにも反映して全AIを止める。
    if (type === "rate" || type === "auth") {
      const wait =
        type === "rate" && retryAfterMs && retryAfterMs > 0
          ? retryAfterMs
          : this.opts.cooldownMs;
      this.st.openUntil = Math.max(this.st.openUntil, t + wait);
      this.st.failures = [];
      networkGuard.openFor(wait);
      return;
    }

    if (!this.countTypes().has(type)) return;

    prune(this.st.failures, this.opts.windowMs);
    this.st.failures.push({ at: t, type });

    // 通常のしきい値、または「即遮断対象（network等）」の少数しきい値のどちらかに達したら開く。
    const fastThreshold = this.opts.fastThreshold ?? 2;
    const fastCount = this.st.failures.filter((f) => FAST_TRIP_TYPES.has(f.type)).length;
    const trip =
      this.st.failures.length >= this.opts.threshold ||
      fastCount >= fastThreshold;

    if (trip) {
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
/** ネットワーク障害は少ない回数で即遮断（固定質問へフォールバック） */
const fastThreshold = num("AI_NETWORK_FAIL_THRESHOLD", 2);

/**
 * グローバルなAIバックオフ・ガード。
 * 全フェーズ共通の事象（ネットワーク障害・レート制限429・認証失敗）を検知したら、
 * どのフェーズで起きても全AI呼び出しを一括で止め、即座に固定質問のフローへ倒す。
 *  - ネットワーク: 連続失敗で遮断（recordNetworkFailure）
 *  - レート/認証: エラーコードで即バックオフ（openFor。429はretry-afterを尊重）
 */
class NetworkGuard {
  private failures: number[] = [];
  private openUntil = 0;
  constructor(
    private readonly opts: { windowMs: number; threshold: number; cooldownMs: number }
  ) {}
  shouldBypass(): boolean {
    return now() < this.openUntil;
  }
  recordSuccess(): void {
    this.failures = [];
    this.openUntil = 0;
  }
  /** 指定ミリ秒だけ全AIをバックオフ（429のretry-afterや認証失敗の即時遮断に使用）。 */
  openFor(ms: number): void {
    if (!(ms > 0)) return;
    this.openUntil = Math.max(this.openUntil, now() + ms);
  }
  recordNetworkFailure(): void {
    const t = now();
    while (this.failures.length && t - this.failures[0] > this.opts.windowMs)
      this.failures.shift();
    this.failures.push(t);
    if (this.failures.length >= this.opts.threshold) {
      this.openUntil = t + this.opts.cooldownMs;
      this.failures = [];
    }
  }
  status() {
    return { bypass: this.shouldBypass(), openUntil: this.openUntil };
  }
}

/** 全フェーズ共通のネットワーク障害ガード（fastThreshold 回で全AIを遮断）。 */
export const networkGuard = new NetworkGuard({
  windowMs,
  threshold: fastThreshold,
  cooldownMs,
});

// 用途ごとに回路を分け、片方の失敗がもう片方に波及しないようにする。
export const circuits = {
  classify: new AICircuit("classify", { windowMs, threshold, cooldownMs, fastThreshold }),
  answer: new AICircuit("answer", { windowMs, threshold, cooldownMs, fastThreshold }),
  deepen: new AICircuit("deepen", { windowMs, threshold, cooldownMs, fastThreshold }),
  assist: new AICircuit("assist", { windowMs, threshold, cooldownMs, fastThreshold }),
  gapfill: new AICircuit("gapfill", { windowMs, threshold, cooldownMs, fastThreshold }),
} as const;

export type CircuitName = keyof typeof circuits;
