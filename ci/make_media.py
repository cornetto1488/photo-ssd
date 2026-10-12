"""Создаёт тестовые картинки BMP (потом sips превращает их в JPEG/HEIC)."""
import random
import struct
import sys

out = sys.argv[1]
count = int(sys.argv[2])


def bmp(path, w, h, seed):
    random.seed(seed)
    r, g, b = random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)
    pad = b"\0" * ((4 - (w * 3) % 4) % 4)
    rows = bytearray()
    for y in range(h):
        for x in range(w):
            rows += bytes(((b + x) % 256, (g + y) % 256, (r + x + y) % 256))
        rows += pad
    data = bytes(rows)
    hdr = b"BM" + struct.pack("<IHHI", 54 + len(data), 0, 0, 54)
    dib = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    with open(path, "wb") as f:
        f.write(hdr + dib + data)


for i in range(count):
    bmp(f"{out}/src{i}.bmp", 640, 480, i)
