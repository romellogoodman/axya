/**
 * EiBotBoard (EBB) WebSerial Driver
 *
 * Handles serial communication with AxiDraw pen plotters via the WebSerial API.
 * The EBB is the USB-based motion controller inside AxiDraw plotters.
 */

import { XYMotion, PenMotion, Device } from "./planning.js";

// USB Vendor/Product IDs for EiBotBoard
const EBB_VENDOR_ID = 0x04d8;
const EBB_PRODUCT_ID = 0xfd92;

/**
 * Split a number into its fractional and integer parts
 */
function modf(d) {
  const intPart = Math.floor(d);
  const fracPart = d - intPart;
  return [fracPart, intPart];
}

/**
 * EBB Serial Driver
 */
export class EBB {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.readBuffer = "";

    // Microstepping mode (1-5, where 1 = 16x microstepping)
    this.microsteppingMode = 0;

    // Accumulated XY error for sub-step correction
    this.error = { x: 0, y: 0 };

    // Cached firmware version
    this.cachedFirmwareVersion = null;

    // Abort controller for cancellation
    this.abortController = null;
  }

  /**
   * Get the step multiplier based on microstepping mode
   */
  get stepMultiplier() {
    switch (this.microsteppingMode) {
      case 5:
        return 1;
      case 4:
        return 2;
      case 3:
        return 4;
      case 2:
        return 8;
      case 1:
        return 16;
      default:
        throw new Error(`Invalid microstepping mode: ${this.microsteppingMode}`);
    }
  }

  /**
   * Connect to an EBB device via WebSerial
   */
  static async connect() {
    if (!navigator.serial) {
      throw new Error(
        "WebSerial API not supported. Please use Chrome or Edge browser."
      );
    }

    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: EBB_VENDOR_ID, usbProductId: EBB_PRODUCT_ID }],
    });

    await port.open({ baudRate: 9600 });

    const ebb = new EBB(port);
    await ebb.setupStreams();

    return ebb;
  }

  /**
   * Set up read/write streams
   */
  async setupStreams() {
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readBuffer = "";
  }

  /**
   * Close the connection
   */
  async close() {
    if (this.reader) {
      await this.reader.cancel();
      this.reader.releaseLock();
      this.reader = null;
    }
    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }
    if (this.port) {
      await this.port.close();
    }
  }

  /**
   * Write a string to the serial port
   */
  async write(str) {
    const encoder = new TextEncoder();
    await this.writer.write(encoder.encode(str));
  }

  /**
   * Read a line from the serial port
   */
  async readLine() {
    const decoder = new TextDecoder();

    while (true) {
      // Check if we already have a complete line
      const newlineIdx = this.readBuffer.indexOf("\r");
      if (newlineIdx !== -1) {
        const line = this.readBuffer.slice(0, newlineIdx);
        this.readBuffer = this.readBuffer.slice(newlineIdx + 1);
        // Skip empty lines and lone newlines
        if (line && line !== "\n") {
          return line.replace(/\n/g, "");
        }
      }

      // Read more data
      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error("Serial port closed unexpectedly");
      }
      this.readBuffer += decoder.decode(value);
    }
  }

  /**
   * Send a command and wait for OK response
   */
  async command(cmd) {
    await this.write(`${cmd}\r`);
    const response = await this.readLine();
    if (response !== "OK") {
      throw new Error(`Expected OK, got: ${response}`);
    }
  }

  /**
   * Send a query and return single-line response
   */
  async query(cmd) {
    await this.write(`${cmd}\r`);
    return await this.readLine();
  }

  /**
   * Send a query that returns multiple lines terminated by OK
   */
  async queryM(cmd) {
    await this.write(`${cmd}\r`);
    const results = [];
    while (true) {
      const line = await this.readLine();
      if (line === "OK") break;
      results.push(line);
    }
    return results;
  }

  /**
   * Enable motors with specified microstepping mode (1-5)
   */
  async enableMotors(microsteppingMode = 2) {
    if (microsteppingMode < 1 || microsteppingMode > 5) {
      throw new Error(
        `Microstepping mode must be between 1 and 5, got ${microsteppingMode}`
      );
    }
    this.microsteppingMode = microsteppingMode;
    await this.command(`EM,${microsteppingMode},${microsteppingMode}`);

    // Enable servo power if supported
    if (await this.supportsSR()) {
      await this.setServoPowerTimeout(0, true);
    }
  }

  /**
   * Disable motors
   */
  async disableMotors() {
    await this.command("EM,0,0");

    // Disable servo power if supported
    if (await this.supportsSR()) {
      await this.setServoPowerTimeout(60000, false);
    }
  }

  /**
   * Set servo power timeout
   */
  async setServoPowerTimeout(timeout, power) {
    const cmd =
      power !== undefined
        ? `SR,${Math.floor(timeout * 1000)},${power ? 1 : 0}`
        : `SR,${Math.floor(timeout * 1000)}`;
    await this.command(cmd);
  }

  /**
   * Set pen height via servo
   */
  async setPenHeight(height, rate = 0, delay = 0) {
    await this.command(`S2,${height},4,${rate},${delay}`);
  }

  /**
   * Low-level move command (LM) for constant-acceleration motion
   */
  async lowlevelMove(
    stepsAxis1,
    initialRateAxis1,
    finalRateAxis1,
    stepsAxis2,
    initialRateAxis2,
    finalRateAxis2
  ) {
    const [initialRate1, deltaR1] = this.axisRate(
      stepsAxis1,
      initialRateAxis1,
      finalRateAxis1
    );
    const [initialRate2, deltaR2] = this.axisRate(
      stepsAxis2,
      initialRateAxis2,
      finalRateAxis2
    );
    await this.command(
      `LM,${initialRate1},${stepsAxis1},${deltaR1},${initialRate2},${stepsAxis2},${deltaR2}`
    );
  }

  /**
   * Move with acceleration in XY coordinates
   *
   * Transforms XY steps to axis coordinates (A1 = X+Y, A2 = X-Y)
   */
  async moveWithAcceleration(xSteps, ySteps, initialRate, finalRate) {
    if (xSteps === 0 && ySteps === 0) {
      throw new Error("Must move on at least one axis");
    }
    if (initialRate < 0 || finalRate < 0) {
      throw new Error(`Rates must be positive, got ${initialRate}, ${finalRate}`);
    }
    if (initialRate === 0 && finalRate === 0) {
      throw new Error("Must have non-zero velocity during motion");
    }

    // Transform XY to dual-motor axis coordinates
    const stepsAxis1 = xSteps + ySteps;
    const stepsAxis2 = xSteps - ySteps;

    // Calculate per-axis velocities
    const norm = Math.sqrt(xSteps ** 2 + ySteps ** 2);
    const normX = xSteps / norm;
    const normY = ySteps / norm;

    const initialRateX = initialRate * normX;
    const initialRateY = initialRate * normY;
    const finalRateX = finalRate * normX;
    const finalRateY = finalRate * normY;

    const initialRateAxis1 = Math.abs(initialRateX + initialRateY);
    const initialRateAxis2 = Math.abs(initialRateX - initialRateY);
    const finalRateAxis1 = Math.abs(finalRateX + finalRateY);
    const finalRateAxis2 = Math.abs(finalRateX - finalRateY);

    await this.lowlevelMove(
      stepsAxis1,
      initialRateAxis1,
      finalRateAxis1,
      stepsAxis2,
      initialRateAxis2,
      finalRateAxis2
    );
  }

  /**
   * Constant-velocity move using XM command (fallback for older firmware)
   */
  async moveAtConstantRate(duration, x, y) {
    await this.command(`XM,${Math.floor(duration * 1000)},${x},${y}`);
  }

  /**
   * Wait until motors are idle
   */
  async waitUntilMotorsIdle() {
    while (true) {
      const response = await this.query("QM");
      const [, commandStatus, , , fifoStatus] = response.split(",");
      if (commandStatus === "0" && fifoStatus === "0") {
        break;
      }
    }
  }

  /**
   * Execute a single motion block
   */
  async executeBlock(block) {
    // Calculate steps with sub-step error correction
    const [errX, stepsX] = modf(
      (block.p2.x - block.p1.x) * this.stepMultiplier + this.error.x
    );
    const [errY, stepsY] = modf(
      (block.p2.y - block.p1.y) * this.stepMultiplier + this.error.y
    );

    this.error.x = errX;
    this.error.y = errY;

    if (stepsX !== 0 || stepsY !== 0) {
      await this.moveWithAcceleration(
        stepsX,
        stepsY,
        block.vInitial * this.stepMultiplier,
        block.vFinal * this.stepMultiplier
      );
    }
  }

  /**
   * Execute an XY motion (sequence of blocks)
   */
  async executeXYMotion(motion) {
    for (const block of motion.blocks) {
      await this.executeBlock(block);
    }
  }

  /**
   * Execute a pen motion
   */
  async executePenMotion(pm) {
    const delay = Math.round(pm.duration() * 1000);
    await this.setPenHeight(pm.finalPos, 0, delay);
  }

  /**
   * Execute a single motion (XY or Pen)
   */
  async executeMotion(motion) {
    if (motion instanceof XYMotion) {
      await this.executeXYMotion(motion);
    } else if (motion instanceof PenMotion) {
      await this.executePenMotion(motion);
    } else {
      throw new Error(`Unknown motion type: ${motion.constructor.name}`);
    }
  }

  /**
   * Execute a complete plan
   *
   * @param {Plan} plan - The motion plan to execute
   * @param {Object} options - Execution options
   * @param {Function} options.onProgress - Progress callback (index, total)
   * @param {AbortSignal} options.signal - Abort signal for cancellation
   */
  async executePlan(plan, options = {}) {
    const { onProgress, signal } = options;

    await this.enableMotors(2);

    try {
      for (let i = 0; i < plan.motions.length; i++) {
        // Check for abort
        if (signal?.aborted) {
          throw new Error("Plot aborted");
        }

        await this.executeMotion(plan.motions[i]);

        if (onProgress) {
          onProgress(i + 1, plan.motions.length);
        }
      }

      await this.waitUntilMotorsIdle();
    } finally {
      await this.disableMotors();
    }
  }

  /**
   * Query firmware version string
   */
  async firmwareVersion() {
    return await this.query("V");
  }

  /**
   * Get firmware version as [major, minor, patch]
   */
  async firmwareVersionNumber() {
    if (this.cachedFirmwareVersion === null) {
      const versionString = await this.firmwareVersion();
      const versionWords = versionString.split(" ");
      const [major, minor, patch] = versionWords[versionWords.length - 1]
        .split(".")
        .map(Number);
      this.cachedFirmwareVersion = [major, minor, patch];
    }
    return this.cachedFirmwareVersion;
  }

  /**
   * Compare firmware version with given version
   * Returns -1 if older, 0 if equal, 1 if newer
   */
  async firmwareVersionCompare(major, minor, patch) {
    const [fwMajor, fwMinor, fwPatch] = await this.firmwareVersionNumber();
    if (fwMajor < major) return -1;
    if (fwMajor > major) return 1;
    if (fwMinor < minor) return -1;
    if (fwMinor > minor) return 1;
    if (fwPatch < patch) return -1;
    if (fwPatch > patch) return 1;
    return 0;
  }

  /**
   * Check if firmware supports LM command (2.5.3+)
   */
  async supportsLM() {
    return (await this.firmwareVersionCompare(2, 5, 3)) >= 0;
  }

  /**
   * Check if firmware supports SR command (2.6.0+)
   */
  async supportsSR() {
    return (await this.firmwareVersionCompare(2, 6, 0)) >= 0;
  }

  /**
   * Query voltages to check if stepper power is connected
   */
  async queryVoltages() {
    const [response] = await this.queryM("QC");
    const [ra0Voltage, vPlusVoltage] = response.split(",").map(Number);
    return [
      (ra0Voltage / 1023.0) * 3.3,
      (vPlusVoltage / 1023.0) * 3.3,
      (vPlusVoltage / 1023.0) * 3.3 * 9.2 + 0.3,
    ];
  }

  /**
   * Check if steppers are powered
   */
  async areSteppersPowered() {
    const [, , vInVoltage] = await this.queryVoltages();
    return vInVoltage > 6;
  }

  /**
   * Query button state
   */
  async queryButton() {
    const [response] = await this.queryM("QB");
    return response === "1";
  }

  /**
   * Calculate axis rate parameters for LM command
   */
  axisRate(steps, initialStepsPerSec, finalStepsPerSec) {
    if (steps === 0) return [0, 0];

    const SCALE = 0x80000000 / 25000;
    const initialRate = Math.round(initialStepsPerSec * SCALE);
    const finalRate = Math.round(finalStepsPerSec * SCALE);
    const moveTime =
      (2 * Math.abs(steps)) / (initialStepsPerSec + finalStepsPerSec);
    const deltaR = Math.round((finalRate - initialRate) / (moveTime * 25000));

    return [initialRate, deltaR];
  }

  /**
   * Move pen to up position
   */
  async penUp(height = 50) {
    const pos = Device.penPctToPos(height);
    await this.setPenHeight(pos, 0, 150);
  }

  /**
   * Move pen to down position
   */
  async penDown(height = 60) {
    const pos = Device.penPctToPos(height);
    await this.setPenHeight(pos, 0, 150);
  }
}
