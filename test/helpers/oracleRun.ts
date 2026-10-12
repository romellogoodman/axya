/** Run an oracle case through the native driver against the fake EBB. */

import { readFileSync } from "node:fs";
import type { Options, Params } from "../../server/driver/config.ts";
import { VirtualClock } from "../../server/driver/ebb/transport.ts";
import { NextDraw } from "../../server/driver/run/nextdraw.ts";
import {
  FakeEbbTransport,
  fakePortProvider,
  type FakeEbbSettings,
} from "../sim/fakeEbb.ts";
import { fixtureUrl, loadGolden } from "./fixtures.ts";

function inputSvg(name: string): string | undefined {
  const svg = loadGolden(name).case.svg;
  if (typeof svg === "string")
    return readFileSync(fixtureUrl(`../../${svg}`), "utf8");
  if (svg) return loadGolden(svg.from).output_svg;
  return undefined;
}

export async function runOracleCase(name: string) {
  const golden = loadGolden(name);
  const c = golden.case;
  const clock = new VirtualClock();
  const fake = new FakeEbbTransport(clock, c.fake as FakeEbbSettings);
  const messages: string[] = [];
  const nd = new NextDraw({
    svg: inputSvg(name),
    params: c.params as Partial<Params>,
    options: c.options as Partial<Options>,
    ports: fakePortProvider(fake),
    clock,
    message: (t) => messages.push(t),
  });
  const result = await nd.run();
  return { golden, fake, messages, result, nd };
}
