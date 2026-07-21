import { GAME_CONFIG } from "./gameConfig.js";

export const DEFAULT_SCORING = Object.freeze({
  baseCorrectPoints: GAME_CONFIG.scoring.baseCorrectPoints,
  speedBonusMax: GAME_CONFIG.scoring.speedBonusMax,
  speedWindowMs: GAME_CONFIG.scoring.speedWindowMs,
  streakBonusStep: GAME_CONFIG.scoring.streakBonusStep,
  streakBonusCap: GAME_CONFIG.scoring.streakBonusCap
});

export function toMillis(ts) {
  if (typeof ts === "number") return ts;
  if (ts?.toMillis) return ts.toMillis();
  return null;
}

export function computeStreakBonus(streak, scoring = DEFAULT_SCORING) {
  if (streak <= 1) return 0;
  const raw = (streak - 1) * scoring.streakBonusStep;
  return Math.min(raw, scoring.streakBonusCap);
}

export function computeSpeedBonus(delayMs, scoring = DEFAULT_SCORING) {
  if (delayMs <= 0) return scoring.speedBonusMax;
  if (delayMs >= scoring.speedWindowMs) return 0;
  const ratio = 1 - (delayMs / scoring.speedWindowMs);
  return Math.round(scoring.speedBonusMax * ratio);
}
