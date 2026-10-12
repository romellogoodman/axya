/** Loaders for oracle fixtures (see test/oracle/README.md). */

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const FIXTURES = new URL("../fixtures/", import.meta.url);

export interface OracleCase {
  svg?: string | { from: string };
  options: Record<string, unknown>;
  params: Record<string, unknown>;
  fake: Record<string, unknown>;
}

export interface Golden {
  commands: [number, string][];
  messages: string[];
  status_code: number;
  final_steps: [number, number];
  final_ram: number[];
  stats?: Record<string, number>;
  output_svg?: string;
  case: OracleCase;
}

export type DigestSnapshot = {
  width: number;
  height: number;
  flat: boolean;
  layers: {
    name: string;
    item_id: string;
    props: Record<string, unknown>;
    paths: {
      item_id: string;
      stroke: string | null;
      fill: string | null;
      fill_rule: string | null;
      subpaths: [number, number][][];
    }[];
  }[];
};

export interface PlannerCall {
  fn: "trajectory" | "compute_segment";
  in: unknown;
  start: Record<string, number | boolean | null>;
  end: Record<string, number | boolean | null>;
  out: unknown[] | null;
  extra: unknown;
}

export interface Stages {
  options: Record<string, unknown>;
  params: Record<string, unknown>;
  bounds: [[number, number], [number, number]];
  digest?: [string, DigestSnapshot][];
  planner?: PlannerCall[];
}

export function caseNames(): string[] {
  return readdirSync(new URL("golden/", FIXTURES))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadGolden(name: string): Golden {
  return JSON.parse(
    readFileSync(new URL(`golden/${name}.json`, FIXTURES), "utf8")
  );
}

export function stageNames(): string[] {
  return readdirSync(new URL("stages/", FIXTURES))
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.slice(0, -8))
    .sort();
}

export function loadStages(name: string): Stages {
  const raw = readFileSync(new URL(`stages/${name}.json.gz`, FIXTURES));
  return JSON.parse(gunzipSync(raw).toString("utf8"));
}

export function fixtureUrl(path: string): URL {
  return new URL(path, FIXTURES);
}
