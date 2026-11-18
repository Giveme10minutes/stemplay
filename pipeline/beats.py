"""节拍估计（第 3 轮）：纯 NumPy，鼓轨 onset 驱动 + 全曲 onset 兜底。

方法（全部可解释，写入 beats.json）：
1. tempo：onset 包络自相关 + 梳状滤波（谐波求和）选周期，抛物线插值细化到亚帧。
2. 拍点：逐帧动态规划（onset 强度为收益、间隔对数偏差为代价，允许跳拍），
   回溯得到 onset 优先、tempo 一致的拍点序列——不是等间隔伪造网格。
3. 启发式可用性评分 = 加权和（周期性 / 间隔稳定性 / 网格覆盖率 / tempo 裕度），
   权重与分量全部输出。它是启发式评分，不是准确概率。
4. 评分不足 / 拍点太少 / 静音 → snapEnabled=false，前端继续用能量与起音特征。
5. 不标注重拍（downbeats=null）：普通拍点不冒充重拍。

时间基准：拍点秒数 = originSec + 帧号 / frameRate，与特征同一网格。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .contract import atomic_write_json

DEFAULT_BEAT_PARAMS = {
    "bpmRange": [60.0, 180.0],
    "snapThreshold": 0.55,
    "minBeats": 8,
    "evidenceRel": 0.10,       # onset 候选阈值（相对包络 p95）
    "intervalWindow": [0.5, 2.0],  # DP 允许的间隔/周期比（2.0 允许跳一拍）
    "intervalPenalty": 10.0,       # 惩罚 = penalty × ln(间隔/周期)²（抑制细分/抖动）
    "coverageTolerance": 0.15,   # 网格覆盖判定容差（周期比例）
    "scoreWeights": {
        "periodicity": 0.35,
        "intervalStability": 0.25,
        "gridCoverage": 0.25,
        "tempoMargin": 0.15,
    },
}


def beat_params(track: dict) -> dict:
    params = {**DEFAULT_BEAT_PARAMS, **((track.get("analysisConfig") or {}).get("beats") or {})}
    params["scoreWeights"] = {
        **DEFAULT_BEAT_PARAMS["scoreWeights"],
        **(params.get("scoreWeights") or {}),
    }
    lo, hi = params["bpmRange"]
    if not (30 <= lo < hi <= 300):
        raise ValueError(f"beats.bpmRange 非法: {params['bpmRange']}")
    if not (0 <= params["snapThreshold"] <= 1):
        raise ValueError("beats.snapThreshold 必须在 [0,1]")
    return params


def _degraded(reason: str, params: dict, frame_rate: float, origin_sec: float,
              bpm: float | None = None, components: dict | None = None) -> dict:
    weights = params["scoreWeights"]
    # 先按全部权重初始化 0，再合并调用方传入的部分分量——
    # 任何降级路径都输出完整 scoreComponents，不因缺键崩溃。
    comp = {k: 0.0 for k in weights}
    comp.update(components or {})
    score = float(sum(weights[k] * comp[k] for k in weights))
    return {
        "bpm": bpm,
        "periodSec": 60.0 / bpm if bpm else None,
        "beatsSec": [],
        "snapEnabled": False,
        "heuristicScore": round(score, 4),
        "scoreComponents": {k: round(float(v), 4) for k, v in comp.items()},
        "degradedReason": reason,
    }


def estimate_beats(env: np.ndarray, frame_rate: float, params: dict,
                   origin_sec: float = 0.0) -> dict:
    """env: 非负 onset 包络（特征帧率网格）。返回 beats.json 的分析部分。"""
    n = len(env)
    p95 = float(np.percentile(env, 95)) if n else 0.0
    if n < 32 or p95 <= 1e-9:
        return _degraded("silence-or-too-short", params, frame_rate, origin_sec)

    e = env / p95
    e = e - e.mean()
    ac_full = np.correlate(e, e, mode="full")[n - 1 :]
    if ac_full[0] <= 0:
        return _degraded("no-variance", params, frame_rate, origin_sec)
    ac = ac_full / ac_full[0]

    bpm_lo, bpm_hi = params["bpmRange"]
    lag_min = max(2, int(frame_rate * 60.0 / bpm_hi))
    lag_max = min(int(frame_rate * 60.0 / bpm_lo), n // 4)
    if lag_max <= lag_min:
        return _degraded("too-short-for-bpm-range", params, frame_rate, origin_sec)

    lags = np.arange(lag_min, lag_max + 1)
    harm_limit = min(n // 2, 4 * lag_max)
    comb = np.array([
        sum(ac[k * L] for k in range(1, harm_limit // L + 1)) for L in lags
    ])
    best = int(np.argmax(comb))
    L = int(lags[best])

    # 抛物线插值细化周期（亚帧精度）
    L_frac = float(L)
    if 0 < L < len(ac) - 1:
        denom = ac[L - 1] - 2 * ac[L] + ac[L + 1]
        if abs(denom) > 1e-12:
            delta = 0.5 * (ac[L - 1] - ac[L + 1]) / denom
            L_frac = L + float(np.clip(delta, -1.0, 1.0))
    period_sec = L_frac / frame_rate
    bpm = 60.0 / period_sec

    # tempo 裕度：排除倍频/半频亲属后的次优梳状分差
    relatives = (L, L / 2, L * 2, L / 3, L * 3)
    mask = np.ones(len(lags), dtype=bool)
    for rel in relatives:
        mask &= np.abs(lags - rel) > 0.08 * rel
    if mask.any():
        second = float(comb[mask].max())
        margin = float(np.clip((comb[best] - second) / max(comb[best], 1e-9), 0, 1))
    else:
        margin = 0.5
    periodicity = float(np.clip(ac[L], 0, 1))

    # onset 候选：超过证据阈值的局部峰
    thresh = params["evidenceRel"]
    interior = (e[1:-1] >= e[:-2]) & (e[1:-1] >= e[2:])
    cand = np.flatnonzero(interior & (e[1:-1] > thresh)) + 1
    if len(cand) < params["minBeats"]:
        return _degraded(
            "too-few-onsets", params, frame_rate, origin_sec,
            bpm=round(bpm, 2),
            components={"periodicity": periodicity, "tempoMargin": margin},
        )

    # 动态规划：逐帧搜索（与 librosa 同思路），onset 强度为收益、间隔偏差为代价，
    # 回溯得到 onset 优先、tempo 一致的拍点序列；弱证据区按周期内插而非断路。
    P = L_frac
    lo_w, hi_w = params["intervalWindow"]
    lam = params["intervalPenalty"]
    weights = np.clip(e, 0, 1)
    lo_i, hi_i = max(1, int(np.floor(lo_w * P))), max(2, int(np.ceil(hi_w * P)))
    dp = weights.copy()
    back = np.full(n, -1, dtype=np.int64)
    for i in range(lo_i, n):
        j0, j1 = max(0, i - hi_i), i - lo_i + 1
        if j1 <= j0:
            continue
        js = np.arange(j0, j1)
        costs = lam * np.log((i - js) / P) ** 2
        vals = dp[js] - costs
        k = int(np.argmax(vals))
        if vals[k] > 0:
            dp[i] = weights[i] + vals[k]
            back[i] = js[k]
    end = int(np.argmax(dp))
    path = []
    cur = end
    while cur != -1:
        path.append(cur)
        cur = int(back[cur])
    path.reverse()
    beat_frames = np.array(path, dtype=np.int64)
    beats_sec = origin_sec + beat_frames / frame_rate

    if len(beats_sec) < params["minBeats"]:
        return _degraded(
            "dp-path-too-short", params, frame_rate, origin_sec,
            bpm=round(bpm, 2),
            components={"periodicity": periodicity, "tempoMargin": margin},
        )

    intervals = np.diff(beat_frames) / frame_rate
    med = float(np.median(intervals))
    mad = float(np.median(np.abs(intervals - med)))
    stability = float(np.clip(1 - mad / max(med, 1e-9), 0, 1))

    # 网格覆盖率：期望拍位（相位取自实际拍点中位数）附近有 onset 证据的比例
    m = len(cand)
    phase = float(np.median(beat_frames % P))
    grid = np.arange(phase, n, P)
    tol = params["coverageTolerance"] * P
    pos = np.searchsorted(cand, grid)
    matched = np.zeros(len(grid), dtype=bool)
    for side in (pos - 1, pos):
        ok = (side >= 0) & (side < m)
        idx = np.clip(side, 0, m - 1)
        matched |= ok & (np.abs(cand[idx] - grid) <= tol)
    coverage = float(matched.mean()) if len(grid) else 0.0

    components = {
        "periodicity": periodicity,
        "intervalStability": stability,
        "gridCoverage": coverage,
        "tempoMargin": margin,
    }
    w = params["scoreWeights"]
    score = float(sum(w[k] * components[k] for k in w))
    snap = bool(
        score >= params["snapThreshold"]
        and len(beats_sec) >= params["minBeats"]
        and bpm_lo <= bpm <= bpm_hi
    )
    candidates = []
    for idx in np.argsort(comb)[-3:][::-1]:
        candidates.append({
            "bpm": round(60.0 * frame_rate / float(lags[idx]), 2),
            "combScore": round(float(comb[idx]), 4),
        })
    return {
        "bpm": round(bpm, 2),
        "periodSec": round(period_sec, 6),
        "beatsSec": [round(float(t), 4) for t in beats_sec],
        "snapEnabled": snap,
        "heuristicScore": round(score, 4),
        "scoreComponents": {k: round(float(v), 4) for k, v in components.items()},
        "degradedReason": None if snap else "score-below-threshold",
        "tempoCandidates": candidates,
    }


def run_beats(out_dir: Path) -> dict:
    from .manifest import load_manifest, sync_manifest

    out_dir = Path(out_dir).resolve()
    manifest = load_manifest(out_dir)
    track = manifest["track"]
    params = beat_params(track)

    feats = {}
    for stem in track["stems"]:
        mount = stem["features"]
        if mount["status"] != "ready":
            raise RuntimeError(f"{stem['id']}: 特征缺失，请先运行 features 阶段")
        feats[stem["id"]] = json_load(out_dir / mount["path"])

    frame_rate = track["analysis"]["frameRate"]
    source = "drums.onset"
    if "drums" in feats:
        env = np.array(feats["drums"]["arrays"]["onset"], dtype=np.float64)
        if float(np.percentile(env, 95)) <= 1e-9:
            env = np.sum(
                [np.array(f["arrays"]["onset"], dtype=np.float64) for f in feats.values()], axis=0
            )
            source = "all-stems-onset-sum(drums-silent)"
    else:
        env = np.sum(
            [np.array(f["arrays"]["onset"], dtype=np.float64) for f in feats.values()], axis=0
        )
        source = "all-stems-onset-sum(no-drums)"

    result = estimate_beats(env, frame_rate, params, track["originSec"])
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "beats",
        "pipelineVersion": PIPELINE_VERSION,
        "trackId": track["id"],
        "originSec": track["originSec"],
        "frameRate": frame_rate,
        "source": source,
        "sourceFeaturesSha256": {
            sid: stem["features"]["sha256"]
            for sid, stem in ((s["id"], s) for s in track["stems"])
        },
        "analysisParams": params,
        "downbeats": None,
        "note": "heuristicScore 为启发式可用性评分（非概率）；拍点为 onset 对齐估计，不伪造等间隔网格，不标注重拍。snapEnabled=false 时前端继续使用能量/起音特征。",
        **result,
    }
    atomic_write_json(out_dir / "beats.json", doc, separators=(",", ":"))
    state = "snap 可用" if doc["snapEnabled"] else f"降级({doc['degradedReason']})"
    print(f"  节拍: bpm={doc['bpm']} 拍点={len(doc['beatsSec'])} score={doc['heuristicScore']} {state}")
    return sync_manifest(out_dir)


def json_load(path: Path):
    import json

    return json.loads(Path(path).read_text(encoding="utf-8"))