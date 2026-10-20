# TryBoard F-07a acceptance script: written to flash over raw-paste, run after a soft reset.
# It is sent in 128-byte raw-paste windows, so the UART RX path must take a full FIFO at once.
import time


def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


def primes(limit):
    sieve = bytearray([1] * (limit + 1))
    sieve[0] = sieve[1] = 0
    for i in range(2, int(limit ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, limit + 1, i):
                sieve[j] = 0
    return [i for i in range(limit + 1) if sieve[i]]


def digest(text):
    # 32-bit polynomial hash; the checker computes the same value on the host
    h = 0
    for c in text:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return h


src = open("main.py").read()
print("mpy self", len(src), digest(src))
print("mpy fib", fib(30))
p = primes(1000)
print("mpy primes", len(p), sum(p))
words = "the quick brown fox jumps over the lazy dog".split()
print("mpy words", len(words), " ".join(sorted(set(words))))
t0 = time.ticks_ms()
for i in range(3):
    print("mpy tick", i)
    time.sleep_ms(100)
print("mpy dt", time.ticks_diff(time.ticks_ms(), t0) // 100)
print("mpy done")
