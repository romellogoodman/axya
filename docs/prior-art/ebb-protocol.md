# EiBotBoard (EBB) serial protocol reference

This is the protocol reference for porting axya's plotter driver from "spawn the `nextdraw` CLI" to "talk to the EBB directly over USB serial from Node". It covers the command set, framing, firmware differences, motion math, and the way existing drivers actually use the protocol.

## Sources and citation conventions

| Short name | Path (under `docs/reference-apps/`) | What it is |
|---|---|---|
| `ebb.html` | `ebb-firmware/ebb.html` | Official EBB command set for firmware v3.0+ |
| `ebb2.html` | `ebb-firmware/ebb2.html` | Legacy command set, firmware v1.8.0 to v2.8.1 |
| `notes` | `ebb-firmware/EBBReleaseNotes.html` | Firmware release notes, 2.0.1 to 3.1.7 |
| `ebb3_serial.py`, `ebb3_motion.py`, `ebb_calc.py` | `nextdraw-1.7.5/plotink/` | Bantam's EBB3 transport, motion wrappers, and firmware-exact math |
| `ebb_serial.py`, `ebb_motion.py` | `nextdraw-1.7.5/plotink/` | Legacy plotink EBB2 code. It ships in nextdraw 1.7.5, but nothing in `nextdrawcore/` imports it. |
| `serial_utils.py`, `homing.py`, `pen_handling.py`, `dripfeed.py`, `motion.py`, `models.py` | `nextdraw-1.7.5/nextdrawcore/` (and `nextdraw_options/`) | How Bantam's NextDraw software uses the protocol |
| saxi-a | `alexrudd2-saxi/src/ebb.ts` (plus `server.ts`, `drivers.ts`, `planning.ts`) | alexrudd2's maintained saxi fork (TypeScript) |
| saxi-n | `nornagon-saxi/src/ebb.ts` (plus `server.ts`) | Original saxi by nornagon (TypeScript) |

Anchors such as `ebb.html#SM` are the `<a name>` anchors in the HTML. One quirk: both "Returned Errors" and "Initial I/O pin configuration" use the anchor `#states` in `ebb.html`. File:line references are against the vendored copies.

Where the official docs contradict themselves or disagree with driver behavior, the entry is marked **Discrepancy**. Anything the sources don't state is marked **Undocumented**.

---

## 1. Hardware and transport

### 1.1 The board

- The EBB is a USB board that drives two stepper motors, built around a PIC18F46J50 (`ebb.html#AC` cites that datasheet). It controls the EggBot, WaterColorBot, AxiDraw, and Bantam NextDraw (`ebb.html` intro, `ebb3_serial.py:7-9`).
- The firmware schedules steps in an ISR that runs at 25 kHz, so every step lands on a 40 µs tick (`ebb.html#SM`).
- Pen lift is an RC servo output on RB1 by default (`ebb.html#SP`). NextDraw's brushless pen-lift uses RB2 (`models.py:81,89`).
- On EBB hardware v2.5 and newer, the 5 V supply to the pen servo on RB1 is switched in software through RA3 (`ebb.html#SR`).
- The green 3.3 V LED stays lit while either USB or the barrel jack supplies power (`ebb.html#faq`). Logic runs from USB alone, so runtime settings outlive a host disconnect as long as the board stays powered or plugged in. saxi-a relies on this: "the setting persists on the board until power-cycled" (`ebb.ts:238-239`).

### 1.2 USB identity and port discovery

The EBB enumerates as a USB CDC serial device. **Undocumented in the firmware docs:** neither `ebb.html` nor `ebb2.html` gives the VID:PID. Every driver uses the same values:

| Signal | Value | Used by |
|---|---|---|
| VID:PID | `04D8:FD92` | `ebb3_serial.py:78,543`; `ebb_serial.py:72,217`; saxi-a `server.ts:327`, `drivers.ts:49`; saxi-n `server.ts:253` |
| Product/description string | starts with `EiBotBoard` | `ebb3_serial.py:73,541` (pyserial `port[1]`) |
| Manufacturer string | `SchmalzHaus` or `SchmalzHaus LLC` | saxi-a `server.ts:325-326`; saxi-n `server.ts:253` |

**Nicknames** (`ebb.html#ST`, `#QT`):
- `ST,<name>` stores a name of 0 to 16 characters in flash.
- After a reboot, the USB device name becomes `EiBotBoard,<name>` and the name also becomes the USB **serial number**.
- The change takes effect only after `RB` (reboot). Bantam sends `R` and then `RB` (`nextdraw.py:511-512`).
- Flash has limited write endurance, so don't write the nickname repeatedly from automation.

Bantam's named lookup (`ebb3_serial.py:586-626`) matches, case-insensitively:
- `SER=<name>` in the pyserial hwid string
- `(<name>)` in the description (for example `(COM4)`)
- the description after the 11-character `EiBotBoard,` prefix, using a prefix match
- the port path itself, using a prefix match

**Bug in the source:** `ebb3_serial.py:623` calls `needle.replace(" ", "_")` and discards the result, so the Windows "spaces become underscores in the serial number" fallback never runs. The legacy `ebb_serial.py:121-127` has the same bug. `list_named_ebbs` (`ebb3_serial.py:552-583`) shows how to recover a nickname from Windows hwid strings (`SER=xxxx LOCAT…`).

Discovery order in Bantam's code:
1. The first port whose description starts with `EiBotBoard`.
2. Otherwise, the first port whose hwid starts with `USB VID:PID=04D8:FD92` (`ebb3_serial.py:62-81`).

saxi polls `SerialPort.list()` every 5 s until it finds an EBB (saxi-a `server.ts:337-345`).

**OS device names.** The EBB sources don't cover this; these are the standard names for USB CDC-ACM devices:
- macOS: `/dev/cu.usbmodem*`
- Linux: `/dev/ttyACM*`
- Windows: `COMn`

Match on VID/PID or manufacturer rather than on the path. Compare VID/PID case-insensitively: saxi compares to uppercase `"04D8"`, and the letter case that Node `serialport` reports can vary by platform.

### 1.3 Baud rate, line endings, and limits

- **Baud rate doesn't matter for USB CDC.** Bantam opens the port without setting one, so pyserial's default applies (`ebb3_serial.py:225`). saxi passes `baudRate: 9600` and notes that plotink "doesn't specify baud rate" (saxi-a `drivers.ts:50-54`, `server.ts:312`).
- **Commands:** ASCII, case-insensitive, no whitespace inside a command, terminated by `<CR>` (`\r`) (`ebb.html#syntax`). Every driver sends `\r` only. The docs specify only `<CR>` as a command terminator.
- **Maximum command length:** 256 bytes including the `<CR>` in v3 (`ebb.html#syntax`), 64 characters in v2.x (`ebb2.html#syntax`).
- **Responses:** line endings depend on the syntax mode (§2). Legacy mode mixes `\r\n` and `\n\r`, so a line splitter must treat any run of `\r`/`\n` as a separator and drop empty lines. saxi-a splits on `/[\r\n]+/` (`ebb.ts:106`), and saxi-n uses a regex parser on the same pattern (`ebb.ts:30`).

---

## 2. Syntax modes and framing

### 2.1 Legacy and future syntax

Firmware 3.x boots in **legacy syntax** mode, which is byte-compatible with 2.x. `CU,10,1` turns on **future syntax** (`ebb.html#CU`, `#version_differences`). The mode affects only the format of **responses**. Commands are sent the same way in both modes. Legacy mode is deprecated and will be removed in a future firmware version, at which point `CU,10` will be accepted with no effect.

| Response kind | Legacy (v2.x and v3 default) | Future (`CU,10,1`) |
|---|---|---|
| Command, no data | `OK\r\n` | `XX\n` (the command name) |
| Query with data, "OK" family (QB, QC, QE, QL, QN, QT, QU, CK) | `data\r\nOK\r\n` (QU: `QU,data\r\nOK\r\n`) | `XX,data\n` |
| Query with data, reversed endings (QP, QR, QS, ES) | `data\n\rOK\r\n` | `XX,data\n` |
| Query with no trailing OK: V, QG, I, A, MR, PI | `V`: `EBBv13_and_above EB Firmware Version x.y.z\r\n`; `QG`: `3E\r\n`; `PI`: `PI,1\r\n`; `I`/`A`/`MR` prefixed | `XX,data\n` |
| QM | `QM,c,m1,m2,f\n\r` (no OK) | `QM,c,m1,m2,f\n` |
| RB, BL | no response | no response |
| Error | error text, then `OK\r\n` (see 2.3) | `XX,!N Err: …\n` |

Sources: the per-command "Response" lines in `ebb.html`. The legacy no-OK list matches `ebb_serial.py:350` (`a, i, mr, pi, qm, qg, v`).

**Rules for future syntax** (`ebb.html#CU`, Param 10):
- A response is always the one- or two-character command name, followed by `,data` if there is data, then a single `\n`.
- Every command or query produces exactly one line.
- There is no character echo. The "echo" is just the command name at the start of the response.

**Mode-switch quirk:** part of each response is generated before the command executes, so the two mode-change commands answer in their own way:
- `CU,10,1` sent from legacy mode replies with a bare `\n`.
- `CU,10,0` sent from future mode replies with `CUOK\r\n`.

The docs advise accepting either. Bantam sends `CU,10,1`, reads one line, ignores it, and flushes the input buffer (`ebb3_serial.py:261-264`).

**Undocumented:**
- Whether the name echoed in future mode follows the case you sent. Commands are case-insensitive, but every documented example is uppercase. Send uppercase.
- The exact `QU` reply format before 3.0.2. The 3.0.2 release notes say the Param_Number was removed from QU replies (`notes` 3.0.2), but older replies aren't specified.

### 2.2 Bantam's framing (`ebb3_serial.py`)

Bantam drives one request at a time:

- **Port setup:** `serial.Serial(port, timeout=1.0)` followed by `reset_input_buffer()` (`:225-226`).
- **Handshake:**
  1. Send lowercase `v\r` and read one line. The port counts as verified if `"EBB"` appears anywhere in the line, which also accepts `V,EBB…` if a previous session left the board in future mode.
  2. If verification fails, send `v\r` once more (`:228-241`).
  3. Parse the version as the text after `"Firmware Version "` (`:138-151`).
  4. Refuse anything older than `MIN_VERSION_STRING = "3.0.2"` (`:50, 254-259`). The docstring at `:207` still says 3.0.1.
  5. Switch to future mode (`:262-264`) and read the nickname with `QT` (`:266`).
- **`command(cmd)`** (`:290-338`):
  - Derive the expected response prefix: one character if the command is one letter or the second character is a comma, otherwise two characters.
  - Write `cmd + '\r'` and `readline()`.
  - While the line is empty, call `readline()` again, up to **25 more times**. With a 1 s timeout, that tolerates about 26 s of silence.
  - Treat a missing prefix as an error ("Unexpected response", or "Serial Timeout" if the line is empty).
  - Treat any line containing `Err:` as an error.
  - Ignore I/O exceptions after `RB`, `R`, and `BL`.
  - The first error is latched in `self.err`, and **all later calls become no-ops** (`:298`). One error stops the session.
- **`query(qry)`** (`:341-396`) works like `command()` and also strips the `XX,` prefix from the result.
- **`query_statusbyte()`** (`:399-434`) sends `QG` with **no retry loop** and parses `int(response[3:], 16)`. A single failure returns `None`. `serial_utils.read_status_byte` tolerates one such `None` and flags a lost connection on the second (`serial_utils.py:108-112`).
- **No retransmission.** No path in Bantam's code resends a command. Retries only re-read the port. Resending a motion command would be wrong anyway, because motion commands aren't idempotent.

Legacy plotink (`ebb_serial.py:338-410`) uses the same 1 s timeout with up to 100 re-reads. For OK-family queries it then reads one extra line to consume the `OK`. For commands it requires the line to start with `OK`.

### 2.3 Errors

The firmware reports parse errors as `!N Err: <text>` (`ebb.html#states`, "Returned Errors"):

| Code | Meaning |
|---|---|
| `!0` | axis 1 or 2 step rate too high or too low |
| `!1` | invalid step rate |
| `!2` | TX buffer overrun (internal) |
| `!3` | RX buffer overrun: command longer than 255 bytes |
| `!4` | missing parameter(s) |
| `!5` | need comma next, found `'X'` |
| `!6` | invalid parameter value |
| `!7` | extra parameter |
| `!8` | unknown command `'X:YY'` or `'XX:YYYY'` (hex codes of the characters) |
| `!9` | checksum incorrect, expected N |
| `!10` | checksum required but missing |

- In future mode an error looks like `SM,!4 Err: Missing parameter(s)\n`.
- In legacy mode the error is followed by `OK\r\n`, which "overrides whatever other line ending there may be".
- **Undocumented:** whether the legacy error text and its `OK` arrive on one line or two, and whether the legacy error line starts with the command prefix.
- The XM section warns that "the error message may be followed by an OK response" (`ebb.html#XM`).
- Error reporting was substantially fixed in 3.0.3 (`notes`), and the docs add that "not every possible syntax error will result in the correct error code".

How the drivers detect errors:
- **Bantam:** looks for `Err:` anywhere in the line (`ebb3_serial.py:333`).
- **saxi-a:**
  - Rejects the pending request when a line *starts with* `!` (`ebb.ts:123`). That catches only legacy-style errors.
  - `command()` separately rejects `XX,!…` (`ebb.ts:220`).
  - Silently drops `!8 Err: Unknown command 'OK:4F4B'` (`ebb.ts:112`). That is the error you get when the text `OK` is parsed as a command. saxi labels it "initial startup", and the cause isn't explained.
  - **Desync risk:** if a legacy error is followed by a separate `OK` line, saxi-a's reader hands that `OK` to the *next* pending command.
- **saxi-n:** handles legacy mode only. `command()` requires exactly `OK` (`ebb.ts:117`).

**Checksum discrepancy:** the `CU,54` example shows the checksum error as `!8 Err: Checksum incorrect…` and suggests sending `CU,4,0,119`. The error table lists checksum errors as `!9`, and the intended command is `CU,54,0,119`. Both are documentation typos.

---

## 3. Firmware versions

### 3.1 Detecting the version

`V` returns `EBBv13_and_above EB Firmware Version 2.4.2` in legacy mode and `V,` plus the same text in future mode (`ebb.html#V`).
- Bantam parses the text after `"Firmware Version "` (`ebb3_serial.py:142-151`).
- Both saxi forks take the last space-separated word and split it on `.` (saxi-a `ebb.ts:150-154`, saxi-n `ebb.ts:351-355`).
- Legacy plotink's `testPort` requires the line to *start with* `EBB` (`ebb_serial.py:291`), so it would reject a board left in future mode.

### 3.2 Version minimums that drivers enforce

| Driver | Gate |
|---|---|
| nextdraw 1.7.5 | Refuses firmware below **3.0.2** and points the user to `https://bantam.tools/ndfw` (`ebb3_serial.py:50,254-259`) |
| saxi (both) | Uses `LM` if firmware is 2.5.3 or newer, otherwise falls back to `XM` (saxi-a `ebb.ts:534-536`, saxi-n `ebb.ts:389-391`). Uses `SR` only on 2.6.0 or newer (`:541-543`, `:396-398`). saxi-a sends `CU,4` only on 3.0.0 or newer (`ebb.ts:244`). |
| legacy plotink | Per feature: `QT`/`ST`/`RB` need 2.5.5, `QC` needs 2.2.3, `SR` needs 2.6.0 (`ebb_serial.py:139,162,180`; `ebb_motion.py:390,425`) |

**Discrepancy:** saxi gates `LM` at 2.5.3, but `ebb2.html#LM` says LM "should only be considered to be fully functional as of v2.7.0". `LM` was rewritten in 2.7.0 (`notes` 2.7.0), so a 2.5.x–2.6.x board may run saxi's LM moves with different timing.

### 3.3 What changed in 3.0 and later (`ebb.html#version_differences`, `notes` 3.0.0–3.1.7)

**3.0.0** (dated 03/01/24):
- **New commands:** `L3`, `T3`, `QU`, `TR`. New `CU` parameters 4, 10, 50–54, 60, 61, and 250–257. `SL`/`QL` gained 32 indexed byte slots.
- **Bigger FIFO:** up to 32 commands, but the boot default stays at 1.
- **Wider ranges:** float-based math gives `SM`/`XM`/`HM` 32-bit parameters and a minimum step rate of 0.00001164 steps/s (2.x minimum: 1.31 steps/s).
- **HM** now always moves in a straight line.
- **Breaking:**
  - `QG` bit 7 now means "limit switch triggered" and bit 6 means "power lost". In 2.x they were the RB5 and RB2 pin states.
  - The maximum number of simultaneous S2 servo channels drops from 24 to 8.
  - `PC`, `PG`, and `T` are removed. The v3 docs still list them, marked "not included in v3.0".
  - `ES` returns only the interrupted flag. The 2.2.9–2.8.1 form returned five fields.
- **Deprecated in v3** (still work, to be removed later):
  - `QB`, `QM`, `QP`: use `QG`
  - `ND`, `NI`, `QN`: use `SL`/`QL`
  - `I`: use `PI`
  - `O`: use `PO`
  - `A`, `AC`, `CU,1`
  - Using a negative `Rate` in `LM` to set direction: use the sign of `Steps` instead (`ebb.html#LM`)

**Later 3.x releases:**
- **3.0.1:** `TD`, `SP,2`, `SP,3`, and `QU,6`.
- **3.0.2:** `QU` replies no longer include Param_Number. This is the most likely reason Bantam requires 3.0.2.
- **3.0.3:** error-reporting fixes.
- **3.1.0:** fixes the end-of-command time accounting in `LT`, `T3`, and `TD`, and the jerk sign flip in `L3` when a negative `Steps` sets direction.
- **3.1.7:** optimizes the ISR and makes the step pulse width consistent.

**Discrepancies in the release notes:**
- 3.0.1 is dated 04/02/23, earlier than 3.0.0 (03/01/24).
- The 3.0.0 entry says to use "CU,3 for reading out the current FIFO depth". `CU,3` is the empty-FIFO LED. The query is `QU,3`.

---

## 4. Command reference

**Columns:**
- **Q** = execution: **F** = added to the motion FIFO; **I** = immediate.
- **Min FW** = earliest firmware with the command.
- **Status** describes v3.x.
- **Responses:** legacy `OK` means `OK\r\n`. Future `XX` means the bare name plus `\n`.
- **Used by:** **ND** = nextdraw 1.7.5 (ebb3 path); **sN** = saxi-n; **sA** = saxi-a; **leg** = legacy plotink (not used at runtime by nextdraw 1.7.5).

| Cmd | Syntax | Legacy response | Future response | Q | Min FW | Status | Used by |
|---|---|---|---|---|---|---|---|
| A | `A` | `A,ch:val,…\r\n` | `A,ch:val,…` | I | 2.2.3 | deprecated | — |
| AC | `AC,ch,en` | OK | `AC` | I | 2.2.3 | deprecated | — |
| BL | `BL` | none | none | I | 1.9.5 | | ND (`ebb3_serial.py:110`), leg |
| C | `C,trisA,…,trisE` | OK | `C` | I | all | | — |
| CK | `CK,p1..p8` | lines + OK | `CK` + lines | I | all | parser self-test | — |
| CN | `CN` | OK | — | I | ≤2.x | obsolete; not in v3 docs | — |
| CS | `CS` | OK | `CS` | I | 2.4.3 | | ND (`ebb3_motion.py:213`) |
| CU | `CU,param,value` | OK | `CU` | I | all (params vary) | `CU,1` deprecated | ND (3, 4, 10, 50, 51, 52, 60); sA (4) |
| EM | `EM,e1[,e2]` | OK | `EM` | F (≥2.8.0) | all | | ND, sN, sA, leg |
| ES | `ES[,disable]` | `n\n\rOK\r\n` | `ES,n` | I | 2.2.7 | | ND (`homing.py:187`) |
| HM | `HM,freq[,p1,p2]` | OK | `HM` | F | 2.6.2 (positions: 2.7.0) | | ND (`ebb3_motion.py:94-96`), sA (`server.ts:232`), leg |
| I | `I` | `I,a,b,c,d,e\r\n` | `I,…` | I | all | deprecated | — |
| L3 | `L3,R1,S1,A1,J1,R2,S2,A2,J2[,clr]` | OK | `L3` | F | 3.0 | | — |
| LM | `LM,R1,S1,A1,R2,S2,A2[,clr]` | OK | `LM` | F | 2.5.0 (sound from 2.7.0) | negative Rate deprecated | sN (`ebb.ts:172`), sA (`ebb.ts:318`), leg |
| LT | `LT,T,R1,A1,R2,A2[,clr]` | OK | `LT` | F | 2.7.0 | | — |
| MR / MW | `MR,addr` / `MW,addr,data` | `MR,ddd` / OK | `MR,ddd` / `MW` | I | all | | — |
| ND / NI | `ND` / `NI` | OK | `ND` / `NI` | I | 1.9.5 | deprecated | — |
| O | `O,a[,b,c,d,e]` | OK | `O` | I | all | deprecated | — |
| PC / PG | `PC,len,per,…` / `PG,v` | OK | — | I | all ≤2.x | removed in 3.0 | — |
| PD | `PD,port,pin,dir` | OK | `PD` | I | all | | ND (`ebb3_motion.py:263`), leg |
| PI | `PI,port,pin` | `PI,v\r\n` | `PI,v` | I | all | | ND (`ebb3_motion.py:288`), leg (`ebb_motion.py:218-226`) |
| PO | `PO,port,pin,v` | OK | `PO` | I | all | | ND (`ebb3_motion.py:262,275`), leg |
| QB | `QB` | `s\r\nOK\r\n` | `QB,s` | I | 1.9.2 | deprecated | sN (`ebb.ts:384`), sA (`ebb.ts:528`), leg |
| QC | `QC` | `ra0,vplus\r\nOK\r\n` | `QC,ra0,vplus` | I | 2.2.3 | | ND (`ebb3_motion.py:371,389`), sN, sA, leg |
| QE | `QE` | `m1,m2\r\nOK\r\n` | `QE,m1,m2` | I | 2.8.0 | | ND (`ebb3_motion.py:180`) |
| QG | `QG` | `HH\r\n` | `QG,HH` | I | 2.6.2 (notes: 2.6.1) | bits 6–7 changed in 3.0 | ND (`ebb3_serial.py:410`) |
| QL | `QL[,idx]` | `v\r\nOK\r\n` | `QL,v` | I | 1.9.2 (idx: 3.0) | | ND (`ebb3_serial.py:468`), leg |
| QM | `QM` | `QM,c,m1,m2,f\n\r` | `QM,c,m1,m2,f` | I | 2.4.4 (3-field form from 2.2.6) | deprecated | sN (`ebb.ts:226`), sA (`ebb.ts:378`) |
| QN | `QN` | `n\r\nOK\r\n` | `QN,n` | I | 1.9.2 | deprecated | — |
| QP | `QP` | `p\n\rOK\r\n` | `QP,p` | I | 1.9 | deprecated | leg (`ebb_motion.py:166`) |
| QR | `QR` | `p\n\rOK\r\n` | `QR,p` | I | 2.6.0 (notes: 2.5.6) | | — |
| QS | `QS` | `s1,s2\n\rOK\r\n` | `QS,s1,s2` | I | 2.4.3 | | ND (`ebb3_motion.py:199`), leg |
| QT | `QT` | `name\r\nOK\r\n` | `QT,name` | I | 2.5.4 | | ND (`ebb3_serial.py:158`), leg |
| QU | `QU,param` | `QU,v\r\nOK\r\n` | `QU,v` | I | 3.0 (`QU,6`: 3.0.1) | | ND (`QU,6`: `plot_status.py:692`) |
| R | `R` | OK | `R` | I | all | | ND (`nextdraw.py:511`) |
| RB | `RB` | none | none | I | 2.5.4 | | ND (`ebb3_serial.py:94`), leg |
| S2 | `S2,pos,RPpin[,rate[,delay]]` / `S2,0,pin` | OK | `S2` | F (`S2,0,pin`: I) | 2.2.0 | | sN (`ebb.ts:159`), sA (`ebb.ts:305`) |
| SC | `SC,param,value` | OK | `SC` | I | all | | ND (4, 5, 8, 11, 12), leg (4, 5, 11, 12) |
| SE | `SE,state[,power[,queue]]` | OK | `SE` | I, or F if queue=1 | 2.1.0 | | — |
| SL | `SL,val[,idx]` | OK | `SL` | I | 1.9.2 (idx: 3.0) | | ND (`ebb3_serial.py:449`), leg |
| SM | `SM,dur,s1[,s2[,clr]]` | OK | `SM` | F | all | | ND (`ebb3_motion.py:61,76`), leg |
| SN | `SN,val` | OK | `SN` | I | 1.9.5 | no deprecation note (but see QN) | — |
| SP | `SP,v[,dur[,pinB]]` | OK | `SP` | F for 0/1; I for 2/3 | all (2/3: 3.0.1) | | ND (`SP,0`/`SP,1`: `ebb3_motion.py:233-249`; `SP,3`: `dripfeed.py:74`), leg |
| SR | `SR,ms[,state]` | OK | `SR` | I | 2.6.0 | | ND (`ebb3_motion.py:353-355`), sN, sA, leg |
| ST | `ST,name` | OK | `ST` | I | 2.5.5 (notes: 2.5.4) | writes flash | ND (`ebb3_serial.py:178`), leg |
| T | `T,dur,mode` | OK + async I/A packets | — | I | all ≤2.x | removed in 3.0 | — |
| T3 | `T3,T,R1,A1,J1,R2,A2,J2[,clr]` | OK | `T3` | F | 3.0 | | ND (`dripfeed.py:204`, `ebb3_motion.py:222`) |
| TD | `TD,T,R1A,R1B,A1,J1,R2A,R2B,A2,J2[,clr]` | OK | `TD` | F | 3.0.1 | | ND (`dripfeed.py:288-290`) |
| TP | `TP[,dur]` | OK | `TP` | I (doc) | 1.9 | | leg (`ebb_motion.py:326`) |
| TR | `TR,rate,s1[,s2[,clr]]` | OK (doc shows `OK<CR><TR>`) | `TR` | F | 3.0 | test of the 3.0 math | — |
| V | `V` | `EBB… Version x.y.z\r\n` | `V,EBB…` | I | all | | ND, sN, sA, leg |
| XM | `XM,dur,sA,sB[,clr]` | OK | `XM` | F | 2.3.0 | | sN (`ebb.ts:220`), sA (`ebb.ts:372`), leg (`ebb_motion.py:53`) |

**Discrepancies within the docs:**
- `ebb.html#HM` says "v2.6.2 and newer" but its version history says "Available since firmware 2.7.0". The release notes put the HM addition in 2.6.2 and absolute positions in 2.7.0.
- `ebb.html#SE` says "Added to FIFO motion queue", but its description says SE is immediate unless `Use_Motion_Queue=1`.
- `ebb.html#TP` says "Immediate", but `#QM` lists TP with a duration among the timed "motion commands".
- `ebb.html#S2` says S2_Channel_Duration "can be adjusted with the RC,9 command". No RC command exists; it means `SC,9`.

### 4.1 Detailed notes on the important commands

#### SM: stepper move (`ebb.html#SM`)
- **Syntax:** `SM,Duration,AxisSteps1[,AxisSteps2[,Clear]]`. Constant velocity on both axes.
- **Ranges in v3:** Duration 1 to 4294967295 ms, steps signed 32-bit.
- **Ranges in v2:** duration ≤16777215, steps ±16777215.
- **Delays:** if both step counts are 0, the command is a delay, capped at 100000 ms in v3. Bantam's `timed_pause` splits delays into `SM,≤750,0,0` chunks (`ebb3_motion.py:51-62`).
- **Rate limits:** each axis must stay between 0.00001164 and 25000 steps/s (2.x: 1.31 to 25000). Out-of-range rates return an error.
- **Clamping discrepancy:** the doc says "If limit checks have been disabled with **CU,1,0**, the rate will be silently clamped". Limit checking is `CU,2`; `CU,1` controls the OK response. The same mistake appears in `#XM`.
- **Precision:** Duration is converted to float32, so durations above 16,777,216 ms may round.
- **Axis mapping:** Bantam's `xy_move` sends `SM,dur,delta_y,delta_x` (`ebb3_motion.py:76`). The caller passes mixed-axis motor steps, and the comment explains that on AxiDraw and NextDraw the axes are mixed.

#### XM: mixed-axis move (`ebb.html#XM`)
- **Syntax:** `XM,Duration,A,B[,Clear]`. Equivalent to `SM,Duration,A+B,A−B`, so it suits CoreXY/H-bot machines such as the AxiDraw.
- **Ranges:** Duration up to 2³¹−1 in v3. A±B must not overflow int32.
- **Limits:** the rate check applies after the sum and difference.
- saxi uses XM only when firmware is older than 2.5.3 (saxi-a `ebb.ts:426-449`).

#### LM, LT, L3, T3, TD: low-level moves
See §5 for the math.
- **LM / L3** end per axis after `Steps` steps, so the axes can finish at different times. That produces "bent" lines unless the timing matches.
- **LT / T3** end after `Intervals` 40 µs ticks. They chain smoothly but don't guarantee an exact destination. The docs recommend following a run of LT moves with `HM`.
- **Validation:** these commands skip parameter math and limit checking for throughput. Invalid values are not rejected.
- **Clear** (0–3) zeroes the step accumulator of axis 1, axis 2, or both at the start of the move.
- **TD** expands inside the firmware into two T3 commands (`ebb.html#TD`):
  1. `T3,Intervals,Rate1A,0,Jerk1,Rate2A,0,Jerk2[,Clear]`
  2. `T3,Intervals,Rate1B,Accel1,−Jerk1,Rate2B,Accel2,−Jerk2,0`

  It takes 2 × Intervals in total and occupies **two** FIFO slots.
- **Direction:**
  - LM: a negative `Steps` with a positive `Rate` flips Rate, Steps, Accel, and (from 3.1.0) Jerk. Using a negative `Rate` for direction is deprecated in 3.0.
  - LT/T3/TD: the sign of `Rate` gives the initial direction, and the formulas use |Rate|.
  - In 2.x, LM's Rate is unsigned 31-bit and only the sign of `Steps` sets direction (`ebb2.html#LM`). Both saxi forks follow that convention: they send `Math.abs` rates and signed steps (saxi-a `ebb.ts:350-353`).

#### HM: home or absolute move (`ebb.html#HM`)
- **Syntax:** `HM,StepFrequency[,Pos1,Pos2]`, frequency 1 to 25000 (2.x: 2 to 25000).
- **Behavior:** moves to (0,0) or to an absolute position measured from where the step counters were last zeroed (by `EM` or `CS`). This is the only absolute move.
- **Timing:** waits until earlier motion finishes, then starts about 5 ms later.
- **Path:** a straight line in v3. In 2.x it could split into two segments (a dog-leg).
- **Ranges:** v3 positions are signed 32-bit, and the position minus the current position must not overflow. v2 limit is ±4,294,967.
- **Stale comments:** Bantam's code still says HM "is not necessarily a move in a straight line" (`ebb3_motion.py:86`, `serial_utils.py:160`), describing 2.x behavior.
- **Uses:** Bantam uses HM for short correction moves (`serial_utils.py:155-168`). saxi-a sends `HM,4000` to return home after a cancel (`server.ts:232`).

#### EM: enable motors (`ebb.html#EM`)
- **Syntax:** `EM,Enable1[,Enable2]`.
  - Enable1: 0 = off; 1/2/3/4/5 = 1/16, 1/8, 1/4, 1/2, full step. This sets the **global** microstep mode.
  - Enable2: 0 = off; nonzero = on at the current global mode.
- **Side effects:** clears both step counters (`QS`) and, since 2.7.0, both accumulators.
- **Queueing:** queued in the FIFO since 2.8.0.
- **Auto-enable:** motion commands enable both motors automatically unless `CU,50,0` is set.
- **Bantam's sequence:**
  - Sets `CU,50,0` on every connect (`serial_utils.py:67`), so it must send EM explicitly.
  - Enables at `EM,1,1` (high-resolution mode) or `EM,2,2` (low-resolution mode).
  - Skips the EM if `QE` already reports that mode, because re-enabling clears the counters and would lose the homed position (`serial_utils.py:198-213`).
  - The comment at `serial_utils.py:211` says "16X" for `EM,2,2`. That is 8x.
- **Single-motor enable:** if only motor 2 should run, Bantam first sends `EM,r,r` to set the resolution, because only Enable1 can set it (`ebb3_motion.py:130-153`).

#### QE: query motor enables (`ebb.html#QE`, 2.8.0+)
- **Response:** each motor reports 0 (off) or 1/2/4/8/16 (full step to 1/16).
- Bantam maps these back to EM codes with `{16:1, 8:2, 4:3, 2:4, 1:5, 0:0}` (`ebb3_motion.py:184`).
- **Before 2.8.0:** legacy plotink reads the driver pins directly (`ebb_motion.py:200-250`):
  - `PI,E,0`: EN1, active low
  - `PI,C,1`: EN2, active low
  - `PI,E,2`: MS1
  - `PI,E,1`: MS2
  - `PI,A,6`: MS3

#### QS and CS: step positions (`ebb.html#QS`, `#CS`)
- **QS** returns the signed 32-bit global step counters. Each counter changes on every step actually taken, so it stays correct even mid-move.
- The docs recommend waiting for idle before reading QS. Bantam calls `exhaust_queue` first (`serial_utils.py:221-228`).
- **CS** zeroes both counters and both accumulators. It is immediate, not queued.
- **Clearing only the accumulators** without touching the counters: Bantam queues a one-tick, zero-motion `T3,1,0,0,0,0,0,0,3` (`ebb3_motion.py:216-222`).

#### SP: set pen (`ebb.html#SP`)
- **Values:**
  - `SP,0`: queue a move to Servo_Max (`SC,5`, conventionally pen down).
  - `SP,1`: queue a move to Servo_Min (`SC,4`, conventionally pen up).
  - `SP,2` (3.0.1+): start moving to Servo_Min immediately, skipping the FIFO.
  - `SP,3` (3.0.1+): like `SP,2`, but also sets Servo_Max = Servo_Min and rewrites the target of every queued servo command, so nothing queued can lower the pen again.
- **Duration** (ms, 1 to 65535) is how long until the *next* queued command may start. It does not control servo speed.
- **PortB_Pin** selects the output pin. The default is 1 (RB1).
- **Pause in Bantam:**
  1. Send `SP,3` (`dripfeed.py:74`).
  2. Stop feeding moves; the FIFO drains.
  3. Later, `servo_revert` restores `SC,5` (`pen_handling.py:474-493`).

#### SC: stepper and servo configure (`ebb.html#SC`)

| Index | Meaning | Values / default | Used by |
|---|---|---|---|
| 1 | Pen-lift output | 0 = solenoid RB4; 1 = servo RB1; 2 = both (default) | — |
| 2 | Stepper signal routing | 0 = on-board drivers (default); 1 = external step/dir pins; 2 = all inputs | — |
| 4 | Servo_Min, the SP,1 ("up") target | 1–65535 × 83.3 ns; default 12000 (1.0 ms) | ND (`ebb3_motion.py:311`), leg |
| 5 | Servo_Max, the SP,0 ("down") target | default 16000 (1.33 ms); `SP,3` sets it equal to Servo_Min | ND (`ebb3_motion.py:301`), leg |
| 8 | Maximum S2 channels | 1–8 in v3 (1–24 in 2.x); default 8 | ND: `SC,8,1` brushless, `SC,8,8` standard (`pen_handling.py:461-464`) |
| 9 | Channel slot duration | 1–6 ms; default 3 | — |
| 10 | Servo rate, up and down | S2 rate units | — |
| 11 | Servo rate, up | S2 rate units | ND (`ebb3_motion.py:329`), leg |
| 12 | Servo rate, down | S2 rate units | ND (`ebb3_motion.py:320`), leg |
| 13 | Alternate PRG button on RB0 | 1 = on (default) | — |

The `SC,14` entries in the release notes (2.1.2, 2.2.2) are absent from both command docs and should be treated as obsolete.

#### S2: general RC servo output (`ebb.html#S2`)
- **Syntax:** `S2,Position,RPpin[,Rate[,Delay]]`. Position is in 83.3 ns units; 0 disables the channel.
- **Pin numbering** uses RPx, not PortB bit numbers: RB0 = RP3, RB1 = RP4, RB2 = RP5, RB3 = RP6, RB4 = RP7, RB5 = RP8, RB6 = RP9, RB7 = RP10.
- **Queueing:** queued, except `S2,0,pin`, which runs immediately.
- **Conflicts:** SP and TP use an S2 channel internally.
- **saxi** sends pen moves as S2 on RP4 for hardware `v3`, or RP5 for `brushless` and `nextdraw-2234` (saxi-a `ebb.ts:304-305`). It passes the move duration as Delay (`ebb.ts:463-466`).
- **saxi-n** sends rate 0, which means an instant jump on the next PWM cycle (`ebb.ts:301`).

#### SR: servo power timeout (`ebb.html#SR`)
- **Syntax:** `SR,ms[,state]`. ms is 32-bit; 0 disables the auto-off. state turns servo power on (1) or off (0) immediately.
- **Defaults:** 60 s after boot (since 2.6.3). Servo power is off at boot and switches on with servo motion. Since 2.6.5 stepper motion no longer switches it on.
- **Scope:** controls RB1 power only, and only on hardware v2.5 or newer.
- **Bantam** sends `SR,60000` only for the standard servo (`pen_handling.py:465-466`; `nextdraw_conf.py:129`).
- **saxi** sends `SR,0,1` when enabling motors and `SR,60000,0` when disabling them (saxi-a `ebb.ts:268-281`). Its server sends `SR,10000,1` before a manual pen move (`server.ts:89-92`).

#### QG: query general (`ebb.html#QG`)
Returns one hex byte. Legacy: `HH\r\n` with no OK. Future: `QG,HH\n`.

| Bit | Value | v3 meaning | v2 meaning (`ebb2.html#QG`) |
|---|---|---|---|
| 7 | 0x80 | Limit switch triggered (latched; reading QG clears it) | RB5 pin state |
| 6 | 0x40 | Power lost: V+ dropped below the `CU,60` threshold since the last QG (latched; cleared by reading) | RB2 pin state |
| 5 | 0x20 | PRG button pressed since the last QG or QB (B0 pulled low ≥40 µs also counts) | same |
| 4 | 0x10 | Pen up (commanded state, not physical position) | same; earlier docs had this bit inverted |
| 3 | 0x08 | CMD: a FIFO-type command is executing | same |
| 2 | 0x04 | Motor 1 moving | same |
| 1 | 0x02 | Motor 2 moving | same |
| 0 | 0x01 | FIFO not empty (v3: one or more commands waiting) | the 1-deep FIFO is full |

Bits 0–3 match QM's fields. Idle means `(QG & 0x0F) == 0`. Bantam uses exactly that check in `exhaust_queue` (`serial_utils.py:150`, polled every 50 ms) and in homing (`homing.py:190`, polled every 2 ms). `read_status_byte` acts on bits 7, 6, and 5 (`serial_utils.py:114-124`).

#### QU: query utility (`ebb.html#QU`, 3.0+)

| Param | Returns |
|---|---|
| 1 | PortB snapshot at the last limit-switch trigger (2 hex digits) |
| 2 | Maximum FIFO length (decimal) |
| 3 | Current FIFO length |
| 4 | Stack high-water mark (3 hex digits) |
| 5 | Same as 4, then resets it |
| 6 | Number of commands currently waiting in the FIFO (3.0.1+) |
| 60 | Power_Lost_Threshold |
| 61 | Stepper_Disable_Timeout |
| 200 | Both axis accumulators (unsigned 32-bit decimal), for verification |

Bantam uses `QU,6` to work out how much queued pen-down distance to subtract when a pause lands mid-queue (`plot_status.py:684-707`). `QU,4` and `QU,200` appear only in commented-out debug code (`nextdraw.py:1027-1030`).

#### CU: configure user options (`ebb.html#CU`)
All CU settings return to their defaults on reset or reboot.

| Param | Meaning | Default | Min FW | Used by |
|---|---|---|---|---|
| 1 | Send OK responses (legacy only; ignored in future mode) | 1 | all | deprecated |
| 2 | Parameter limit checking for motion commands (2.x: SM only) | 1 | 2.4.0 | — |
| 3 | Red USR LED lights while the FIFO is empty | 0 | 2.8.1 | ND `CU,3,1` (`serial_utils.py:65`) |
| 4 | FIFO depth, 1 to the `QU,2` maximum (larger values are clamped). **Blocks until the queue is empty and motion has stopped.** | 1 | 3.0 | ND `CU,4,16` (`serial_utils.py:66`); sA `CU,4,255` or `SAXI_FIFO_DEPTH` (`ebb.ts:241-256`) |
| 10 | Future syntax mode | 0 | 3.0 | ND `CU,10,1` (`ebb3_serial.py:262`) |
| 50 | Auto-enable motors on motion commands | 1 | 3.0 | ND `CU,50,0` (`serial_utils.py:67`, `homing.py:423`, `ebb3_motion.py:133`) |
| 51 | Limit switch mask (PortB bits; nonzero arms the check) | 0 | 3.0 | ND `CU,51,2` arm / `CU,51,0` clear (`homing.py:574,283,561`) |
| 52 | Limit switch target levels | 0 | 3.0 | ND `CU,52,2` (`homing.py:573`) |
| 53 | Send an asynchronous "Limit switch triggered. PortB=XX\n" packet | 0 | 3.0 | — |
| 54 | Require checksums on commands | 0 | 3.0 | — |
| 60 | Power_Lost_Threshold, 0–1023 in units of 0.0295 V | 0 (off) | 3.0 | ND `CU,60,135` (`serial_utils.py:186`) |
| 61 | Stepper_Disable_Timeout, 0–65534 s after the last move | 0 (off) | 3.0 | — |
| 250–257 | Internal debug and test modes | — | 3.0 | do not use |

**Discrepancies:**
- The version-history line for CU lists 50–53 and 250–257 as new in 3.0 but leaves out 4, 10, 54, 60, and 61. Each of those parameters' own text says "new for CU in EBB firmware v3.0".
- `ebb2.html#CU` says Param_Number is "1 or 2", then documents 3 as well.
- The checksum format is described as "0x100 − (sum of all command bytes before the comma)" modulo 256, without stating the modulo. The doc's own example, `SM,1000,1000,1000,153`, confirms the method.

#### SL and QL: variables (`ebb.html#SL`, `#QL`)
- **Syntax:** `SL,value[,index]` and `QL[,index]`. 32 unsigned bytes, indexes 0–31, all cleared to 0 at reset. The index defaults to 0 for backward compatibility.
- **v2.x:** only one "Layer" byte, documented as 0–127 (`ebb2.html#SL`).
- **No native int32 command.** Bantam stores a big-endian two's-complement int32 across four slots with `var_write_int32` / `var_read_int32` (`ebb3_serial.py:475-528`).

Bantam's slot map is shared state. If axya and the `nextdraw` CLI can both run against the same powered board, axya should honor it:

| Slots | Meaning | Source |
|---|---|---|
| 10 | Pen-up code: 1–101 for standard servo, 102–202 for brushless | `pen_handling.py:381-391,470` |
| 11 | Pen-down code, same encoding | `pen_handling.py:471` |
| 12 | Homed flag (1 = homed) | `homing.py:106,154,612`; `serial_utils.py:82,121` |
| 13 | Power flag (written 0 after power loss) | `serial_utils.py:83,122` |
| 24–27 | Motor 1 origin offset, int32 (steps × 1000) | `serial_utils.py:237,247`; `homing.py:621` |
| 28–31 | Motor 2 origin offset, int32 | `serial_utils.py:238,248` |

#### PI, PO, PD: GPIO (`ebb.html#PI`, `#PO`, `#PD`)
- **Syntax:** port letter A–E, pin 0–7. `PD` direction 0 = output, 1 = input.
- **PI** reads any pin regardless of how it is configured.
- **PortB** pins have weak pull-ups whenever they are inputs (`ebb.html#states`, I/O section).
- **Voltage limits:** B0–B3 are **not** 5 V tolerant; B4–B7 are.
- **Bantam's limit-switch input on B1** (`homing.py:422`, `ebb3_motion.py:253-263`):
  1. `PO,B,1,1`
  2. `PD,B,1,1`
  3. Read the switch with `PI,B,1` (`homing.py:204-225`).

#### ES: E-stop (`ebb.html#ES`)
- **Syntax:** `ES[,1]`.
- **Effect:** aborts the move in progress and flushes the FIFO immediately. With `,1` it also disables both drivers.
- **Response:**
  - v3: `ES,0` or `ES,1` (future) / `n\n\rOK\r\n` (legacy).
  - 2.2.9–2.8.1: `interrupted,fifo_steps1,fifo_steps2,steps_rem1,steps_rem2`.
  - Before 2.2.9: a single flag.
- **Bantam** uses ES only to stop a homing move when the button is pressed (`homing.py:187`). Normal pause is `SP,3` plus letting the FIFO drain (§6). Neither saxi fork sends ES.

#### QC: query voltages (`ebb.html#QC`)
- **Response:** two zero-padded 10-bit ADC values, `RA0,V+`, where 1023 = 3.3 V at the pin.
- **Motor current limit:** I_max ≈ V_RA0 / 1.76 A.
- **Supply voltage:** V_in ≈ raw/1023 × 3.3 × 9.2 + 0.3 on EBB hardware v2.3 and newer (× 11 on v2.2 and older). The 0.3 V term is the input diode drop.
- **Thresholds the drivers use:**
  - Bantam: "powered" if raw V+ ≥ 200 (`serial_utils.py:77`, `homing.py:116`), which is about 6.2 V. The function default is 250, about 7.7 V (`ebb3_motion.py:370`).
  - saxi: computes the voltage with the formula above and requires more than 6 V (saxi-a `ebb.ts:496-525`).

#### Node counter and other legacy commands (`QN`, `SN`, `NI`, `ND`, `QB`, `QM`, `QP`)
All of these are deprecated in v3 (except `SN`, which has no notice). None of the drivers uses the node counter.

---

## 5. Motion math

### 5.1 The accumulator model (`ebb.html#LM`, `#L3`, `#T3`)
Each axis has a 32-bit step accumulator `C`. The ISR runs every 40 µs (25 kHz).

**At the start of a move:**
- `Rate ← Rate − Accel/2 + Jerk/6`. The `Jerk/6` term applies to L3, T3, and TD; LM and LT use only `Accel/2`.
- If `Clear` is set, the selected accumulators are zeroed.

**On each tick:**
1. `Accel += Jerk` (L3/T3 only)
2. `Rate += Accel`
3. If `Rate < 0`, set `Rate += 2³¹` (doc wording)
4. `C += Rate`
5. If `C ≥ 2³¹`, take one step and `C −= 2³¹`
6. LM/L3: stop the axis when its step count reaches `Steps`. LT/T3: stop when `Intervals` ticks have elapsed.

**Units** (F = steps/s, a = steps/s², j = steps/s³):

| Quantity | Formula | Constant |
|---|---|---|
| Rate | `F × 2³¹ × 40 µs` | ≈ 85,899.35 × F |
| Accel (per tick) | `a × 2³¹ / 25000²` | ≈ 3.43597 × a |
| Jerk (per tick²) | `j × 2³¹ / 25000³` | ≈ 1.37439 × 10⁻⁴ × j |

Bantam precomputes `velocity_scale = step_scale × 2³¹/25000` and `jerk_scale = step_scale × 2³¹/25000³` (`motion.py:822-823`). saxi uses `Math.round(F × 0x80000000/25000)` (saxi-a `ebb.ts:557-560`).

**Closed form** (`ebb.html#LM`; `ebb_calc.py:55-184`), after T ticks with a starting accumulator `C₀`:

```
C(T)     = C₀ + R_eff·T + A·T²/2 + J·T³/6
steps(T) = floor(C(T) / 2³¹)          // the remainder is the new accumulator
R_eff    = Rate + A/2 − trunc(A/2) + trunc(J/6) − J/6     // corrects for integer pre-adjustment
Rate(T)  = Rate − trunc(A/2) + trunc(J/6) + (A − J/2)·T + J·T²/2   // ebb_calc.rate_t3
```

**Movement time:** `T ≈ 2³² × Steps / (Rate + RateFinal)`. For LM, solve the quadratic exactly; `ebb_calc.calculate_lm` does this, including LM moves that reverse direction mid-move in 3.0 (`ebb_calc.py:246-400`).

### 5.2 Firmware-exact position prediction
Bantam predicts every axis's step count and leftover accumulator for each T3/TD it sends, using `ebb_calc.move_dist_t3` and `rate_t3` (`motion.py:956-979, 1050-1070, 1122-1123`). It carries `accum1`/`accum2` from move to move (`dripfeed.py:190-191, 221-222`).

How the arithmetic is done:
- **Precision:** Python `Decimal` with 20 digits (`ebb_calc.py:44`). For C(T) in T3, it rounds half-up before the floor (`:178`).
- **Behavior of `Clear` that ebb.html doesn't describe:** when the first tick's rate is negative (or zero with negative accel or jerk), `ebb_calc` starts a cleared accumulator at **2³¹−1**, not 0 (`ebb_calc.py:84-89, 137-148, 292-298`). In other words, negative-direction motion counts down from the top of the accumulator. **Discrepancy:** `ebb.html` describes only "Rate < 0 → Rate += 2³¹" and says nothing about this. If axya needs exact prediction, port `ebb_calc.py` line for line and test against `QU,200` (accumulators) and `QS` on real hardware.

**TD midpoint rate:** Bantam builds TD's `Rate1B` as `rate_t3(T, Rate1A, 0, J) + Accel1`, with `Accel1 = round(J × T)` (`motion.py:972-987`). The docs' example only calls `Rate1B` "the exact discrete midpoint rate".

### 5.3 Limits and overflow
- **Maximum step rate:** 25 kHz, one step per tick. Rate must stay at or below 2³¹−1, which works out to slightly under 25000 steps/s (`ebb_calc.py:202,226`). Bantam caps the step rate at 24.995 steps/ms (`nextdraw_conf.py:242`).
- **Minimum step rate:** SM/XM/HM: 0.00001164 steps/s in v3, 1.31 in 2.x. LM/LT/T3 have no checks.
- **Parameter widths:** Rate, Steps, Accel, and Jerk are int32. LT/T3/TD Intervals are 1 to 2³²−1.
- **Intermediate width:** "Steps × 2³¹ may take up to 63 bits" (`ebb.html#LM`), so use 64-bit or arbitrary-precision math.
  - In JS, `Number` is exact only to 2⁵³, and terms such as `J·T³/6` or `Rate·T` for long moves can exceed that.
  - Use `BigInt` (rationals scaled by 6) for prediction.
- **Duration precision:** SM/XM durations go through float32 inside the firmware.
- **Minimum sustained move length** without gaps between moves, with both axes near 25 kHz (`ebb.html#performance`):

| Command | v3.0+ | 2.7.0 to 3.0 | before 2.7.0 |
|---|---|---|---|
| SM | 2 ms | 3–4 ms | 4–7 ms |
| LM | 4 ms | 3–4 ms | 4–6 ms |
| L3 | 4 ms | — | — |

The docs recommend fewer, longer moves because of USB jitter on the host, especially on Windows. Step pulse width is 1.6–2.3 µs from 2.7.0 on.

---

## 6. FIFO and queue behavior

**Depth:**
- Before 3.0, the FIFO is fixed at 1 command.
- In 3.0+, depth starts at 1 at boot and can be raised with `CU,4,n` up to `QU,2` (32 per `notes` 3.0.0). `QU,3` reads the current depth.
- `CU,4` blocks until the queue is empty and motion has stopped.
- The depth persists until reset or power-off, so it outlives a host session.

**Blocking when the FIFO is full** (`ebb.html#QM`; `ebb2.html#QM`):
- At any moment there can be one executing command, N commands in the FIFO, and **one more command held in the USB parser**.
- While that last command waits for a slot, **the parser accepts nothing else, including queries**, until a slot frees up.
- So the reply to that command, and to anything sent after it, can be delayed by up to the remaining time of the executing move.
- Bantam's tolerance of about 26 s of silence (§2.2) absorbs this delay.

**What goes in the FIFO:**
- `EM` (2.8.0+), `SM`, `XM`, `HM`, `LM`, `LT`, `L3`, `T3`, `TD` (two slots), `TR`
- `S2` (except `S2,0,pin`), `SP,0`/`SP,1`, and `SE` with queue=1
- A "motion command" is anything with a duration, including pen moves that have a delay.

**Detecting progress and idle:**
- **Idle** (nothing executing, nothing queued): `(QG & 0x0F) == 0`. Bantam polls this with a sleep between polls (`serial_utils.py:129-153`).
  - saxi polls `QM` until `CommandStatus` and `FIFOStatus` are both 0 (saxi-a `ebb.ts:375-383`).
  - saxi's loop has **no sleep**, so it hammers the USB link with queries.
- **Queue depth right now:** `QU,6` (3.0.1+). It doesn't include the executing command, so it can't confirm idle on its own.
- **Pen state:** QG bit 4 reflects the *commanded* pen state once a pen command has *started*, not when it is queued (`ebb.html#QP`).

**Host pacing:**
- Bantam sets depth 16 and sends moves one at a time. Each `command()` blocks until the EBB accepts the move.
- After any move longer than 50 ms, Bantam sleeps `move_time − 30` ms before sending the next one (`dripfeed.py:150-152, 208-210, 293-295`). This keeps the host from running far ahead of the board, so a pause takes effect within about one queue's worth of moves.
- saxi-a sets depth 255 (clamped by the firmware) to ride out host stalls (`ebb.ts:230-256`).

**Ways the queue gets flushed:**
- **`ES`:** aborts the executing command and empties the FIFO. Step counters stay accurate because they count real steps, so read `QS` afterward to learn the true position.
- **Limit switch stop:** same effect. Motion commands are then ignored until `CU,51,0`, any `EM`, or a reset.
- **`SP,3`:** doesn't flush, but rewrites the targets of queued servo moves so the pen stays up.

---

## 7. Servo control

**Units:** one Position or Servo_Min/Max unit is 1/12,000,000 s ≈ 83.3 ns, so 12000 = 1.0 ms (`ebb.html#S2`, `#SC`).

**Slot scheduler:**
- Up to `SC,8` channels (1–8 in v3, 24 in 2.x) each get an `SC,9` slot (1–6 ms, default 3 ms).
- Every channel repeats once per **period = channels × slot**, which is 24 ms by default.
- A pulse longer than its slot is cut to the slot length.

**Rate units:** each PWM period, `Rate` units (83.3 ns) are added to or subtracted from the pulse width.
- Move time = |ΔPosition| × period / Rate. The FAQ gives `((max−min) × 0.024)/rate` s for the default 24 ms period.
- **Discrepancy:** the FAQ says Servo_Min defaults to 16000 and Servo_Max to 20000. The SC and SP sections say 12000 and 16000. Release notes 2.6.0 changed them to 22565 (up) and 15302 (down).
- **Don't rely on any default; always set SC,4 and SC,5 explicitly.**

**SP vs S2:**
- `SP` drives the pen-lift channel using SC,4, SC,5, SC,11, and SC,12. Its optional pin argument is a **PortB bit** (1 = RB1).
- `S2` drives any RPx pin with an explicit position, rate, and delay, and the pin argument is an **RP number** (RB1 = RP4, RB2 = RP5).
- Both go through the FIFO. Only SP has the immediate `SP,2` and `SP,3` variants.

**"Min" and "max" are labels, not ordering:** SP,1 drives to Servo_Min (SC,4) and SP,0 to Servo_Max (SC,5). Bantam writes the *up* position to SC,4, and for NextDraw the up value is numerically the larger one (standard servo: up = 27831, down = 9855; `models.py:82-83`; `pen_handling.py:438-441`).

**Standard vs brushless:**

| | Standard servo | Narrow-band brushless |
|---|---|---|
| PortB pin (SP) / RP (S2) | 1 / RP4 | 2 / RP5 |
| Bantam range (`models.py`) | 9855–27831 | 5400–12600 |
| saxi range (`planning.ts:118-132`) | 7500–28000 (AxiDraw) | 5400–12600 |
| `SC,8` channels (Bantam) | 8, so a 24 ms period | 1, so a 3 ms period (`pen_handling.py:461-464`) |
| Full sweep time (Bantam) | 200 ms | 70 ms |
| `SR` power timeout (Bantam) | `SR,60000` | not sent |

**Bantam's rate formula:** `rate = range × (period_ms/100) / sweep_time_ms × pen_rate_percent` (`pen_handling.py:388-393, 428-433`).

**saxi's rate formula:** `rate = |Δ| × 24 / duration_ms` (saxi-a `ebb.ts:463-466`). It never sends `SC,8,1`, so it assumes the 24 ms period even for brushless pen-lifts.

**Servo power:** `SR` sets the auto-off timeout (60 s at boot). `QR` reports whether servo power is on. Only RB1 power is switched, and only on hardware v2.5 or newer.

---

## 8. Safety features

**Limit switches** (`ebb.html#CU` params 51–53, `#QG`, `#QU`):
- When the mask is nonzero, PortB is sampled every 40 µs. If `(PortB & mask) == (target & mask)`, the board stops immediately: it aborts the move, flushes the FIFO, and blocks further motion.
- QG bit 7 latches the event. `QU,1` returns the PortB snapshot from the trigger.
- Clear the condition with `CU,51,0`, any `EM`, or a reset.

Bantam's homing sequence:
1. Configure B1 as an input with the pull-up (normally-closed switch to ground, so a reading of 1 means pressed or missing).
2. Send `CU,52,2` and `CU,51,2`.
3. Move, then poll QG every 2 ms.
4. Check bit 7.
5. Send `CU,51,0` (`homing.py:270-283, 555-575`).

`CU,53,1` makes the board send an **unsolicited** line, `Limit switch triggered. PortB=XX\n`, "between replies". Bantam doesn't enable it. A strict request/response reader would mistake that line for a reply.

**Power-loss detection** (`ebb.html#CU` param 60, `#QG`):
- `CU,60,threshold` (0.0295 V per unit; 404 ≈ 12 V) makes the board compare V+ against the threshold every 2 ms and latch QG bit 6 if it drops below.
- Read QG once after setting the threshold to clear any stale latch.

Bantam's handling:
1. Sends `CU,60,135` (≈4 V) and then QG (`serial_utils.py:185-193`).
2. When bit 6 is set, treats step position as lost:
   - writes SL slot 12 = 0 (not homed)
   - writes slot 13 = 0
   - sends `CS`
   - raises a voltage warning (`serial_utils.py:118-124`).
3. Also spot-checks `QC` before plotting and homing (§4.1, QC).

**Emergency stop and pause:**
- **`ES[,1]`:** immediate stop and flush, optionally disabling the drivers.
- **`SP,3`:** immediate pen-up, and queued moves can't lower the pen again.
- **`CU,61,s`:** disable the stepper drivers s seconds after the last motion.
- **Pause button:** QG bit 5 latches the PRG button or B0 pulled low (disable B0 with `SC,13,0`). Bantam treats it as a pause request (`serial_utils.py:116`, `homing.py:183-188`).
- **`R`** resets the application state without dropping USB. **`RB`** re-enumerates USB, so the port must be reopened.

**Command integrity:** `CU,54,1` requires an 8-bit two's-complement checksum appended as `,NNN` to every command. No driver enables it.

---

## 9. EBB2 and EBB3 differences (supporting older AxiDraws and NextDraw)

| Area | Firmware 2.x (≤2.8.1) | Firmware 3.x | Driver impact |
|---|---|---|---|
| Response syntax | Legacy only (OK, mixed `\r\n`/`\n\r`) | Legacy by default; future with `CU,10,1` | Support both parsers, or use legacy everywhere; future mode is cleaner on v3 |
| Command length | ≤64 characters | ≤256 bytes | Keep commands under 64 if one path serves both |
| FIFO | Fixed at 1 (plus 1 held in the parser) | 1 to `QU,2` (32) via `CU,4` | Pacing and timeouts must tolerate depth 1 on 2.x |
| QG bits 7 and 6 | RB5 and RB2 pin states | Limit-switch and power-lost latches | Branch on version before reading these bits |
| ES response | `int,f1,f2,r1,r2` (2.2.9+) or one flag | One flag | Parse only the first field |
| SM/XM ranges | 24-bit; min rate 1.31 steps/s | 32-bit; min 0.0000116 steps/s | Split long or slow moves on 2.x |
| HM | freq 2–25000; positions ±4,294,967; may dog-leg | freq 1–25000; int32; straight line | Don't draw with HM on either |
| LM | Rate unsigned 31-bit; direction from the sign of Steps; fully correct from 2.7.0 | Rate signed (negative-direction use deprecated) | Use signed Steps with non-negative Rate: valid on both |
| Jerk moves (L3/T3/TD) | Not available | 3.0 (TD: 3.0.1) | 2.x needs LM/LT or SM/XM plans |
| `QU`, `SP,2`/`SP,3` | Not available | 3.0 / 3.0.1 | 2.x pause = stop feeding, then queued `SP,1` |
| `CU` params | 1, 2 (SM only), 3 (2.8.1) | Adds 4, 10, 50–54, 60, 61 | No limit switch, power-loss latch, or FIFO depth on 2.x |
| SL/QL | One byte (doc: 0–127) | 32 slots × 0–255 | Bantam's slot map is v3-only |
| QE | 2.8.0+ only | yes | Read the PI pins before 2.8.0 |
| EM | Immediate before 2.8.0; queued from 2.8.0 | Queued | Before 2.8.0, wait for idle before EM |
| S2 channels | 1–24 | 1–8 | `SC,8` ≤ 8 |
| PC, PG, T | Present | Removed | Don't use |
| Deprecated in 3.0 | — | QB, QM, QP, QN, NI, ND, I, O, A, AC, CU,1 | Use QG, PI/PO, SL/QL instead |
| Driver support | saxi; legacy plotink | nextdraw requires 3.0.2+; saxi | Decide axya's floor (§10) |

Commands that behave the same in 2.6+ and 3.x, and are enough for a minimal portable driver:
- V, EM, SM/XM, LM (with non-negative rates), HM, SP, SC 4/5/11/12, SR, QC
- QS/CS (2.4.3+), QT/ST/RB (2.5.4/2.5.5+), QG bits 0–5 (2.6.2+)

---

## 10. Recommendations for axya's TypeScript serial layer

1. **Discovery.**
   - Use Node `serialport` (as saxi does). List ports and match `vendorId`/`productId` against `04d8`/`fd92` case-insensitively, falling back to the manufacturer `SchmalzHaus*`.
   - Expose the USB `serialNumber` as the nickname for multi-machine selection; `ST` writes the nickname into that field.
   - On macOS, prefer `/dev/cu.*` paths.
   - Open with any baud rate (9600, like saxi).

2. **Handshake.**
   1. Flush input.
   2. Send `V\r` and wait for a line, with a 1 s timeout and one retry (as Bantam does).
   3. Accept the line if it contains `EBB`. It may start with `V,` if a previous session left the board in future mode.
   4. Parse the version from the text after `Firmware Version `.
   5. Gate features on the version (§9). **Suggested floor: 3.0.2 for full support**, matching Bantam, with an optional legacy path for 2.6–2.8.1 boards in older AxiDraws.
   6. On 3.x, send `CU,10,1`, accept `\n`, `CU`, or `CUOK` as the reply, then flush.

3. **Framing.**
   - Keep **exactly one request in flight**, with a FIFO of pending promises (the saxi pattern) and a per-request deadline (the Bantam pattern).
   - Split incoming data on `/[\r\n]+/` and drop empty lines.
   - In future mode, a reply matches if it equals the uppercase command name or starts with `NAME,`.
   - Treat `NAME,!N Err:` (future) or a leading `!` (legacy) as an error, and in legacy mode consume the trailing `OK`.
   - Log and drop unsolicited lines rather than handing them to the pending request.
   - Send commands in uppercase.

4. **Timeouts and retries.**
   - Size each deadline to the expected FIFO wait: when the FIFO is full, a reply can take up to the remaining duration of the move ahead of it. Bantam effectively allows about 26 s.
   - **Never resend a motion or state-changing command after a timeout.** Only re-read. Re-send queries only after confirming the link is alive.
   - As Bantam does, latch the first error and stop the session instead of trying to resynchronize mid-plot.
   - Don't poll in a tight loop: sleep 10–50 ms between `QG` polls.

5. **Which commands to use for which job (v3).**
   - **Setup:** `CU,10,1`; `CU,4,<n ≤ QU,2>`; `CU,60,135` then `QG`; optionally `CU,50,0` and `CU,3,1`; `SC,4`/`SC,5`/`SC,11`/`SC,12`/`SC,8`; `SR`.
   - **Motors:** `QE` before `EM`, so a needless EM doesn't wipe the step counters.
   - **Motion:** `T3`/`TD` with host-side prediction ported from `ebb_calc.py` using `BigInt`, or `LM` (exact step counts, simpler math), or `SM` for simple moves and delays.
   - **Pen:** `SP,0`/`SP,1` with a duration.
   - **Status:** `QG` (idle = `& 0x0F`, plus bits 5, 6, 7). `QS` after idle for position. `QU,6` for queue depth.
   - **Pause:** stop feeding, send `SP,3`, wait for idle, restore `SC,5`.
   - **Hard stop:** `ES` (`ES,1` to also free the motors), then `QS`.
   - **Homing** (on models with switches): Bantam's CU,51/52 sequence.
   - **Persistent machine state:** `SL`/`QL` using Bantam's slot map (§4.1), so axya and `nextdraw` don't disagree about pen calibration, homed status, or origin offsets.

6. **Avoid:**
   - Deprecated: `QM`, `QB`, `QP`, `QN`/`NI`/`ND`, `I`/`O`, `A`/`AC`, `CU,1`, and negative LM rates.
   - Removed: `T`, `PC`, `PG`.
   - Test and debug only: `TR`, `CU,250`–`257`, `MW`.
   - `CU,53`, unless the reader can route asynchronous lines.
   - `ST` in any automated loop (flash wear).
   - `HM` for drawing.
   - `CU,2,0`, which hides errors.

7. **Testing without hardware.** The protocol is line-based, so the framing layer can be unit-tested against a fake duplex stream that replays recorded legacy and future transcripts, including the `\n\r` endings, the `CU,10` replies, and the error lines in §2.3. On real hardware, `CK` exercises the board's own parameter parser. As CLAUDE.md notes, there is no hardware mock, so anything that moves the machine needs a real plotter.
