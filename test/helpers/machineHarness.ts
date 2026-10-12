/**
 * Drives the machine-layer port against FakeEbbTransport with an oracle
 * case's options and fake settings, following the order of
 * NextDraw.effect (nextdraw.py) for the parts that touch the machine.
 */

import {
  createConfig,
  updateOptions,
  type Params,
} from "../../server/driver/config.ts";
import { EBBMotionWrap } from "../../server/driver/ebb/motion.ts";
import { VirtualClock } from "../../server/driver/ebb/transport.ts";
import {
  createMachineContext,
  disconnect,
  preparePlot,
  serialConnect,
  setupCommand,
  utilityCommand,
  type MachineContext,
  type PlannerHooks,
} from "../../server/driver/machine/index.ts";
import {
  FakeEbbTransport,
  fakePortProvider,
  type FakeEbbSettings,
} from "../sim/fakeEbb.ts";
import { loadGolden, type Golden } from "./fixtures.ts";

export interface Harness {
  golden: Golden;
  nd: MachineContext;
  fake: FakeEbbTransport;
  clock: VirtualClock;
  messages: string[];
}

/** Options as NextDraw.effect leaves them before any machine I/O. */
export function makeHarness(
  name: string,
  planner?: (h: Harness) => PlannerHooks
): Harness {
  const golden = loadGolden(name);
  const c = golden.case;
  const config = createConfig(c.params as Partial<Params>);
  Object.assign(config.options, c.options);
  updateOptions(config);
  const o = config.options;
  o.page_delay = Math.max(o.page_delay, 0);
  if (o.mode === "res_plot") o.copies = 1;
  if (o.mode === "setup") o.mode = o.setup_type;
  if (o.mode === "utility" && o.utility_cmd === "toggle") o.mode = "toggle";

  const clock = new VirtualClock();
  const fake = new FakeEbbTransport(clock, c.fake as FakeEbbSettings);
  const messages: string[] = [];
  const h = {} as Harness;
  const nd = createMachineContext({
    config,
    machine: new EBBMotionWrap(fakePortProvider(fake)),
    clock,
    message: (text) => messages.push(text),
    planner: planner
      ? { go_to_position: (...a) => planner(h).go_to_position(...a) }
      : undefined,
  });
  Object.assign(h, { golden, nd, fake, clock, messages });
  return h;
}

/** Messages split as the oracle records them (non-blank stdout lines). */
export function messageLines(messages: string[]): string[] {
  return messages.flatMap((m) => m.split(/\r\n|\r|\n/)).filter((l) => l.trim());
}

/**
 * Run the case's machine sequence. Plot modes stop after preparePlot (the
 * point where planned plot motion begins) unless preparation fails, in which
 * case the teardown nextdraw runs (servo_revert, disconnect) follows.
 * Returns "planned" when the planner would take over.
 */
export async function runCase(h: Harness): Promise<"done" | "planned"> {
  const { nd } = h;
  await serialConnect(nd, "nextdraw");
  if (nd.machine.err !== null) {
    nd.user_message_fun(`Error:\n\n${nd.machine.err}`);
    return "done";
  }
  const mode = nd.options.mode;
  if (["align", "toggle", "cycle", "find_home"].includes(mode)) {
    await setupCommand(nd);
    nd.warnings.report(false, nd.user_message_fun);
    return "done";
  }
  if (mode === "utility") {
    await utilityCommand(nd);
    nd.warnings.report(false, nd.user_message_fun);
    return "done";
  }
  if (await preparePlot(nd)) return "planned";
  await teardown(nd);
  return "done";
}

/** End of NextDraw.effect after a plot: revert the pen, close the port, report. */
export async function teardown(nd: MachineContext): Promise<void> {
  if (nd.machine.port !== null) {
    await nd.pen.servoRevert(nd);
    if (nd.machine.caller === "nextdraw") await disconnect(nd);
  }
  nd.warnings.report(false, nd.user_message_fun);
}

/**
 * Planner stub: go_to_position replays the golden's planned lines from the
 * current point up to the next precision_move_to (its first `QL,24`).
 * Boundary: these lines come from the oracle, not from the port.
 */
export function goldenPlanner(h: Harness): PlannerHooks {
  return {
    async go_to_position() {
      const cmds = h.golden.commands;
      let i = h.fake.log.length;
      while (i < cmds.length && cmds[i][1] !== "QL,24") {
        await h.nd.machine.command(cmds[i][1]);
        i++;
      }
    },
  };
}
