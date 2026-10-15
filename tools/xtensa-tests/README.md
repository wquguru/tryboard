# Xtensa 核自检与 QEMU 差分

```sh
cd core && cargo test -p tryboard-xtensa -- --nocapture
```

- `build.sh` 用 `xtensa-esp32s3-elf-gcc` 把每个 `<名字>.S` 与 `common.S` 链接成 `build/<名字>.elf`（`cargo test` 会先调用它）。
- 每个测试提供窗口函数 `test_main`，用 `EXPECT` 自检（返回失败用例号），用 `DUMP reg` 把要对照的值追加到 dump 缓冲区。
- `common.S`：向量表（窗口溢出 / 下溢、level 2–7 中断、User / Kernel / Double 异常）、通用中断处理（记 `irq_log`、关掉对应 INTENABLE 位后返回）、异常处理（记 EXCCAUSE 与次数、跳过出错指令；`cp_lazy` 打开时对协处理器禁用异常像 FreeRTOS 一样打开 CPENABLE 后重试）。
- 结束时经 SIMCALL 半主机调用输出 `result`、dump 长度与内容，然后 SYS_exit。

## 与 QEMU 差分

本机装了乐鑫 QEMU（`~/.espressif/tools/qemu-xtensa/*/qemu/bin/qemu-system-xtensa`，`idf_tools.py install qemu-xtensa`）时，
测试运行器把同一个 ELF 放到

```
qemu-system-xtensa -M sim -cpu esp32s3 -icount shift=0,sleep=off -nographic -monitor none \
  -semihosting-config enable=on,target=native -device loader,file=<elf>,cpu-num=0
```

上跑，取 stdout（半主机输出）与我们的输出逐字比较，打印前几处不一致。QEMU 只作独立进程的对照。

| 环境变量 | 作用 |
|---|---|
| `XT_NO_QEMU=1` | 不跑 QEMU，只自检 |
| `XT_ONLY=fp` | 只跑一个测试 |
| `XT_SAVE=1` | 两边原始输出存成 `build/<名字>.{ours,qemu}.bin` 便于离线分析 |

sim 机器与真 S3 的差别（测试里已处理）：PRID 读 0；ATOMCTL 复位 0x28 使 S32C1I 在旁路内存上异常（测试设成 0x2a）；
CCOUNT 按 40MHz 虚拟时间走（测试不输出原始 CCOUNT）。

## 测试

| 测试 | 内容 |
|---|---|
| alu / shift / muldiv / mem / branch / loop / misc / window | 切片 1 的基础 ISA 与窗口 |
| irq | 软件中断 level 1/3、INTLEVEL / EXCM 屏蔽、CCOMPARE0/1/2、WAITI 唤醒、INTSET / INTCLEAR |
| fp | FPU：18 个特殊值两两组合 × 4 种舍入模式的加减乘、乘加 / 减、FSR 标志、转换、比较、条件传送、装载存储、协处理器禁用异常、libgcc `__divsf3` / libm sqrtf 的指令序列 |
| mac16 | MAC16 四种来源、ACC 回绕、LDINC/LDDEC；SALT/SALTU；区域保护 TLB 指令 |
