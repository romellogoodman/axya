/*
 * Line-oriented I/O and time sources for the EBB layer.
 *
 * Not a port: these interfaces replace pyserial's blocking Serial object and
 * Python's time.sleep, which plotink/ebb3_serial.py and nextdrawcore use
 * directly. Everything above them is async so a real serial port, the fake
 * EBB, and scripted test transports are interchangeable.
 */

/** One open, line-oriented connection to an EBB. */
export interface Transport {
  /** Send one command; the transport appends the EBB's `\r` terminator. */
  writeLine(line: string): Promise<void>;
  /**
   * The next received line without its `\n` (a `\r` from legacy-syntax
   * `\r\n` endings may remain; callers strip). Resolves null when nothing
   * arrives within `timeoutMs`, like pyserial's readline() returning b"".
   */
  readLine(timeoutMs: number): Promise<string | null>;
  /** Discard received but unread data (pyserial reset_input_buffer). */
  flushInput(): Promise<void>;
  close(): Promise<void>;
}

/** A serial port as pyserial's comports() describes it: (device, description, hwid). */
export interface PortInfo {
  device: string;
  description: string;
  hwid: string;
}

/** Lists ports and opens one; the seam where tests substitute the fake EBB. */
export interface PortProvider {
  list(): Promise<PortInfo[]>;
  open(device: string): Promise<Transport>;
}

/** Milliseconds clock; sleep() replaces Python's time.sleep. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve(),
};

/**
 * Deterministic clock mirroring test/oracle/fake_ebb.py VirtualClock: time is
 * kept in seconds from the same epoch and advanced by ms / 1000, so the float
 * sums (and the recorded virtual_ms values) match the oracle's exactly.
 */
export class VirtualClock implements Clock {
  t: number;
  readonly start: number;

  constructor(start = 1_700_000_000.0) {
    this.t = start;
    this.start = start;
  }

  now(): number {
    return (this.t - this.start) * 1000.0;
  }

  async sleep(ms: number): Promise<void> {
    const seconds = ms / 1000;
    if (seconds > 0) this.t += seconds;
  }
}
