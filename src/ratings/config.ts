/**
 * Every tunable of the rating system in one place. The numbers below were
 * chosen by simulating a closed 4-player pod that plays each other repeatedly —
 * the situation this bot actually lives in — with ts-trueskill itself.
 *
 * The problem they solve: with TrueSkill's default dynamics (tau = sigma0/100),
 * sigma in a closed pod collapses to ~0.7 after a few dozen games. A 4-pod win
 * then moves the winner +6 SR and last place -6 SR, and the ladder order
 * freezes because nothing can ever cross a 100-SR gap. "Stale and stagnant."
 *
 * Changing any value here changes future ratings only; run
 * `npm run recompute-ratings` to replay history under the new constants.
 */
export const RATING = {
  /** Prior mean for a new player. */
  MU0: 25,
  /** Prior uncertainty for a new player (sigma0). */
  SIGMA0: 25 / 3,
  /** Skill gap that gives ~76% win probability. TrueSkill default. */
  BETA: 25 / 6,
  /** Prior probability that a pod ends in a draw. */
  DRAW_PROBABILITY: 0.1,

  /**
   * Dynamics factor: sigma^2 += TAU^2 before every game, so skill is allowed to
   * drift and ratings never fully freeze. sigma0/12 ≈ 0.694 (default 0.083).
   *
   *   tau     settled sigma   avg |ΔSR| per game (4-pod, random results)
   *   0.083   0.67             3     ← the complaint
   *   0.35    1.38            14
   *   0.50    1.65            20
   *   0.694   1.94            28     ← chosen: a 4-pod finish is +45/+17/-10/-45
   *   1.00    2.34            41
   */
  TAU: 25 / 36,

  /**
   * Floor on sigma after a game. Below ~1.25 the winner of an even pod gains
   * nothing at all; at 1.5 a win is still +18 SR. With TAU above this rarely
   * binds — it is a backstop against the freeze, not a driver.
   */
  SIGMA_MIN: 1.5,

  /**
   * Rust: sigma^2 grows by RUST_K^2 per idle day past the grace window, so a
   * returning player is "provisional again" and moves fast, in either
   * direction. From a settled sigma of 2.0:
   *   14 idle days → 2.40 (−48 SR)     30 → 3.12 (−135 SR)     60 → 4.15 (−258 SR)
   * A rusted player at sigma 4.0 who wins a pod of settled players gains
   * ~200 SR in that one game, so a month away is repaired by one good night.
   */
  RUST_K: 0.5,
  /** Days of inactivity that cost nothing — a weekly pod never rusts. */
  RUST_GRACE_DAYS: 7,

  /** Display: SR = (mu − 3·sigma) · SCALE + OFFSET; a fresh player sits at 500. */
  SR_SCALE: 40,
  SR_OFFSET: 500,

  /** Monte Carlo samples for /predict. 2,000 costs ~2 ms; 50k moves results <1 pp. */
  PREDICT_ITERATIONS: 2000,
} as const;
