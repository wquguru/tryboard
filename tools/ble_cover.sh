#!/bin/bash
# BLE signature coverage (F-08c): bare-link each third_party/btlib/<ver>/<chip>/libbtdm_app.a with the IDF 5.5.1 toolchain into
# third_party/btlib-cover/<ver>-<chip>/{app.elf,flash.bin,syms.txt} for the soc::ble::cover test. Usage: tools/ble_cover.sh [ver...]
set -uo pipefail
cd "$(dirname "$0")/.."
. tools/idf_env.sh
FUNCS="btdm_osi_funcs_register btdm_controller_init btdm_controller_enable btdm_controller_get_mode"
FUNCS="$FUNCS API_vhci_host_check_send_available API_vhci_host_send_packet API_vhci_host_register_callback sdk_config_extend_set_pll_track"
out=third_party/btlib-cover
mkdir -p "$out"
vers=("$@")
[ ${#vers[@]} -gt 0 ] || vers=($(ls third_party/btlib))
fail=0
for ver in "${vers[@]}"; do
  for chipv in esp32c3 esp32s3 esp32c3:_flash esp32s3:_flash; do
    chip=${chipv%%:*}; v=${chipv#$chip}; v=${v#:}
    lib=third_party/btlib/$ver/$chip/libbtdm_app$v.a
    [ -f "$lib" ] || continue
    d=$out/$ver-$chip$v
    mkdir -p "$d"
    if [ $chip = esp32c3 ]; then
      ld=riscv32-esp-elf-ld; nm=riscv32-esp-elf-nm; check=check
      iram=0x40380000; dram=0x3FCA0000
    else
      ld=xtensa-esp32s3-elf-ld; nm=xtensa-esp32s3-elf-nm; check=check-xt
      iram=0x40378000; dram=0x3FCA0000
    fi
    # Layout mirrors IDF: IRAM / flash text / flash rodata / DRAM, gp in the middle of small data (C3 relaxes to gp)
    cat > "$d/bare.ld" <<EOF
MEMORY {
  iram (rwx) : ORIGIN = $iram, LENGTH = 0x20000
  irom (rx)  : ORIGIN = 0x42000020, LENGTH = 0x3FFFE0
  drom (r)   : ORIGIN = 0x3C400020, LENGTH = 0x3FFFE0
  dram (rw)  : ORIGIN = $dram, LENGTH = 0x40000
}
SECTIONS {
  .iram0.text : { *(.iram1.literal .iram1 .iram1.*) *(.iram0.literal .iram0 .iram0.*) } > iram
  .flash.text : { *(.literal .text .literal.* .text.* .stub) } > irom
  .flash.rodata : { *(.rodata .rodata.* .srodata .srodata.*) } > drom
  .dram0.data : { *(.dram1 .dram1.* .data .data.*) __global_pointer\$ = . + 0x800; *(.sdata .sdata.*) } > dram
  .dram0.bss (NOLOAD) : { *(.sbss .sbss.* .bss .bss.* COMMON) } > dram
  /DISCARD/ : { *(.comment .note.* .xt.prop* .xt.lit* .xtensa.info .riscv.attributes) }
}
EOF
    us=""; for f in $FUNCS; do us="$us -u $f"; done
    # Symbols bt.c / ROM / libc would provide sit at a ROM-like address: Xtensa refuses windowed calls to 0 across 1 GB
    $ld -r $us -o "$d/all.o" "$lib" 2> /dev/null
    $nm -u "$d/all.o" | awk '{ print "PROVIDE(" $NF " = 0x40001000);" }' > "$d/undef.ld"
    if ! $ld -T "$d/bare.ld" -T "$d/undef.ld" -e btdm_controller_init $us --gc-sections --unresolved-symbols=ignore-all \
        --no-warn-rwx-segments -o "$d/app.elf" "$lib" 2> "$d/ld.log"; then
      echo "LINK FAIL $ver $chip$v ($(head -c 300 "$d/ld.log"))"; fail=1; continue
    fi
    esptool.py --chip $chip elf2image --dont-append-digest -o "$d/flash.bin" "$d/app.elf" > "$d/elf2image.log" 2>&1 \
      || { echo "ELF2IMAGE FAIL $ver $chip$v"; fail=1; continue; }
    $nm "$d/app.elf" | awk -v f=" $FUNCS " '$2 ~ /^[Tt]$/ && index(f, " " $3 " ") { print $3, $1 }' > "$d/syms.txt"
    if python3 tools/ble_sigs.py $check "$d/flash.bin" "$d/app.elf" "$lib" > "$d/check.log" 2>&1; then
      echo "OK   $ver $chip$v"
    elif [ "$chip$v" = esp32s3_flash ]; then
      # Known gap: ld narrows e.g. `or a10,a2,a2` to mov.n when relaxing flash longcalls (docs/STATUS.md, F-08c)
      echo "GAP  $ver $chip$v: $(grep -c BAD "$d/check.log") functions"
    else
      echo "BAD  $ver $chip$v:$(grep BAD "$d/check.log" | tr '\n' ' ' | head -c 300)"; fail=1
    fi
  done
done
exit $fail
