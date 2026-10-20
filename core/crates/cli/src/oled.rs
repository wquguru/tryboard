//! End-of-run OLED summary for the CLI (SSD1306, SH1106 from F-04b)

use tryboard_machine::Machine;

/// OLED summary (SSD1306 / SH1106) at the end of a run; `--oled` adds the ASCII sketch
pub fn report_oled(m: &mut Machine, args: &[String]) {
    let show_oled = args.iter().any(|a| a == "--oled");
    if let Some(o) = m.oled() {
        let n = o.lit_pixels();
        eprintln!(
            "[tryboard] OLED lit pixels {n} (display {}, charge pump {})",
            if o.display_on { "on" } else { "off" },
            if o.charge_pump { "on" } else { "off" }
        );
        if show_oled {
            eprint!("{}", o.ascii());
        }
    }
    // Same summary line as SSD1306 so accept.sh's oled_min_pixels applies; the DC-DC takes the charge pump's place
    if let Some(o) = m.sh1106() {
        let n = o.lit_pixels();
        eprintln!(
            "[tryboard] OLED lit pixels {n} (display {}, DC-DC {}, SH1106, non-SH1106 commands {})",
            if o.display_on { "on" } else { "off" },
            if o.dc_dc { "on" } else { "off" },
            o.foreign_cmds
        );
        if show_oled {
            eprint!("{}", o.ascii());
        }
    }
}
