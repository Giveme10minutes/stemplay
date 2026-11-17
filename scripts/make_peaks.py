#!/usr/bin/env python3
"""从分轨 wav 生成 web/peaks.json，供前端绘制静态波形。"""
import json
import struct
import sys
import wave
from pathlib import Path

STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]
PEAKS_PER_SECOND = 50

def main():
    src_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "separated/htdemucs_6s/test_song")
    out_path = Path(sys.argv[2] if len(sys.argv) > 2 else "web/peaks.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    stems = [n for n in STEM_ORDER if (src_dir / f"{n}.wav").exists()]
    stems += sorted(p.stem for p in src_dir.glob("*.wav") if p.stem not in stems)

    result = {}
    for name in stems:
        path = src_dir / f"{name}.wav"
        with wave.open(str(path)) as w:
            rate = w.getframerate()
            n_frames = w.getnframes()
            n_channels = w.getnchannels()
            samples = struct.unpack(f"<{n_frames * n_channels}h", w.readframes(n_frames))

        bucket_size = rate / PEAKS_PER_SECOND
        n_buckets = int(n_frames / bucket_size)
        peaks = []
        mono_min = mono_max = 0
        bucket = 0
        for i, s in enumerate(samples):
            if s < mono_min:
                mono_min = s
            elif s > mono_max:
                mono_max = s
            if (i + 1) % n_channels == 0:
                bucket += 1
                if bucket >= bucket_size:
                    peaks.extend((round(mono_min / 32768, 4), round(mono_max / 32768, 4)))
                    mono_min = mono_max = 0
                    bucket = 0
        if bucket > 0:
            peaks.extend((round(mono_min / 32768, 4), round(mono_max / 32768, 4)))

        result[name] = {
            "peaks": peaks,
            "duration": round(n_frames / rate, 3),
            "rate": rate,
        }
        print(f"{name}: {n_buckets} buckets, {len(peaks)} values")

    out_path.write_text(json.dumps(result, separators=(",", ":")))
    print(f"written {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

if __name__ == "__main__":
    main()
