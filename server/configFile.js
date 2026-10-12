/**
 * Read db/nextdraw.conf.py, the nextdraw-format config file the Configure
 * modal edits. Lines are `key = value` with Python literals; only booleans,
 * numbers and quoted strings are understood.
 */

import fs from "node:fs";

export function readConfigFile(configPath) {
  const text = fs.readFileSync(configPath, "utf8");
  const config = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === "True") config[key] = true;
    else if (raw === "False") config[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) config[key] = Number(raw);
    else config[key] = raw.replace(/^["']|["']$/g, "");
  }
  return config;
}
