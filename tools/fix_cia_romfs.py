"""Fixes the RomFS block size in a CIA made by makerom v0.19.0.

That makerom builds the RomFS hash tree (IVFC) from 4 KB blocks but writes 2 KB (log2 = 11)
into the header. The console checks reads against the header's size, every check fails, and
libctru can't mount romfs ("romfsInit 0xF8A07FFA"). This sets the header to 4 KB (log2 = 12,
what real titles use) after confirming the tree really is 4 KB, then updates the hashes that
cover it: the NCCH RomFS superblock hash and the TMD content hashes checked when installing.
Signatures are left as they are (homebrew CIAs are unsigned; CFW skips signature checks).
Does nothing when the CIA is already consistent.

shortcut: works around a makerom bug; drop it once makerom writes the right block size.
Usage: python tools/fix_cia_romfs.py showdown3ds.cia
"""
import hashlib
import struct
import sys

BLOCK_LOG2 = 12
BLOCK = 1 << BLOCK_LOG2


def align(x, a):
    return (x + a - 1) // a * a


def sha(b):
    return hashlib.sha256(b).digest()


def tree_ok(romfs, block):
    """Checks master hash -> L1 -> L2 -> L3, assuming makerom's layout: L3 at 0x1000, then L1, L2."""
    mhs = struct.unpack_from("<I", romfs, 8)[0]
    sizes = [struct.unpack_from("<QQI", romfs, 12 + i * 24)[1] for i in range(3)]
    p3 = align(0x60 + mhs, block)
    p1 = align(p3 + sizes[2], block)
    p2 = align(p1 + sizes[0], block)
    levels = [romfs[p1:p1 + sizes[0]], romfs[p2:p2 + sizes[1]], romfs[p3:p3 + sizes[2]]]
    parents = [romfs[0x60:0x60 + mhs], levels[0], levels[1]]
    for data, hashes in zip(levels, parents):
        for i in range(0, len(data), block):
            if sha(data[i:i + block].ljust(block, b"\0")) != hashes[i // block * 32:i // block * 32 + 32]:
                return False
    return True


def main(path):
    cia = bytearray(open(path, "rb").read())
    hdr_size, _, _, cert, tik, tmd, _, content_size = struct.unpack_from("<IHHIIIIQ", cia, 0)
    tmd_off = align(align(align(hdr_size, 64) + cert, 64) + tik, 64)
    content_off = align(tmd_off + tmd, 64)
    ncch = content_off
    assert cia[ncch + 0x100:ncch + 0x104] == b"NCCH", "first content isn't an NCCH"
    rom_off, rom_size, sb_size = (x * 0x200 for x in struct.unpack_from("<III", cia, ncch + 0x1B0))
    romfs_at = ncch + rom_off
    romfs = cia[romfs_at:romfs_at + rom_size]
    assert romfs[:4] == b"IVFC", "no IVFC RomFS"

    log2s = [struct.unpack_from("<I", romfs, 12 + i * 24 + 16)[0] for i in range(3)]
    if log2s == [BLOCK_LOG2] * 3 and tree_ok(romfs, BLOCK):
        print("RomFS block size already correct; nothing to do")
        return
    assert tree_ok(romfs, BLOCK), "hash tree isn't built from 4 KB blocks either; not touching it"

    for i in range(3):
        struct.pack_into("<I", cia, romfs_at + 12 + i * 24 + 16, BLOCK_LOG2)
    # NCCH header: hash of the RomFS superblock (holds the IVFC header).
    cia[ncch + 0x1E0:ncch + 0x200] = sha(cia[romfs_at:romfs_at + sb_size])

    # TMD: content chunk hash -> content info record hash -> header hash. Signature type 0x10004
    # (RSA-2048) = 0x140 bytes of signature block before the header.
    assert struct.unpack_from(">I", cia, tmd_off)[0] == 0x10004, "unexpected TMD signature type"
    th = tmd_off + 0x140
    count = struct.unpack_from(">H", cia, th + 0x9E)[0]
    assert count == 1, "expected one content"
    info = th + 0xC4
    chunks = info + 0x24 * 64
    assert struct.unpack_from(">Q", cia, chunks + 8)[0] == content_size
    cia[chunks + 0x10:chunks + 0x30] = sha(cia[content_off:content_off + content_size])
    cia[info + 4:info + 0x24] = sha(cia[chunks:chunks + 0x30 * count])
    cia[th + 0xA4:th + 0xC4] = sha(cia[info:info + 0x24 * 64])

    fixed = cia[romfs_at:romfs_at + rom_size]
    assert tree_ok(fixed, BLOCK) and [struct.unpack_from("<I", fixed, 12 + i * 24 + 16)[0] for i in range(3)] == [BLOCK_LOG2] * 3
    open(path, "wb").write(cia)
    print(f"fixed RomFS block size in {path} (was log2 {log2s})")


if __name__ == "__main__":
    main(sys.argv[1])
