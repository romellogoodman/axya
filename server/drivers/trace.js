/**
 * Serial trace for hardware bring-up: wraps a PortProvider so every line
 * written to and read from the EBB is appended to a file with a timestamp.
 * Enabled by AXYA_EBB_TRACE=<path> (native driver only).
 */

import fs from "node:fs";

export function tracingProvider(ports, tracePath) {
  const write = (dir, line) =>
    fs.appendFileSync(
      tracePath,
      `${new Date().toISOString()} ${dir} ${line}\n`
    );
  return {
    list: () => ports.list(),
    async open(device) {
      write("--", `open ${device}`);
      const t = await ports.open(device);
      return {
        async writeLine(line) {
          write(">>", line);
          return t.writeLine(line);
        },
        async readLine(timeoutMs) {
          const line = await t.readLine(timeoutMs);
          write("<<", line === null ? "(timeout)" : JSON.stringify(line));
          return line;
        },
        flushInput: () => t.flushInput(),
        async close() {
          write("--", "close");
          return t.close();
        },
      };
    },
  };
}
