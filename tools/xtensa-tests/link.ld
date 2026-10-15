/* 自检测试的链接脚本：一块平坦 RAM 0x40000000..0x40100000。
   向量在最低处（VECBASE 复位值），L32R 字面量池在代码之前（L32R 只能向低地址取）。 */
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
