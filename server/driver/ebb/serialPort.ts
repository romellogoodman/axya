/*
 * Transport and port discovery on the `serialport` npm package.
 *
 * Not a port of nextdraw code. It stands in for pyserial: `list()` reshapes
 * SerialPort.list() into pyserial's (device, description, hwid) triples so
 * ebb3.ts can keep plotink's matching rules, and `SerialPortTransport`
 * provides pyserial-style readline (split on `\n`, timeout returns nothing).
 *
 * serialport does not report the USB product string, which is what pyserial
 * puts in `description` ("EiBotBoard"). The description is therefore built
 * from the manufacturer string and only says "EiBotBoard" if that does;
 * EBBs are found by the VID:PID pass instead. The EBB reports its nickname
 * as the USB serial number, which appears as `SER=` in the hwid, so plotink's
 * nickname lookup still works.
 */

import { SerialPort } from "serialport";
import type { PortInfo, PortProvider, Transport } from "./transport.ts";

export const EBB_VID = "04D8";
export const EBB_PID = "FD92";

interface RawPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  locationId?: string;
  vendorId?: string;
  productId?: string;
}

const hex4 = (s: string | undefined) =>
  (s ?? "").replace(/^0x/i, "").toUpperCase().padStart(4, "0");

/** A SerialPort.list() entry in pyserial's comports() shape. */
export function toPortInfo(raw: RawPortInfo): PortInfo {
  const manufacturer = raw.manufacturer ?? "";
  let hwid = "n/a";
  if (raw.vendorId && raw.productId) {
    hwid = `USB VID:PID=${hex4(raw.vendorId)}:${hex4(raw.productId)}`;
    if (raw.serialNumber) hwid += ` SER=${raw.serialNumber}`;
    if (raw.locationId) hwid += ` LOCATION=${raw.locationId}`;
  }
  // Start the description at "EiBotBoard" if the manufacturer string has it.
  const at = manufacturer.indexOf("EiBotBoard");
  const description = at >= 0 ? manufacturer.slice(at) : manufacturer || "n/a";
  return { device: raw.path, description, hwid };
}

/** pyserial-like line reader over a SerialPort. */
export class SerialPortTransport implements Transport {
  private port: SerialPort;
  private buffer = "";
  private lines: string[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  constructor(port: SerialPort) {
    this.port = port;
    port.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("latin1");
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        this.lines.push(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.wake();
    });
    port.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async open(path: string): Promise<SerialPortTransport> {
    // Baud rate is irrelevant for USB CDC; pyserial's default is 9600 too.
    const port = new SerialPort({ path, baudRate: 9600, autoOpen: false });
    await new Promise<void>((resolve, reject) =>
      port.open((err) => (err ? reject(err) : resolve()))
    );
    return new SerialPortTransport(port);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async writeLine(line: string): Promise<void> {
    if (this.closed) throw new Error("port closed");
    await new Promise<void>((resolve, reject) => {
      this.port.write(line + "\r", "ascii", (err) => {
        if (err) reject(err);
      });
      this.port.drain((err) => (err ? reject(err) : resolve()));
    });
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.closed) throw new Error("port closed");
      const left = deadline - Date.now();
      if (left <= 0) return null; // a partial line stays buffered (pyserial would return it)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.lines.shift() as string;
  }

  async flushInput(): Promise<void> {
    await new Promise<void>((resolve) => this.port.flush(() => resolve()));
    this.buffer = "";
    this.lines = [];
  }

  async close(): Promise<void> {
    if (this.closed || !this.port.isOpen) {
      this.closed = true;
      return;
    }
    await new Promise<void>((resolve, reject) =>
      this.port.close((err) => (err ? reject(err) : resolve()))
    );
    this.closed = true;
  }
}

/** Real ports: SerialPort.list() for discovery, SerialPortTransport to open. */
export const serialPortProvider: PortProvider = {
  async list() {
    const raw = await SerialPort.list();
    return raw.map((p) => toPortInfo(p));
  },
  open: (device) => SerialPortTransport.open(device),
};
