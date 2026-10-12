/*
 * EBB layer: serial transport, discovery, and EiBotBoard 3.x commands.
 *
 * Public API
 *
 *   Transport    { writeLine(line), readLine(timeoutMs) -> string | null,
 *                  flushInput(), close() }        one open line-oriented link
 *   PortProvider { list() -> PortInfo[], open(device) -> Transport }
 *   PortInfo     { device, description, hwid }   pyserial comports() shape
 *   Clock        { now() -> ms, sleep(ms) }       realClock, VirtualClock
 *
 *   EBB3 (ebb3.ts, plotink/ebb3_serial.py): connect(name?, caller?),
 *     command(cmd) -> boolean, query(qry) -> string | null,
 *     queryStatusbyte() -> number | null, varRead/varWrite(+Int32),
 *     reboot(), bootload(), writeNickname(), disconnect(); fields mirror
 *     Python: port, port_name, version, name, err, caller.
 *   EBBMotionWrap (motion.ts, plotink/ebb3_motion.py) extends EBB3 with
 *     xyMove, absMove, motorsEnable/Disable/QueryEnabled, querySteps,
 *     clearSteps, clearAccumulators, penRaise/Lower, penPosUp/Down,
 *     penRateUp/Down, servoTimeout, dioBConfig/Set/Read, timedPause,
 *     queryVoltage, queryCurrent.
 *   findNamed, listEbbPorts, listNamedEbbs: discovery helpers.
 *   SerialPortTransport, serialPortProvider (serialPort.ts): real hardware.
 *
 * Semantics kept from plotink: the first error is latched in `err` and every
 * later call is a no-op returning false/null; replies are validated by their
 * echo prefix and by "Err:"; each read waits 1 s and is retried 25 times
 * while empty (≈26 s worst case); nothing is ever re-sent. command/query/
 * queryStatusbyte are serialized so exactly one request is in flight.
 */

export * from "./transport.ts";
export * from "./ebb3.ts";
export * from "./motion.ts";
