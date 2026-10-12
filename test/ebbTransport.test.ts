import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EBB3,
  EBBMotionWrap,
  READ_RETRIES,
  READ_TIMEOUT_MS,
  VirtualClock,
  findNamed,
  listNamedEbbs,
  type PortInfo,
  type PortProvider,
  type Transport,
} from "../server/driver/ebb/index.ts";
import { toPortInfo } from "../server/driver/ebb/serialPort.ts";

/**
 * Scripted transport: each written line pops the next scripted reply list.
 * A reply of null is a read timeout (and advances the virtual clock by the
 * read's timeout, as a real 1 s pyserial timeout would).
 */
class ScriptedTransport implements Transport {
  written: string[] = [];
  rx: (string | null)[] = [];
  script: (string | null)[][];
  clock = new VirtualClock();
  failWrites = false;
  closed = false;

  constructor(script: (string | null)[][]) {
    this.script = script;
  }

  async writeLine(line: string): Promise<void> {
    if (this.failWrites) throw new Error("EIO");
    this.written.push(line);
    this.rx.push(...(this.script.shift() ?? []));
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    const next = this.rx.length ? this.rx.shift()! : null;
    if (next === null) await this.clock.sleep(timeoutMs);
    return next;
  }

  async flushInput(): Promise<void> {
    this.rx = [];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const EBB_PORT: PortInfo = {
  device: "/dev/cu.usbmodem1",
  description: "EiBotBoard",
  hwid: "USB VID:PID=04D8:FD92",
};

function provider(t: Transport, ports: PortInfo[] = [EBB_PORT]): PortProvider {
  return { list: async () => ports, open: async () => t };
}

/** An EBB connected over `script` (after the handshake replies). */
async function connected(script: (string | null)[][]) {
  const t = new ScriptedTransport([
    ["EBBv13_and_above EB Firmware Version 3.1.7\r"],
    [""], // CU,10,1: bare newline
    ["QT,"],
    ...script,
  ]);
  const ebb = new EBBMotionWrap(provider(t));
  assert.equal(await ebb.connect(), true);
  t.written = [];
  return { ebb, t };
}

test("handshake: v, CU,10,1 (bare newline ignored), QT", async () => {
  const t = new ScriptedTransport([
    ["EBBv13_and_above EB Firmware Version 3.1.7\r"],
    [""],
    ["QT,MyBot"],
  ]);
  const ebb = new EBB3(provider(t));
  assert.equal(await ebb.connect(null, "nextdraw"), true);
  assert.deepEqual(t.written, ["v", "CU,10,1", "QT"]);
  assert.equal(ebb.version, "3.1.7");
  assert.equal(ebb.name, "MyBot");
  assert.equal(ebb.caller, "nextdraw");
  assert.equal(ebb.port_name, "/dev/cu.usbmodem1");
});

test("handshake retries v once and accepts a future-syntax V reply", async () => {
  const t = new ScriptedTransport([
    [null],
    ["V,EBBv13_and_above EB Firmware Version 3.0.2"],
    ["CUOK\r"],
    ["QT,"],
  ]);
  const ebb = new EBB3(provider(t));
  assert.equal(await ebb.connect(), true);
  assert.deepEqual(t.written, ["v", "v", "CU,10,1", "QT"]);
  assert.equal(ebb.name, "");
});

test("handshake rejects firmware older than 3.0.2 and latches the error", async () => {
  const t = new ScriptedTransport([
    ["EBBv13_and_above EB Firmware Version 2.8.1\r"],
  ]);
  const ebb = new EBB3(provider(t));
  assert.equal(await ebb.connect(), false);
  assert.match(ebb.err ?? "", /^Firmware version \(2\.8\.1\) not supported\./);
  assert.equal(await ebb.command("CU,3,1"), false);
  assert.deepEqual(t.written, ["v"]);
});

test("handshake fails when nothing answers like an EBB", async () => {
  const t = new ScriptedTransport([["hello"], [null]]);
  const ebb = new EBB3(provider(t));
  assert.equal(await ebb.connect(), false);
  assert.equal(
    ebb.err,
    "Failed to connect via USB (port name: /dev/cu.usbmodem1)"
  );
  assert.equal(t.closed, true);
  assert.equal(ebb.port, null);
});

test("no EBB on USB", async () => {
  const ebb = new EBB3(provider(new ScriptedTransport([]), []));
  assert.equal(await ebb.connect(), false);
  assert.equal(ebb.err, "Unable to locate device on USB");
  const named = new EBB3(provider(new ScriptedTransport([]), []));
  assert.equal(await named.connect("plotter2"), false);
  assert.equal(named.err, "Unable to locate plotter2 on USB");
});

test("command: future-syntax echo accepted, prefix by command name", async () => {
  const { ebb, t } = await connected([["SM"], ["T3"], ["R"], ["SC"]]);
  assert.equal(await ebb.command("SM,100,0,0"), true);
  assert.equal(await ebb.command(" T3,1,0,0,0,0,0,0,3 "), true);
  assert.equal(await ebb.command("R"), true); // one-letter command
  assert.equal(await ebb.command("SC,4,9720"), true);
  assert.deepEqual(t.written, [
    "SM,100,0,0",
    "T3,1,0,0,0,0,0,0,3",
    "R",
    "SC,4,9720",
  ]);
  assert.equal(ebb.err, null);
});

test("command: legacy OK reply is an unexpected response", async () => {
  const { ebb } = await connected([["OK\r"]]);
  assert.equal(await ebb.command("SP,1"), false);
  assert.equal(
    ebb.err,
    "\nUnexpected response from EBB.    Command: SP,1\n    Response: OK"
  );
});

test("command: Err: reply is latched and later calls are no-ops", async () => {
  const { ebb, t } = await connected([
    ["SM,!4 Err: Missing parameter(s)"],
    ["SM"],
  ]);
  assert.equal(await ebb.command("SM,100"), false);
  assert.equal(
    ebb.err,
    "Error reported by EBB.\n    Command: SM,100\n    Response: SM,!4 Err: Missing parameter(s)"
  );
  assert.equal(await ebb.command("SM,100,0,0"), false);
  assert.equal(await ebb.query("QS"), null);
  assert.equal(await ebb.queryStatusbyte(), null);
  assert.equal(await ebb.varRead(12), null);
  assert.deepEqual(t.written, ["SM,100"]);
});

test("command: empty replies are re-read 25 times (~26 s) before a timeout", async () => {
  const { ebb, t } = await connected([[null, "", null, "SM"]]);
  assert.equal(await ebb.command("SM,5000,0,0"), true);
  assert.equal(t.clock.now(), 2 * READ_TIMEOUT_MS); // two timeouts; the blank line is instant

  const { ebb: ebb2, t: t2 } = await connected([[]]);
  const start = t2.clock.now();
  assert.equal(await ebb2.command("SM,5000,0,0"), false);
  assert.equal(ebb2.err, "EBB Serial Timeout after command: SM,5000,0,0");
  assert.equal(t2.clock.now() - start, (1 + READ_RETRIES) * READ_TIMEOUT_MS);
  assert.deepEqual(t2.written, ["SM,5000,0,0"]); // never re-sent
});

test("command: write failure records a USB error except after RB/R/BL", async () => {
  const { ebb, t } = await connected([]);
  t.failWrites = true;
  assert.equal(await ebb.command("R"), true);
  assert.equal(ebb.err, null);
  assert.equal(await ebb.command("SC,4,1"), false);
  assert.equal(ebb.err, "USB communication error after command: SC,4,1");
});

test("query: strips the echo; data and empty replies", async () => {
  const { ebb } = await connected([
    ["QL,162"],
    ["QS,-800,800\n"],
    ["QT,"],
    ["PI,1"],
  ]);
  assert.equal(await ebb.query("QL,10"), "162");
  assert.equal(await ebb.query("QS"), "-800,800");
  assert.equal(await ebb.query("QT"), "");
  assert.equal(await ebb.query("PI,B,1"), "1");
});

test("query: mismatched echo, Err:, and timeout return null and latch", async () => {
  const a = await connected([["QE,16,16"]]);
  assert.equal(await a.ebb.query("QS"), null);
  assert.equal(
    a.ebb.err,
    "\nUnexpected response from EBB.    Query: QS\n    Response: QE,16,16"
  );
  const b = await connected([["QL,!6 Err: Invalid parameter value"]]);
  assert.equal(await b.ebb.query("QL,99"), null);
  assert.match(b.ebb.err ?? "", /Query: QL,99\n {4}Response: QL,!6 Err:/);
  const c = await connected([[]]);
  assert.equal(await c.ebb.query("QS"), null);
  assert.equal(c.ebb.err, "EBB Serial Timeout after query: QS");
});

test("queryStatusbyte: hex parse, single read without retries", async () => {
  const { ebb, t } = await connected([["QG,3E"], ["QG,"]]);
  assert.equal(await ebb.queryStatusbyte(), 0x3e);
  assert.equal(await ebb.queryStatusbyte(), null); // unparsable, not latched
  assert.equal(ebb.err, null);
  const before = t.clock.now();
  assert.equal(await ebb.queryStatusbyte(), null);
  assert.equal(t.clock.now() - before, READ_TIMEOUT_MS);
  assert.equal(ebb.err, "EBB Serial Timeout while reading status byte.");
});

test("requests are serialized: one line in flight, in order", async () => {
  const { ebb, t } = await connected([["SC"], ["QL,7"], ["SP"]]);
  const order: string[] = [];
  const inFlight: number[] = [];
  let pending = 0;
  const orig = t.writeLine.bind(t);
  t.writeLine = async (line) => {
    pending++;
    inFlight.push(pending);
    await orig(line);
  };
  const origRead = t.readLine.bind(t);
  t.readLine = async (ms) => {
    await new Promise((r) => setTimeout(r, 1));
    const line = await origRead(ms);
    pending--;
    return line;
  };
  await Promise.all([
    ebb.command("SC,4,1").then(() => order.push("SC")),
    ebb.query("QL,3").then((v) => order.push(`QL=${v}`)),
    ebb.command("SP,1").then(() => order.push("SP")),
  ]);
  assert.deepEqual(order, ["SC", "QL=7", "SP"]);
  assert.deepEqual(inFlight, [1, 1, 1]);
});

test("var_write_int32 / var_read_int32 big-endian two's complement", async () => {
  const { ebb, t } = await connected([
    ["SL"],
    ["SL"],
    ["SL"],
    ["SL"],
    ["QL,255"],
    ["QL,243"],
    ["QL,203"],
    ["QL,0"],
  ]);
  assert.equal(await ebb.varWriteInt32(-800000, 24), true);
  assert.deepEqual(t.written, [
    "SL,255,24",
    "SL,243,25",
    "SL,203,26",
    "SL,0,27",
  ]);
  assert.equal(await ebb.varReadInt32(24), -800000);
});

test("motor and pen wrappers format commands as plotink does", async () => {
  const { ebb, t } = await connected([
    ["CU"],
    ["QE,0,16"],
    ["EM"],
    ["EM"],
    ["SM"],
    ["SM"],
    ["SM"],
    ["HM"],
    ["SP"],
    ["SP"],
  ]);
  await ebb.motorsEnable(0, 2); // only motor 2: CU,50,0, QE, set resolution, EM
  await ebb.timedPause(1600);
  await ebb.absMove(3000, -800, 800);
  await ebb.penRaise(45, 2);
  await ebb.penLower(47, 0); // pin 0 is falsy in Python too
  assert.deepEqual(t.written, [
    "CU,50,0",
    "QE",
    "EM,2,2",
    "EM,0,2",
    "SM,750,0,0",
    "SM,750,0,0",
    "SM,100,0,0",
    "HM,3000,-800,800",
    "SP,1,45,2",
    "SP,0,47",
  ]);
});

test("find_named: SER= nickname, description suffix, port prefix", async () => {
  const ports: PortInfo[] = [
    {
      device: "COM3",
      description: "Other device",
      hwid: "USB VID:PID=1234:5678",
    },
    {
      device: "/dev/cu.usbmodem2",
      description: "EiBotBoard,Lefty",
      hwid: "USB VID:PID=04D8:FD92",
    },
    {
      device: "COM4",
      description: "USB Serial (COM4)",
      hwid: "USB VID:PID=04D8:FD92 SER=RIGHTY LOCATION=1-1",
    },
  ];
  const p = provider(new ScriptedTransport([]), ports);
  assert.equal(await findNamed(p, "righty"), "COM4");
  assert.equal(await findNamed(p, "lefty"), "/dev/cu.usbmodem2");
  assert.equal(await findNamed(p, "com4"), "COM4"); // "(com4)" in description
  assert.equal(await findNamed(p, "/dev/cu.usb"), "/dev/cu.usbmodem2");
  // nextdraw quirk (ebb3_serial.py:623): no space -> underscore fallback.
  const spaced = provider(new ScriptedTransport([]), [
    {
      device: "COM9",
      description: "x",
      hwid: "USB VID:PID=04D8:FD92 SER=MY_BOT LOCATION=1",
    },
  ]);
  assert.equal(await findNamed(spaced, "My Bot"), null);
  assert.deepEqual(await listNamedEbbs(p), ["Lefty", "RIGHTY"]);
});

test("serialport PortInfo maps to pyserial's (device, description, hwid)", () => {
  assert.deepEqual(
    toPortInfo({
      path: "/dev/cu.usbmodem14101",
      manufacturer: "SchmalzHaus LLC",
      serialNumber: "Lefty",
      locationId: "14100000",
      vendorId: "04d8",
      productId: "fd92",
    }),
    {
      device: "/dev/cu.usbmodem14101",
      description: "SchmalzHaus LLC",
      hwid: "USB VID:PID=04D8:FD92 SER=Lefty LOCATION=14100000",
    }
  );
  assert.equal(
    toPortInfo({ path: "COM5", manufacturer: "Microsoft EiBotBoard" })
      .description,
    "EiBotBoard"
  );
});
