/*
 * EiBotBoard (firmware 3.x) serial connection: discovery, handshake, command
 * and query framing, RAM variables.
 *
 * Ported from plotink/ebb3_serial.py 0.2.3 (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/plotink/ebb3_serial.py.
 * Copyright (c) 2026 Windell H. Oskay, Bantam Tools. MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Timeouts: Python opens the port with a 1 s read timeout and, after each
 * command, re-reads up to 25 more times while the reply is empty, so a reply
 * may take ~26 s (the EBB withholds replies while its motion FIFO is full).
 * Here every read waits READ_TIMEOUT_MS and the same 25 re-reads follow; a
 * blank line counts as empty, exactly as pyserial's strip()ped readline did.
 * Nothing is ever re-sent. Requests are serialized: one line in flight.
 */

import type { PortInfo, PortProvider, Transport } from "./transport.ts";

export const READ_TIMEOUT_MS = 1000;
export const READ_RETRIES = 25;

/** pyserial readline().decode('ascii', errors='replace').strip() */
function clean(line: string | null): string {
  if (line === null) return "";
  return line.replace(/[\u0080-\uffff]/g, "\ufffd").trim();
}

/** Command name used to validate the reply's echo prefix (ebb3_serial.py:303-308). */
function commandName(cmd: string): string {
  if (cmd.length === 1) return cmd[0];
  if (cmd[1] === ",") return cmd[0];
  return cmd.slice(0, 2);
}

/** Parsed PEP 440 release version (the subset EBB firmware strings use). */
export interface ParsedVersion {
  release: number[];
  pre: [number, number] | null; // [a=0|b=1|rc=2, n]
}

/** packaging.version.parse for N(.N)*[a|b|rcN]; throws like InvalidVersion otherwise. */
export function parseVersion(s: string): ParsedVersion {
  const m =
    /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?$/i.exec(
      s.trim()
    );
  if (!m) throw new RangeError(`Invalid version: '${s}'`);
  const release = m[1].split(".").map(Number);
  let pre: [number, number] | null = null;
  if (m[2]) {
    const tag = m[2].toLowerCase();
    const kind = tag.startsWith("a") ? 0 : tag.startsWith("b") ? 1 : 2;
    pre = [kind, m[3] ? Number(m[3]) : 0];
  }
  return { release, pre };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const n = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < n; i++) {
    const d = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (a.pre === null || b.pre === null) {
    return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  }
  return Math.sign(a.pre[0] - b.pre[0] || a.pre[1] - b.pre[1]);
}

/** EBB3: one EiBotBoard connection (ebb3_serial.py:47). */
export class EBB3 {
  static readonly MIN_VERSION_STRING = "3.0.2";

  port_name: string | null = null;
  port: Transport | null = null;
  version: string | null = null;
  version_parsed: ParsedVersion | null = null;
  name: string | null = null;
  err: string | null = null; // first fatal error; latches every later call to a no-op
  caller: string | null = null;

  readonly ports: PortProvider;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ports: PortProvider) {
    this.ports = ports;
  }

  /** Run `fn` after every earlier request has finished: one request in flight. */
  protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async findFirst(): Promise<void> {
    let list: PortInfo[];
    try {
      list = await this.ports.list();
    } catch {
      return;
    }
    let ebbPort: string | null = null;
    for (const port of list) {
      if (port.description.startsWith("EiBotBoard")) {
        ebbPort = port.device;
        break;
      }
    }
    if (ebbPort === null) {
      for (const port of list) {
        if (port.hwid.startsWith("USB VID:PID=04D8:FD92")) {
          ebbPort = port.device;
          break;
        }
      }
    }
    this.port_name = ebbPort;
  }

  reboot(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.port === null || this.err !== null) return false;
      try {
        await this.port.writeLine("RB");
        await this.disconnectNow();
        return true;
      } catch {
        return false;
      }
    });
  }

  bootload(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.port === null || this.err !== null) return false;
      try {
        await this.port.writeLine("BL");
        await this.disconnectNow();
        return true;
      } catch {
        return false;
      }
    });
  }

  recordError(message: string): void {
    if (this.err === null) this.err = message;
  }

  private async getPortName(givenName: string | null): Promise<void> {
    if (givenName === null) {
      await this.findFirst();
      if (this.port_name === null)
        this.recordError("Unable to locate device on USB");
    } else {
      this.port_name = await findNamed(this.ports, givenName);
      if (this.port_name === null)
        this.recordError(`Unable to locate ${givenName} on USB`);
    }
  }

  parseVersion(ebbVersionString: string): void {
    const i = ebbVersionString.indexOf("Firmware Version ");
    if (i < 0) return;
    const v = ebbVersionString.slice(i + "Firmware Version ".length).trim();
    this.version = v;
    // nextdraw quirk: packaging's InvalidVersion is not caught here
    // (ebb3_serial.py:151), so an unparsable version throws out of connect().
    this.version_parsed = parseVersion(v);
  }

  async queryNickname(): Promise<void> {
    if (this.port === null || this.err !== null) return;
    const raw = await this.query("QT");
    if (raw !== null) {
      // Python's "".isspace() is False, so an empty reply sets name to "".
      if (!(raw.length > 0 && raw.trim() === "")) this.name = raw.trim();
    }
  }

  async writeNickname(nickname: string | null): Promise<boolean> {
    if (this.port === null || this.err !== null || nickname === null)
      return false;
    nickname = nickname.trim();
    await this.command("ST," + nickname);
    this.name = nickname;
    return true;
  }

  private async disconnectNow(): Promise<void> {
    if (this.port !== null) {
      try {
        await this.port.close();
      } catch {
        // err on the side of trying to close the port
      }
    }
    this.port = null;
  }

  disconnect(): Promise<void> {
    return this.exclusive(() => this.disconnectNow());
  }

  /**
   * Open and verify an EBB (ebb3_serial.py:195-269): `v` handshake with one
   * retry, firmware >= 3.0.2, switch to future syntax with `CU,10,1`, read
   * the nickname with `QT`.
   */
  async connect(
    givenName: string | null = null,
    caller: string | null = null
  ): Promise<boolean> {
    if (this.port !== null) return true;
    await this.getPortName(givenName);
    if (this.port_name === null) return false;

    const verified = await this.exclusive(async () => {
      let ok = false;
      let strVersion = "";
      try {
        this.port = await this.ports.open(this.port_name as string);
        await this.port.flushInput();
        await this.port.writeLine("v");
        strVersion = clean(await this.port.readLine(READ_TIMEOUT_MS));
        if (strVersion && strVersion.includes("EBB")) ok = true;
        if (!ok) {
          await this.port.writeLine("v");
          strVersion = clean(await this.port.readLine(READ_TIMEOUT_MS));
          if (strVersion && strVersion.includes("EBB")) ok = true;
        }
      } catch {
        this.recordError(
          `Error testing USB connection (port name: ${this.port_name})`
        );
        await this.disconnectNow();
      }
      if (!ok) {
        this.recordError(
          `Failed to connect via USB (port name: ${this.port_name})`
        );
        await this.disconnectNow();
        return false;
      }
      this.parseVersion(strVersion);
      return true;
    });
    if (!verified) return false;

    if (!this.minVersion(EBB3.MIN_VERSION_STRING)) {
      // nextdraw quirk: the port is left open here (ebb3_serial.py:254-259);
      // the latched error turns every later command into a no-op.
      this.recordError(
        `Firmware version (${this.version ?? "None"}) not supported.\n` +
          `Firmware ${EBB3.MIN_VERSION_STRING} or newer is required.\n` +
          "Visit https://bantam.tools/ndfw to update your firmware."
      );
      return false;
    }

    await this.exclusive(async () => {
      const port = this.port as Transport;
      await port.writeLine("CU,10,1");
      await port.readLine(READ_TIMEOUT_MS); // legacy or future reply; ignored
      await port.flushInput();
    });

    await this.queryNickname();
    if (caller !== null) this.caller = caller;
    return true;
  }

  /** True if firmware >= versionString; null when either is unparsable. */
  minVersion(versionString: string): boolean | null {
    if (this.version_parsed === null) return null;
    let wanted: ParsedVersion;
    try {
      wanted = parseVersion(versionString);
    } catch {
      return null;
    }
    return compareVersions(this.version_parsed, wanted) >= 0;
  }

  /** Write then read, re-reading up to READ_RETRIES times while the reply is empty. */
  private async exchange(port: Transport, line: string): Promise<string> {
    await port.writeLine(line);
    let response = clean(await port.readLine(READ_TIMEOUT_MS));
    let retries = 0;
    while (response.length === 0 && retries < READ_RETRIES) {
      response = clean(await port.readLine(READ_TIMEOUT_MS));
      retries += 1;
    }
    return response;
  }

  /** Send a command; true on apparent success (ebb3_serial.py:290-338). */
  command(cmd: string | null): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.port === null || this.err !== null || cmd === null) return false;
      cmd = cmd.trim();
      const cmdName = commandName(cmd);
      let response = "";
      try {
        response = await this.exchange(this.port, cmd);
        if (!response.startsWith(cmdName)) {
          this.recordError(
            response
              ? "\nUnexpected response from EBB." +
                  `    Command: ${cmd}\n    Response: ${response}`
              : `EBB Serial Timeout after command: ${cmd}`
          );
        }
      } catch {
        if (!["rb", "r", "bl"].includes(cmdName.toLowerCase())) {
          this.recordError(`USB communication error after command: ${cmd}`);
        }
      }
      if (response.includes("Err:")) {
        this.recordError(
          "Error reported by EBB.\n" +
            `    Command: ${cmd}\n    Response: ${response}`
        );
      }
      return this.err === null;
    });
  }

  /** Send a query; the reply with its `XX,` echo stripped, or null (ebb3_serial.py:341-396). */
  query(qry: string | null): Promise<string | null> {
    return this.exclusive(async () => {
      if (this.port === null || this.err !== null || qry === null) return null;
      qry = qry.trim();
      const qryName = commandName(qry);
      let response = "";
      try {
        response = await this.exchange(this.port, qry);
      } catch {
        if (!["rb", "r", "bl"].includes(qryName.toLowerCase())) {
          this.recordError(`USB communication error after query: ${qry}`);
          return null;
        }
      }
      if (response.includes("Err:") || !response.startsWith(qryName)) {
        this.recordError(
          response
            ? "\nUnexpected response from EBB." +
                `    Query: ${qry}\n    Response: ${response}`
            : `EBB Serial Timeout after query: ${qry}`
        );
        return null;
      }
      let headerLen = qryName.length;
      if (response.length > headerLen && response[headerLen] === ",")
        headerLen += 1;
      return response.slice(headerLen);
    });
  }

  /** `QG` status byte as an int; one read, no retries (ebb3_serial.py:399-434). */
  queryStatusbyte(): Promise<number | null> {
    return this.exclusive(async () => {
      if (this.port === null || this.err !== null) return null;
      let response: string;
      try {
        await this.port.writeLine("QG");
        response = clean(await this.port.readLine(READ_TIMEOUT_MS));
        if (!response.startsWith("QG")) {
          this.recordError(
            response
              ? "\nUnexpected response from EBB." +
                  `    Response to QG query: ${response}`
              : "EBB Serial Timeout while reading status byte."
          );
        }
      } catch {
        this.recordError("USB communication error after status byte query");
        return null;
      }
      if (response.includes("Err:")) {
        this.recordError(
          "Error reported by EBB.\n" +
            `    Query: QG\n    Response: ${response}`
        );
        return null;
      }
      // int(response[3:], 16)
      const hex = response.slice(3).trim();
      if (!/^[+-]?(0x)?[0-9a-f]+(_[0-9a-f]+)*$/i.test(hex)) return null;
      return parseInt(hex.replace(/_/g, ""), 16);
    });
  }

  async varWrite(value: number, index: number): Promise<boolean> {
    if (this.port === null || this.err !== null) return false;
    await this.command(`SL,${value},${index}`);
    return this.err === null;
  }

  async varRead(index: number): Promise<number | null> {
    if (this.port === null || this.err !== null) return null;
    const value = await this.query(`QL,${index}`);
    if (this.err !== null || value === null) return null;
    return pyIntStrict(value);
  }

  /** Signed 32-bit value as four big-endian bytes in slots start..start+3. */
  async varWriteInt32(value: number, startIndex: number): Promise<boolean> {
    if (this.port === null || this.err !== null) return false;
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
      throw new RangeError("int too big to convert"); // int.to_bytes OverflowError
    const u = value >>> 0;
    for (const byte of [
      u >>> 24,
      (u >>> 16) & 0xff,
      (u >>> 8) & 0xff,
      u & 0xff,
    ]) {
      await this.varWrite(byte, startIndex);
      startIndex += 1;
    }
    return this.err === null;
  }

  async varReadInt32(startIndex: number): Promise<number | false | null> {
    // nextdraw quirk: returns False (not None) when not connected
    // (ebb3_serial.py:516-517).
    if (this.port === null || this.err !== null) return false;
    const bytes: (number | null)[] = [];
    for (let offset = 0; offset < 4; offset++) {
      bytes.push(await this.varRead(startIndex + offset));
    }
    if (this.err !== null) return null;
    const [b0, b1, b2, b3] = bytes as number[];
    return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3 | 0;
  }
}

/** Python int(str) on a reply; throws like ValueError on garbage. */
function pyIntStrict(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t))
    throw new RangeError(`invalid literal for int() with base 10: '${s}'`);
  return Number(t);
}

/** Every EBB port, or null if none (ebb3_serial.py:531-549). */
export async function listEbbPorts(
  ports: PortProvider
): Promise<PortInfo[] | null> {
  let list: PortInfo[];
  try {
    list = await ports.list();
  } catch {
    return null;
  }
  const found = list.filter(
    (p) =>
      p.description.startsWith("EiBotBoard") ||
      p.hwid.startsWith("USB VID:PID=04D8:FD92")
  );
  return found.length ? found : null;
}

/** Nickname (or port) for each EBB (ebb3_serial.py:552-583). */
export async function listNamedEbbs(
  ports: PortProvider
): Promise<string[] | null> {
  const list = await listEbbPorts(ports);
  if (!list) return null;
  const names: string[] = [];
  for (const { device, description, hwid } of list) {
    let found = false;
    if (description.startsWith("EiBotBoard")) {
      const temp = description.slice(11);
      if (temp) {
        names.push(temp);
        found = true;
      }
    }
    if (!found && hwid.includes("SER=") && hwid.includes(" LOCAT")) {
      const i1 = hwid.indexOf("SER=") + 4;
      const i2 = hwid.indexOf(" LOCAT", i1);
      // Python slicing with find() == -1 means "up to the last character"
      const temp = hwid.slice(i1, i2 < 0 ? -1 : i2);
      if (temp.length >= 3) {
        names.push(temp);
        found = true;
      }
    }
    if (!found) names.push(device);
  }
  return names;
}

/** Port of the EBB with this port name or nickname, case-insensitive (ebb3_serial.py:586-626). */
export async function findNamed(
  ports: PortProvider,
  portName: string | null
): Promise<string | null> {
  if (portName === null) return null;
  const needle = ("SER=" + portName).toLowerCase();
  const needle2 = ("(" + portName + ")").toLowerCase();
  const plower = portName.toLowerCase();
  let list: PortInfo[];
  try {
    list = await ports.list();
  } catch {
    return null;
  }
  for (const port of list) {
    const p0 = port.device.toLowerCase();
    let p1 = port.description.toLowerCase();
    const p2 = port.hwid.toLowerCase();
    if (p2.includes(needle) || p1.includes(needle2)) return port.device;
    p1 = p1.slice(11);
    if (p1.startsWith(plower) || p0.startsWith(plower)) return port.device;
    // nextdraw quirk: ebb3_serial.py:623 discards needle.replace(" ", "_"),
    // so the Windows underscore fallback repeats the first check unchanged.
    if (p2.includes(needle)) return port.device;
  }
  return null;
}
