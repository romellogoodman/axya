/*
 * EBB command strings for planner moves.
 *
 * Ported from the string formatting in nextdrawcore/dripfeed.py (feed_t3,
 * feed_td; nextdraw 1.7.5) and plotink/ebb3_motion.py (xy_move, used by
 * feed_sm), docs/reference-apps/nextdraw-1.7.5/.
 * dripfeed.py: Copyright 2025 Windell H. Oskay, Bantam Tools
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 * ebb3_motion.py: Copyright (c) 2025 Windell H. Oskay, Bantam Tools; MIT
 * License (full text in ebbCalc.ts).
 *
 * dripfeed appends "\r", which ebb3_serial.command() strips before
 * re-adding its own terminator, so the strings here carry none.
 */

import type { Move, SMParams, T3Params, TDParams } from "./types.ts";

// Every field is a Python int; refuse anything that would print differently.
function int(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`EBB command field is not an integer: ${value}`);
  }
  return String(value + 0);
}

/** "T3,T,R1,A1,J1,R2,A2,J2" (dripfeed.py:204). */
export function formatT3(mov: T3Params): string {
  return `T3,${int(mov[0])},${int(mov[1])},${int(mov[2])},${int(mov[3])},${int(mov[4])},${int(mov[5])},${int(mov[6])}`;
}

/** "TD,T,R1A,R1B,A1,J1,R2A,R2B,A2,J2" (dripfeed.py:288-289). */
export function formatTD(mov: TDParams): string {
  return (
    `TD,${int(mov[0])},${int(mov[1])},${int(mov[2])},${int(mov[3])},${int(mov[4])},${int(mov[5])},${int(mov[6])},` +
    `${int(mov[7])},${int(mov[8])}`
  );
}

/**
 * "SM,ms,axis1,axis2" for an ['SM', (steps2, steps1, ms)] move: feed_sm
 * calls xy_move(steps2, steps1, ms), which prints its second argument
 * first (dripfeed.py:134-148, ebb3_motion.py:65-77).
 */
export function formatSM(mov: SMParams): string {
  const [moveSteps2, moveSteps1, moveTime] = mov;
  return `SM,${int(moveTime)},${int(moveSteps1)},${int(moveSteps2)}`;
}

/** The command a move sends, or null for pen moves (handled by pen code). */
export function formatMove(move: Move): string | null {
  switch (move[0]) {
    case "T3":
      return formatT3(move[1]);
    case "TD":
      return formatTD(move[1]);
    case "SM":
      return formatSM(move[1]);
    default:
      return null;
  }
}
