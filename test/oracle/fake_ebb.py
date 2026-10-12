"""
Fake EiBotBoard for running Bantam's vendored nextdraw driver without hardware.

Stands in for pyserial's `Serial` object. It answers the queries nextdraw
makes with plausible EBB 3.x "future syntax" replies, tracks the state those
replies depend on (pen, motor enable, RAM variables, step position), and
records every line the driver writes. The recorded command stream is the
golden output the Node port is tested against.

Dev/test only; never shipped. See docs/DRIVER_PORT.md ("Verification").
"""

from plotink import ebb_calc

FIRMWARE_VERSION = "EBBv13_and_above EB Firmware Version 3.1.7"

# QE reply values (microstep multiplier) for each EM resolution code.
EM_TO_QE = {0: 0, 1: 16, 2: 8, 3: 4, 4: 2, 5: 1}


class FakeEBB:
    """Line-oriented fake of an EBB on firmware 3.x."""

    def __init__(self, clock, homed=True, motors_on=True, voltage=900,
                 pause_after_moves=None, start_x_mm=60.0, step_scale=2032):
        self.clock = clock
        self.future_syntax = False
        self.rx = []          # pending reply lines (bytes)
        self.log = []         # [virtual_ms, command] for every line written
        self.ram = [0] * 32   # SL/QL variables
        if homed:
            self.ram[12] = 1  # "already homed": skip limit-switch homing
            self.ram[13] = 1  # power OK
        self.voltage = voltage
        self.pen_up = True
        self.motors = (1, 1) if motors_on else (0, 0)  # EM codes
        self.steps = [0, 0]   # QS global step position
        self.accum = [0, 0]   # step accumulators (firmware-exact)
        self.moves = 0        # motion commands received
        self.pause_after_moves = pause_after_moves
        self.button = False
        # Limit switch model (NextDraw homing). The carriage's physical X, in
        # motor-step units, moves by half the sum of the enabled motors' steps
        # (CoreXY: x = (m1 + m2) / 2). The switch is pressed at x <= 0.
        self.x_phys = start_x_mm / 25.4 * step_scale
        self.limit_mask = 0
        self.limit_target = 0
        self.limit_triggered = False

    # --- pyserial surface used by plotink.ebb3_serial ---

    is_open = True

    def write(self, data):
        for line in data.decode("ascii").split("\r"):
            if line:
                self._handle(line)
        return len(data)

    def readline(self):
        return self.rx.pop(0) if self.rx else b""

    def reset_input_buffer(self):
        self.rx.clear()

    def flush(self):
        pass

    def close(self):
        self.is_open = False

    # --- protocol ---

    def _reply(self, text):
        end = "\n" if self.future_syntax else "\r\n"
        self.rx.append((text + end).encode("ascii"))

    def _handle(self, line):
        self.log.append([round(self.clock.now_ms(), 3), line])
        parts = line.split(",")
        name = parts[0].upper()
        args = parts[1:]

        if name == "V":
            self._reply(FIRMWARE_VERSION)
            return
        if name == "CU" and args[:2] == ["10", "1"]:
            self._reply("")  # firmware answers the mode switch with a bare newline
            self.future_syntax = True
            return

        handler = getattr(self, f"_q_{name}", None)
        if handler is not None:
            handler(args)
            return
        if name in ("SM", "T3", "TD", "HM", "LM", "LT", "L3", "XM"):
            self._motion(name, args)
        elif name == "SP":
            if args and args[0] in ("1", "3"):
                self.pen_up = True
            elif args and args[0] == "0":
                self.pen_up = False
        elif name == "EM":
            self.motors = (int(args[0]), int(args[1]) if len(args) > 1 else self.motors[1])
            self.steps = [0, 0]  # EM clears step counters, accumulators and limit trigger
            self.accum = [0, 0]
            self.limit_triggered = False
        elif name == "CS":
            self.steps = [0, 0]
            self.accum = [0, 0]
        elif name == "CU" and args[0] == "51":
            self.limit_mask = int(args[1])
            if self.limit_mask == 0:
                self.limit_triggered = False
        elif name == "CU" and args[0] == "52":
            self.limit_target = int(args[1])
        elif name == "SL":
            self.ram[int(args[1])] = int(args[0]) & 0xFF
        self._reply(name)  # future syntax: echo the command name

    # Queries (reply carries data)

    def _q_QG(self, _args):
        status = 0 if self.pen_up else 0x10  # bit 4: pen down; low nibble 0: idle
        if self.limit_triggered:
            status |= 0x80
        if self.button:
            status |= 0x20
            self.button = False  # button flag clears on read
        self._reply(f"QG,{status:02X}")

    def _q_QT(self, _args):
        self._reply("QT,")

    def _q_QL(self, args):
        self._reply(f"QL,{self.ram[int(args[0])]}")

    def _q_QE(self, _args):
        self._reply(f"QE,{EM_TO_QE[self.motors[0]]},{EM_TO_QE[self.motors[1]]}")

    def _q_QS(self, _args):
        self._reply(f"QS,{self.steps[0]},{self.steps[1]}")

    def _q_QC(self, _args):
        self._reply(f"QC,300,{self.voltage}")

    def _q_QU(self, _args):
        self._reply("QU,0")  # every queued command has already "executed"

    def _q_PI(self, _args):
        self._reply(f"PI,{1 if self._switch_pressed() else 0}")

    def _q_ES(self, _args):
        self._reply("ES,0")

    # Motion: keep QS consistent with what the firmware would do.

    def _switch_pressed(self):
        return self.x_phys <= 0

    def _move_x(self, d1, d2):
        """Physical X change for commanded motor steps d1, d2."""
        return ((d1 if self.motors[0] else 0) + (d2 if self.motors[1] else 0)) / 2

    def _motion(self, name, args):
        nums = [int(a) for a in args]
        if self.limit_triggered and name != "HM":
            return  # firmware ignores motion while the limit trigger is latched
        if name == "SM":
            d1, d2 = nums[1], nums[2] if len(nums) > 2 else 0
            dx = self._move_x(d1, d2)
            frac = 1.0
            if self.limit_mask and dx < 0 and self.x_phys + dx <= 0 < self.x_phys:
                frac = self.x_phys / -dx  # stop where the switch closes
                self.limit_triggered = True
            self.steps[0] += int(round(d1 * frac))
            self.steps[1] += int(round(d2 * frac))
            self.x_phys += dx * frac
        elif name == "HM":
            target = [nums[1], nums[2]] if len(nums) >= 3 else [0, 0]
            self.x_phys += self._move_x(target[0] - self.steps[0], target[1] - self.steps[1])
            self.steps = target
            self.accum = [0, 0]
        elif name == "T3":
            clear = nums[7] if len(nums) > 7 else 0
            self._t3(nums[0], (nums[1], nums[2], nums[3]), (nums[4], nums[5], nums[6]), clear)
        elif name == "TD":
            ticks, r1a, r1b, a1, j1, r2a, r2b, a2, j2 = nums[:9]
            clear = nums[9] if len(nums) > 9 else 0
            self._t3(ticks, (r1a, 0, j1), (r2a, 0, j2), clear)
            self._t3(ticks, (r1b, a1, -j1), (r2b, a2, -j2), 0)
        self.moves += 1
        if self.pause_after_moves is not None and self.moves == self.pause_after_moves:
            self.button = True

    def _t3(self, ticks, axis1, axis2, clear):
        for i, (rate, accel, jerk) in enumerate((axis1, axis2)):
            start = "clear" if clear & (1 << i) else self.accum[i]
            steps, accum = ebb_calc.move_dist_t3(ticks, rate, accel, jerk, start)
            self.steps[i] += steps
            self.accum[i] = accum
            self.x_phys += self._move_x(steps, 0) if i == 0 else self._move_x(0, steps)


class VirtualClock:
    """Replaces time.time/time.sleep so runs are fast and deterministic."""

    def __init__(self, start=1_700_000_000.0):
        self.t = start
        self.start = start

    def time(self):
        return self.t

    def sleep(self, seconds):
        if seconds > 0:
            self.t += seconds

    def now_ms(self):
        return (self.t - self.start) * 1000.0
