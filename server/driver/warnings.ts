/*
 * Plot warnings: collected during a run and reported once at the end.
 *
 * Ported from nextdrawcore/plot_warnings.py (nextdraw 1.7.5),
 * docs/reference-apps/nextdraw-1.7.5/nextdrawcore/plot_warnings.py.
 * Copyright 2025 Windell H. Oskay, Bantam Tools.
 * Licensed under the GNU General Public License v2 or (at your option) any
 * later version; distributed here under AGPL-3.0 as part of axya.
 */

/** Location phrase for a layer named in a warning. */
export function layerNameText(layerName: string): string {
  if (layerName === "__digest-root__") return " found in the document root.";
  if (layerName.trim() === "") return ".";
  return " in a layer named " + layerName.trim() + ".";
}

/**
 * Keys used by nextdraw: voltage, homing_voltage, bounds (value: model name),
 * image and text (value: layer name), and any unsupported SVG element's local
 * name (value: layer name).
 */
export class PlotWarnings {
  /** First occurrence of each warning type, in insertion order. */
  warning_dict = new Map<string, string>();
  suppress_list: string[] = [];

  reset(): void {
    this.warning_dict.clear();
  }

  has(name: string): boolean {
    return this.warning_dict.has(name);
  }

  addNew(name: string, value = "1"): void {
    if (!this.warning_dict.has(name)) this.warning_dict.set(name, value);
  }

  /** nextdraw's name for addNew (the motion planner calls it this way). */
  add_new(name: string, value = "1"): void {
    this.addNew(name, value);
  }

  suppress(name: string): void {
    this.suppress_list.push(name);
  }

  /** Formatted messages; consumes the reported entries, as nextdraw does. */
  returnTextList(): string[] {
    const out: string[] = [];
    const d = this.warning_dict;
    const suppressed = (name: string) => this.suppress_list.includes(name);
    if (suppressed("__all__")) return out;

    if (d.has("homing_voltage")) {
      if (!suppressed("homing_voltage")) {
        out.push(
          "Automatic homing failed with an apparent power issue.\n" +
            "Check that your machine is plugged in and powered on.\n"
        );
      }
      d.delete("homing_voltage");
      d.delete("voltage");
    } else if (d.has("voltage")) {
      if (!suppressed("voltage")) {
        out.push(
          "Note (voltage): Low voltage detected.\n" +
            "Check that power supply is plugged in and machine is powered on.\n"
        );
      }
      d.delete("voltage");
    }
    if (d.has("bounds")) {
      if (!suppressed("bounds")) {
        out.push(
          "Warning (bounds):\n" +
            "NextDraw movement was limited by its physical range of motion.\n" +
            "If everything else looks correct, there may be an issue with the\n" +
            "document size, or you may have the wrong model of plotter\n" +
            `(${d.get("bounds")}) selected.` +
            "\nPlease contact technical support if you need assistance.\n"
        );
      }
      d.delete("bounds");
    }
    if (d.has("image")) {
      if (!suppressed("image")) {
        out.push(
          "Note (image): This file contains a bitmap image" +
            layerNameText(d.get("image") as string) +
            "\nPlease convert images to vectors before plotting." +
            "\nConsider using the Inkscape Path > Trace Bitmap tool.\n"
        );
      }
      d.delete("image");
    }
    if (d.has("text")) {
      if (!suppressed("text")) {
        out.push(
          "Note (plain-text): This file contains some plain text\n" +
            layerNameText(d.get("text") as string) +
            "\nPlease convert text into vector paths before plotting." +
            "\nConsider using the Inkscape Path > Object to Path tool." +
            "\nAlternately, consider using NextDraw Merge or Hershey Text" +
            "\nto render your text with stroke-based fonts.\n"
        );
      }
      d.delete("text");
    }
    for (const [objectType, layer] of d) {
      if (suppressed(objectType)) continue;
      out.push(
        "Note (object): Unable to plot " +
          objectType +
          " object" +
          layerNameText(layer) +
          "\nPlease convert it to a path prior to plotting, and/or " +
          "contact technical support if you need assistance.\n"
      );
    }
    return out;
  }

  report(suppress: boolean, message: (text: string) => void): void {
    if (suppress) return;
    for (const text of this.returnTextList()) message(text);
  }
}
