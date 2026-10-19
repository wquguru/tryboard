// Split out of templates.ts (R-12) so the bench ruler reads it without loading every assembly template.

/** How much warmer than the room a sensor next to the chip reads (estimate of ESP32-S3 in-case rise, not calibrated) */
export const CHIP_HEAT_OFFSET = 2.5;
