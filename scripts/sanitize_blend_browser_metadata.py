#!/usr/bin/env python3
"""Clear stored review metadata in a Blender 5.0.2 .blend.

Uses only Python's standard library. Zstandard-compressed input additionally
requires the `zstd` executable (or --zstd PATH). Output is a normal uncompressed
.blend, preserving every byte except FileSelectParams.dir's fixed-size arrays.
Optional --view-matcaps also replaces obsolete JPEG viewport matcap references
with Blender's built-in basic_1.exr and clears unused bytes in those arrays,
plus JPEG remnants after the first NUL in the studio_light array.
The deliberately narrow format checks reject other formats instead of guessing.

Usage:
    python3 sanitize_blend_browser_metadata.py input.blend output.blend
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess

EXPECTED_HEADER = b"BLENDER17-01v0502"
BLOCK_HEADER = struct.Struct("<4sIQQII")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_blend(path, zstd):
    data = path.read_bytes()
    if data.startswith(EXPECTED_HEADER):
        return data
    require(data.startswith(b"\x28\xb5\x2f\xfd"), "Unsupported input signature")
    executable = zstd or shutil.which("zstd")
    require(executable, "Compressed input requires zstd; use --zstd PATH")
    return subprocess.run([executable, "--decompress", "--stdout", str(path)],
                          check=True, stdout=subprocess.PIPE).stdout


def read_blocks(data):
    require(data.startswith(EXPECTED_HEADER), "Unsupported Blender file header")
    blocks = []
    offset = len(EXPECTED_HEADER)
    while offset < len(data):
        require(offset + BLOCK_HEADER.size <= len(data), "Truncated block header")
        code, dna_index, address, size, count, padding = BLOCK_HEADER.unpack_from(data, offset)
        start = offset + BLOCK_HEADER.size
        end = start + size
        require(end <= len(data), "Truncated block payload")
        blocks.append(dict(code=code, dna_index=dna_index, offset=offset,
                           start=start, end=end, size=size, count=count))
        offset = end
        if code == b"ENDB":
            require(size == 0 and offset == len(data), "Invalid final ENDB block")
            break
    require(blocks and blocks[-1]["code"] == b"ENDB", "Missing ENDB block")
    return blocks


def read_dna(data):
    cursor = 0

    def take(size):
        nonlocal cursor
        require(cursor + size <= len(data), "Truncated SDNA")
        result = data[cursor:cursor + size]
        cursor += size
        return result

    def integer():
        return struct.unpack("<I", take(4))[0]

    def marker(expected):
        require(take(4) == expected, "Unexpected SDNA section")

    def align():
        nonlocal cursor
        cursor = (cursor + 3) // 4 * 4

    def strings():
        nonlocal cursor
        result = []
        for _ in range(integer()):
            end = data.index(0, cursor)
            result.append(data[cursor:end].decode("ascii"))
            cursor = end + 1
        align()
        return result

    marker(b"SDNA")
    marker(b"NAME")
    names = strings()
    marker(b"TYPE")
    types = strings()
    marker(b"TLEN")
    lengths = struct.unpack("<" + "H" * len(types), take(2 * len(types)))
    align()
    marker(b"STRC")
    structures = []
    for _ in range(integer()):
        type_index, field_count = struct.unpack("<HH", take(4))
        fields = [struct.unpack("<HH", take(4)) for _ in range(field_count)]
        structures.append((type_index, fields))
    require(cursor == len(data), "Trailing data in SDNA")
    return names, types, lengths, structures


def sanitize(data, reset_view_matcaps=False):
    blocks = read_blocks(data)
    dna_blocks = [b for b in blocks if b["code"] == b"DNA1"]
    require(len(dna_blocks) == 1, "Expected one DNA1 block")
    dna = dna_blocks[0]
    names, types, lengths, structures = read_dna(data[dna["start"]:dna["end"]])
    layouts = []
    for dna_index, (type_index, fields) in enumerate(structures):
        if types[type_index] != "FileSelectParams":
            continue
        offset = 0
        directory = None
        for field_type, field_name in fields:
            name = names[field_name]
            dimensions = re.findall(r"\[(\d+)\]", name)
            size = (8 if "*" in name else lengths[field_type]) * math.prod(map(int, dimensions))
            if re.fullmatch(r"dir\[\d+\]", name):
                require(types[field_type] == "char", "Directory is not a character array")
                directory = (offset, size)
            offset += size
        require(offset == lengths[type_index], "Unexpected FileSelectParams layout/padding")
        require(directory is not None, "FileSelectParams.dir is missing")
        layouts.append((dna_index, lengths[type_index], directory))
    require(len(layouts) == 1, "Expected one FileSelectParams definition")
    dna_index, record_size, (field_offset, field_size) = layouts[0]
    output = bytearray(data)
    ranges = []
    expected = {}
    for block in blocks:
        if block["code"] != b"DATA" or block["dna_index"] != dna_index:
            continue
        require(block["size"] == block["count"] * record_size,
                "FileSelectParams block size does not match SDNA")
        for record_index in range(block["count"]):
            start = block["start"] + record_index * record_size + field_offset
            end = start + field_size
            output[start:end] = b"/" + b"\0" * (field_size - 1)
            ranges.append((start, end))
            expected[(start, end)] = bytes(output[start:end])
    require(ranges, "No stored FileSelectParams directory found")
    directory_ranges = list(ranges)
    matcap_ranges = []
    studio_tail_ranges = []
    if reset_view_matcaps:
        def structure(type_name):
            matches = [(index, type_index, fields)
                       for index, (type_index, fields) in enumerate(structures)
                       if types[type_index] == type_name]
            require(len(matches) == 1, "Expected one " + type_name + " definition")
            index, type_index, fields = matches[0]
            offset = 0
            layout = {}
            for field_type, field_name in fields:
                name = names[field_name]
                count = math.prod(map(int, re.findall(r"\[(\d+)\]", name)))
                size = (8 if "*" in name else lengths[field_type]) * count
                layout[name] = (offset, size, types[field_type])
                offset += size
            require(offset == lengths[type_index], "Unexpected " + type_name + " layout/padding")
            return index, offset, layout

        view_index, view_size, view_fields = structure("View3D")
        _, shading_size, shading_fields = structure("View3DShading")
        require("shading" in view_fields, "View3D.shading is missing")
        shading_offset, embedded_size, embedded_type = view_fields["shading"]
        require(embedded_type == "View3DShading" and embedded_size == shading_size,
                "Unexpected embedded viewport shading layout")
        require("matcap[256]" in shading_fields, "Expected fixed matcap[256] field")
        matcap_offset, matcap_size, matcap_type = shading_fields["matcap[256]"]
        require(matcap_type == "char" and matcap_size == 256, "Unexpected matcap field type")
        require("studio_light[256]" in shading_fields, "Expected fixed studio_light[256] field")
        studio_offset, studio_size, studio_type = shading_fields["studio_light[256]"]
        require(studio_type == "char" and studio_size == 256, "Unexpected studio light field type")
        replacement = b"basic_1.exr" + b"\0" * (matcap_size - len(b"basic_1.exr"))
        for block in blocks:
            if block["code"] != b"DATA" or block["dna_index"] != view_index:
                continue
            require(block["size"] == block["count"] * view_size,
                    "View3D block size does not match SDNA")
            for index in range(block["count"]):
                start = block["start"] + index * view_size + shading_offset + matcap_offset
                end = start + matcap_size
                # Includes stale bytes beyond the first NUL in a fixed C array.
                if re.search(rb"\.jpe?g(?:\0|$)", data[start:end], re.IGNORECASE):
                    output[start:end] = replacement
                    ranges.append((start, end))
                    matcap_ranges.append((start, end))
                    expected[(start, end)] = replacement
                studio_start = block["start"] + index * view_size + shading_offset + studio_offset
                studio_end = studio_start + studio_size
                nul = data[studio_start:studio_end].find(b"\0")
                if nul < 0:
                    continue
                tail_start = studio_start + nul + 1
                if not re.search(rb"\.jpe?g(?:\0|$)", data[tail_start:studio_end], re.IGNORECASE):
                    continue
                # Preserve the effective name and its first NUL byte exactly.
                clean_tail = b"\0" * (studio_end - tail_start)
                output[tail_start:studio_end] = clean_tail
                ranges.append((tail_start, studio_end))
                studio_tail_ranges.append((tail_start, studio_end))
                expected[(tail_start, studio_end)] = clean_tail
    output = bytes(output)
    require(len(output) == len(data), "File length changed")
    require(read_blocks(output) == blocks, "Block boundaries or headers changed")
    last = 0
    for start, end in sorted(ranges):
        require(data[last:start] == output[last:start], "Bytes outside directory arrays changed")
        require(output[start:end] == expected[(start, end)], "Invalid sanitized review field")
        last = end
    require(data[last:] == output[last:], "Bytes outside directory arrays changed")
    changed_blocks = sum(data[b["start"]:b["end"]] != output[b["start"]:b["end"]] for b in blocks)
    report = {
        "format": EXPECTED_HEADER.decode("ascii"),
        "output_encoding": "uncompressed Blender (.blend)",
        "byte_length": len(data),
        "block_count": len(blocks),
        "changed_block_count": changed_blocks,
        "directory_field": "FileSelectParams.dir",
        "sanitized_ranges": [{"offset": start, "length": end - start} for start, end in directory_ranges],
        "matcap_field": "View3D.shading.matcap[256]",
        "matcap_replacement": "basic_1.exr",
        "sanitized_matcap_ranges": [{"offset": start, "length": end - start} for start, end in matcap_ranges],
        "studio_tail_field": "View3D.shading.studio_light[256] after first NUL",
        "sanitized_studio_tail_ranges": [{"offset": start, "length": end - start} for start, end in studio_tail_ranges],
        "changed_byte_count": sum(a != b for a, b in zip(data, output)),
        "all_other_bytes_identical": True,
        "source_uncompressed_sha256": hashlib.sha256(data).hexdigest(),
        "output_sha256": hashlib.sha256(output).hexdigest(),
    }
    return output, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--zstd", help="Path to the optional zstd executable")
    parser.add_argument("--view-matcaps", action="store_true",
                        help="Replace obsolete JPEG matcaps and clear JPEG remnants after the studio light name")
    args = parser.parse_args()
    require(args.input.resolve() != args.output.resolve(), "Use a separate output file")
    require(not args.output.exists(), "Output already exists; refusing to overwrite")
    data = load_blend(args.input, args.zstd)
    output, report = sanitize(data, reset_view_matcaps=args.view_matcaps)
    with args.output.open("xb") as handle:
        handle.write(output)
    require(args.output.read_bytes() == output, "Output failed readback verification")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
