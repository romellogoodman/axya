/*
 * Dripfeed: send planned moves to the EBB one at a time (or simulate them in
 * preview), checking for pauses before each, keeping travel statistics and
 * the pause-position cache, and sleeping through long moves.
 *
 * Ported from nextdrawcore/dripfeed.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/dripfeed.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

import { formatT3, formatTD } from "../motion/commands.ts";
import type {
  Move,
  PenPosition,
  TDParams,
  T3Params,
  TrajectoryItem,
} from "../motion/types.ts";
import type { NextDraw } from "./nextdraw.ts";

/** feed: execute a move list from the planner. */
export async function feed(
  nd: NextDraw,
  moveList: TrajectoryItem[] | null
): Promise<void> {
  if (moveList === null) return;
  if (nd.plot_status.stopped) return;
  for (const item of moveList) {
    const alreadyStopped = nd.plot_status.stopped;
    await nd.pauseCheck();
    if (nd.plot_status.stopped && !alreadyStopped) {
      nd.plot_status.copies_to_plot = 0;
      await nd.machine.command("SP,3"); // raise pen, ignoring queued lowering
      return;
    }
    if (nd.pen.phys.xpos === null) return; // position not well defined
    // Planner quirk items (nested lists, (None, None)) carry no command tag.
    if (
      !Array.isArray(item) ||
      item.length === 0 ||
      typeof item[0] !== "string"
    )
      continue;
    const move = item as Move;
    if (move[0] === "lower") {
      await nd.pen.penLower(nd);
      continue;
    }
    if (move[0] === "raise") {
      await nd.pen.penRaise(nd);
      continue;
    }
    nd.plot_status.resume.drip.last_move = move;
    if (move[0] === "SM") await feedSm(nd, move);
    else if (move[0] === "T3") await feedT3(nd, move);
    else if (move[0] === "TD") await feedTd(nd, move);
  }
}

async function sleepAfterMove(nd: NextDraw, moveTime: number): Promise<void> {
  if (moveTime > 50 && nd.options.mode !== "utility") {
    await nd.clock.sleep(moveTime - 30); // time.sleep((move_time - 30) / 1000)
  }
}

async function feedSm(nd: NextDraw, move: Move): Promise<void> {
  const [steps2, steps1, moveTime] = move[1] as [number, number, number];
  const seg = move[2] as unknown as [number, number, unknown, number];
  if (nd.options.preview) {
    nd.plot_status.stats.pt_estimate += moveTime;
    nd.preview.logSmMove(nd, move);
  } else {
    await nd.machine.xyMove(steps2, steps1, moveTime);
    await sleepAfterMove(nd, moveTime);
  }
  nd.addDist(seg[3]);
  nd.pen.phys.xpos = seg[0];
  nd.pen.phys.ypos = seg[1];
}

function commitPosition(nd: NextDraw, pos: PenPosition): void {
  nd.pen.phys.xpos = pos.xpos as number;
  nd.pen.phys.ypos = pos.ypos as number;
  nd.pen.phys.accum1 = pos.accum1;
  nd.pen.phys.accum2 = pos.accum2;
}

async function feedT3(nd: NextDraw, move: Move): Promise<void> {
  const mov = move[1] as T3Params;
  const [moveDist, pos] = move[2] as [number, PenPosition];
  const moveTime = mov[0] / 25.0; // 25 ticks per ms
  if (nd.options.preview) {
    nd.plot_status.stats.pt_estimate += moveTime;
    nd.preview.logT3Move(nd, move);
  } else {
    await nd.machine.command(formatT3(mov));
    await sleepAfterMove(nd, moveTime);
  }
  nd.addDist(moveDist);
  commitPosition(nd, pos);
}

async function feedTd(nd: NextDraw, move: Move): Promise<void> {
  const mov = move[1] as TDParams;
  const [moveDist, pos] = move[2] as [number, PenPosition];
  const moveTime = (2 * mov[0]) / 25.0;
  if (nd.options.preview) {
    nd.plot_status.stats.pt_estimate += moveTime;
    nd.preview.logTdMove(nd, move);
  } else {
    await nd.machine.command(formatTD(mov));
    await sleepAfterMove(nd, moveTime);
  }
  nd.addDist(moveDist, true);
  commitPosition(nd, pos);
}

/**
 * page_layer_delay: wait between copies (betweenPages) or at a layer's
 * `+d` delay, in short steps so pauses stay responsive.
 */
export async function pageLayerDelay(
  nd: NextDraw,
  betweenPages = true,
  delayMs: number | null = null
): Promise<void> {
  if (nd.plot_status.stopped) return;
  if (betweenPages) {
    if (nd.plot_status.copies_to_plot === 0) return; // none after the last copy
    nd.plot_status.delay_between_copies = true;
    delayMs = nd.options.page_delay * 1000;
  }
  if (!delayMs) return;
  let sleepInterval = 100;
  let remaining = delayMs;
  while (remaining > 0) {
    if (nd.plot_status.stopped) break;
    if (remaining < 150) sleepInterval = remaining;
    if (betweenPages) nd.plot_status.stats.page_delays += sleepInterval;
    else nd.plot_status.stats.layer_delays += sleepInterval;
    if (nd.options.preview) {
      nd.plot_status.stats.pt_estimate += sleepInterval;
    } else {
      await nd.clock.sleep(sleepInterval);
      await nd.pauseCheck();
    }
    remaining -= sleepInterval;
  }
  nd.plot_status.delay_between_copies = false;
}
