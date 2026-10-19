/* Self-test linker script: one flat RAM 0x40000000..0x40100000. Vectors sit at the bottom (VECBASE reset value);
   the L32R literal pool precedes the code because L32R can only load from lower addresses. */
ENTRY(_start)
SECTIONS
{
  . = 0x40000000;
  .vectors : { KEEP(*(.vectors)) }
  . = 0x40000400;
  .literal : { *(.literal .literal.*) }
  .text : { *(.text .text.*) }
  . = 0x40080000;
  .data : { *(.data .data.*) *(.rodata .rodata.*) *(.bss .bss.*) *(COMMON) }
}
