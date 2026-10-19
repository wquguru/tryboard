# Xtensa core self-tests and QEMU differential

```sh
cd core && cargo test -p tryboard-xtensa -- --nocapture
```

- `build.sh` uses `xtensa-esp32s3-elf-gcc` to link each `<name>.S` with `common.S` into `build/<name>.elf` (`cargo test` calls it first).
- Each test provides a windowed function `test_main` that checks itself with `EXPECT` (returning the failing case number) and uses `DUMP reg` to append values for comparison to the dump buffer.
- `common.S`: vector table (window overflow / underflow, level 2–7 interrupts, User / Kernel / Double exceptions), a generic interrupt handler (logs to `irq_log`, clears the matching INTENABLE bit and returns), and an exception handler (records EXCCAUSE and a count, skips the faulting instruction; with `cp_lazy` set, a coprocessor-disabled exception enables CPENABLE and retries, like FreeRTOS).
- At the end, SIMCALL semihosting calls print `result`, the dump length and its contents, then SYS_exit.

## Differential against QEMU

When Espressif's QEMU is installed (`~/.espressif/tools/qemu-xtensa/*/qemu/bin/qemu-system-xtensa`, via `idf_tools.py install qemu-xtensa`),
the test runner also runs the same ELF on

```
qemu-system-xtensa -M sim -cpu esp32s3 -icount shift=0,sleep=off -nographic -monitor none \
  -semihosting-config enable=on,target=native -device loader,file=<elf>,cpu-num=0
```

takes its stdout (the semihosting output), compares it byte for byte with ours and prints the first few mismatches. QEMU only runs as a separate process for comparison.

| Environment variable | Effect |
|---|---|
| `XT_NO_QEMU=1` | Skip QEMU, self-check only |
| `XT_ONLY=fp` | Run only one test |
| `XT_SAVE=1` | Save both raw outputs as `build/<name>.{ours,qemu}.bin` for offline analysis |

Differences between the sim machine and a real S3 (handled in the tests): PRID reads 0; ATOMCTL resets to 0x28, which makes S32C1I fault on bypass memory (the tests set it to 0x2a);
CCOUNT advances with 40 MHz virtual time (the tests don't print raw CCOUNT).

## Tests

| Test | Covers |
|---|---|
| alu / shift / muldiv / mem / branch / loop / misc / window | Slice 1 base ISA and register windows |
| irq | Software interrupts level 1/3, INTLEVEL / EXCM masking, CCOMPARE0/1/2, WAITI wake-up, INTSET / INTCLEAR |
| fp | FPU: add / sub / mul over all pairs of 18 special values × 4 rounding modes, fused multiply-add / subtract, FSR flags, conversions, compares, conditional moves, loads / stores, coprocessor-disabled exception, libgcc `__divsf3` / libm sqrtf instruction sequences |
| mac16 | MAC16 four operand sources, ACC wrap-around, LDINC/LDDEC; SALT/SALTU; region protection TLB instructions |
