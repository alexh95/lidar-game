#!/usr/bin/env python3
"""
Offline codec simulator for lidar-game (PLAN.md §6.3): how do dot styles survive the
headset's video stream?

Takes captures made by the game's `?capture=<name>` route (src/dev/capture.ts):
.captures/<name>/NNNN.png (one 2160² eye, 90 fps), capture.json and dots.json (where a
sample of dots lands in every frame). For each capture it:

  encode   encodes with NVENC (the hardware SteamVR is likely to use on this PC) at
           25/50/100/200 Mbps: H.264, HEVC and AV1 8-bit 4:2:0, and HEVC 10-bit, low-latency
           CBR with no B-frames and a two-frame buffer, BT.709 limited range;
  measure  decodes each and measures, after a warm-up (the first frames are an I-frame and
           rate control settling):
             - SSIM / PSNR on luma, over the whole frame (mostly black, so flattering) and
               over the 512² crop with the most dot texture;
             - dot survival: each tracked dot's peak luma after / before, median, 10th
               percentile and share lost (under half), overall and per distance band; and the
               same for its contrast against the pixels just around it;
             - shimmer: how much the coding error changes from frame to frame (the error's
               own frame difference; a still scene coded steadily scores 0), over the frame
               and the crop, and the same at the tracked dots;
  crops    cuts 144² regions (the densest, and one in the far field) from a late frame,
           source next to every encode, 3× nearest-neighbour, into crops_<region>.png;
  report   writes markdown tables over several captures (tables.md, tables_full.md) and, with
           --region-from <capture>, sheets of that capture's regions in every capture with the
           same view and motion (one row per style).

Usage (from the repo root; Python 3 with PIL, ffmpeg on PATH):
  python tools/codec/codec.py all hall-still-d25 hall-yaw30-d25
  python tools/codec/codec.py report "hall-*" --codecs hevc --out docs/codec --region-from hall-yaw30-d25
Results land in .captures/<name>/results.json; encodes in .captures/<name>/enc/.
"""

import argparse
import glob
import json
import math
import os
import statistics
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / '.captures'
RATES = [25, 50, 100, 200]
CODECS = {
    'hevc': {'enc': 'hevc_nvenc', 'fmt': 'yuv420p', 'extra': ['-profile:v', 'main'], 'label': 'HEVC'},
    'av1': {'enc': 'av1_nvenc', 'fmt': 'yuv420p', 'extra': [], 'label': 'AV1'},
    'h264': {'enc': 'h264_nvenc', 'fmt': 'yuv420p', 'extra': ['-profile:v', 'high'], 'label': 'H.264'},
    'hevc10': {'enc': 'hevc_nvenc', 'fmt': 'p010le', 'extra': ['-profile:v', 'main10'], 'label': 'HEVC 10-bit'},
}
WARMUP = 15  # frames left out of every metric
CROP = 512  # the dense crop for SSIM and shimmer
ZOOM_TILE = 144  # crop sheets: region size in eye pixels
ZOOM = 3

SWS = 'flags=accurate_rnd+full_chroma_int:sws_dither=none'
SRC_TO_YUV = f'scale=out_color_matrix=bt709:out_range=tv:{SWS},format={{fmt}}'
DEC_TO_YUV8 = f'scale={SWS},format=yuv420p'
DEC_TO_RGB = f'scale=in_color_matrix=bt709:in_range=tv:{SWS},format=rgb24'


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True)
    if r.returncode:
        sys.exit(f'command failed ({r.returncode}): {" ".join(map(str, cmd))}\n{r.stderr.decode(errors="replace")[-2000:]}')
    return r


def cap_dir(name):
    p = Path(name)
    return (p if p.is_dir() else CAPTURES / name).resolve()


def load_meta(cap):
    return json.loads((cap / 'capture.json').read_text())


def src_input(cap, meta):
    return ['-framerate', str(meta['fps']), '-start_number', '1', '-i', str(cap / '%04d.png')]


def variants(codecs, rates):
    return [(c, r) for c in codecs for r in rates]


# ---------------------------------------------------------------- encode


def encode_one(cap, meta, codec, rate, force=False):
    out = cap / 'enc' / f'{codec}_{rate}.mp4'
    if out.exists() and not force:
        return out
    out.parent.mkdir(exist_ok=True)
    c = CODECS[codec]
    buf = 2 * rate / meta['fps']  # two frames of bits: a low-latency stream's buffer
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *src_input(cap, meta),
           '-vf', SRC_TO_YUV.format(fmt=c['fmt']), '-c:v', c['enc'], *c['extra'],
           '-preset', 'p4', '-tune', 'ull', '-rc', 'cbr', '-b:v', f'{rate}M', '-maxrate', f'{rate}M',
           '-bufsize', f'{buf:.3f}M', '-bf', '0', '-g', '9999',
           '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', str(out)]
    run(cmd)
    return out


def cmd_encode(caps, codecs, rates, force):
    for cap in caps:
        meta = load_meta(cap)
        # NVENC runs a few sessions at once; PNG decoding is the slow part.
        with ThreadPoolExecutor(3) as ex:
            list(ex.map(lambda v: encode_one(cap, meta, *v, force=force), variants(codecs, rates)))
        print(f'{cap.name}: encoded {len(codecs) * len(rates)} variants', flush=True)


# ---------------------------------------------------------------- luma frames and dots


def y_frames(cmd, size):
    """Yield each frame's luma plane (bytes, size² values, BT.709 limited range) from an ffmpeg pipe."""
    frame = size * size * 3 // 2
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            buf = p.stdout.read(frame)
            if len(buf) < frame:
                break
            yield buf[: size * size]
    finally:
        p.stdout.close()
        p.wait()


def full(y):
    """Limited-range luma code to full-range 0..255."""
    return max(0.0, (y - 16) * (255 / 219))


def dot_peaks(y, size, row, n):
    """Per tracked dot: (peak, background) luma around where it lands, or None if off screen."""
    out = [None] * n
    for i in range(n):
        x = row[5 * i]
        if x < 0:
            continue
        px = row[5 * i + 3]
        r = max(1, int(px * 0.5 + 0.5))
        rb = r + 1
        cx = min(max(int(x), rb), size - 1 - rb)
        cy = min(max(int(row[5 * i + 1]), rb), size - 1 - rb)
        peak = 0
        for yy in range(cy - r, cy + r + 1):
            o = yy * size + cx
            m = max(y[o - r: o + r + 1])
            if m > peak:
                peak = m
        bg = 255
        for yy in range(cy - rb, cy + rb + 1):
            o = yy * size + cx
            m = min(y[o - rb: o + rb + 1])
            if m < bg:
                bg = m
        out[i] = (full(peak), full(bg))
    return out


def load_track(cap):
    d = json.loads((cap / 'dots.json').read_text())
    return d['track'], len(d['mats'])


def source_peaks(cap, meta, track, n):
    cache = cap / 'src_peaks.json'
    if cache.exists():
        return json.loads(cache.read_text())
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', *src_input(cap, meta), '-vf', SRC_TO_YUV.format(fmt='yuv420p'),
           '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']
    peaks = [dot_peaks(y, meta['size'], track[f], n) for f, y in enumerate(y_frames(cmd, meta['size']))]
    cache.write_text(json.dumps(peaks))
    return peaks


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(q * (len(s) - 1) + 0.5)))]


def summarise(ratios, cratios, flick, src_mean):
    return {
        'n': len(ratios),
        'med': pct(ratios, 0.5),
        'p10': pct(ratios, 0.1),
        'lost': (sum(1 for r in ratios if r < 0.5) / len(ratios)) if ratios else None,
        'cmed': pct(cratios, 0.5),
        'cp10': pct(cratios, 0.1),
        # Mean frame-to-frame change of the coding error at the dots, relative to their brightness.
        'flicker': (statistics.fmean(flick) / src_mean) if flick and src_mean else None,
    }


def dot_metrics(meta, track, n, src, dec):
    bands = [b if b is not None else math.inf for b in meta['bands']]
    nb = len(bands) - 1
    acc = [([], [], [], []) for _ in range(nb + 1)]  # per band (+ all): ratios, contrast ratios, flicker, src peaks

    def band(d):
        i = 0
        while i < nb - 1 and d >= bands[i + 1]:
            i += 1
        return i

    for f in range(WARMUP, min(len(src), len(dec))):
        row = track[f]
        for i in range(n):
            s = src[f][i]
            d = dec[f][i]
            if s is None or d is None:
                continue
            sp, sb = s
            if sp < max(16, 0.25 * row[5 * i + 4]):
                continue  # not really on screen (behind something, or not grown in yet)
            dp, db = d
            for a in (acc[band(row[5 * i + 2])], acc[nb]):
                a[0].append(dp / sp)
                if sp - sb >= 16:
                    a[1].append((dp - db) / (sp - sb))
                a[3].append(sp)
            if f > WARMUP and src[f - 1][i] is not None and dec[f - 1][i] is not None and src[f - 1][i][0] >= 16:
                e = abs((dp - dec[f - 1][i][0]) - (sp - src[f - 1][i][0]))
                for a in (acc[band(row[5 * i + 2])], acc[nb]):
                    a[2].append(e)
    out = [summarise(a[0], a[1], a[2], statistics.fmean(a[3]) if a[3] else 0) for a in acc]
    return {'bands': out[:nb], 'all': out[nb]}


# ---------------------------------------------------------------- frame metrics (ffmpeg)


def pick_crop(cap, meta):
    """The CROP² square with the most dot texture (highest luma stddev) in the middle frame."""
    f = max(1, meta['frames'] // 2)
    img = Image.open(cap / f'{f:04d}.png').convert('L')
    best = None
    step = CROP // 4
    for y in range(0, meta['size'] - CROP + 1, step):
        for x in range(0, meta['size'] - CROP + 1, step):
            sd = ImageStat.Stat(img.crop((x, y, x + CROP, y + CROP))).stddev[0]
            if best is None or sd > best[0]:
                best = (sd, x, y)
    return {'x': best[1], 'y': best[2], 'w': CROP, 'h': CROP}


def parse_ssim(path):
    ys = []
    for line in Path(path).read_text().splitlines():
        for tok in line.split():
            if tok.startswith('Y:'):
                ys.append(float(tok[2:]))
    return statistics.fmean(ys) if ys else None


def parse_psnr(path):
    vals = []
    for line in Path(path).read_text().splitlines():
        for tok in line.split():
            if tok.startswith('psnr_y:'):
                v = tok[7:]
                vals.append(100.0 if v == 'inf' else float(v))
    return statistics.fmean(vals) if vals else None


def parse_yavg(path, scale=1.0):
    vals = [float(l.split('=')[1]) for l in Path(path).read_text().splitlines() if 'YAVG=' in l]
    return statistics.fmean(vals) * scale if vals else None


YAVG = 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file={}'
ERR = "blend=all_expr='(A-B)/2+128',tblend=all_mode=difference," + YAVG  # |e(t) - e(t-1)| / 2


def frame_metrics(cap, meta, enc, crop, work):
    work.mkdir(parents=True, exist_ok=True)
    C = f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}"
    trim = f'trim=start_frame={WARMUP},setpts=PTS-STARTPTS'
    g = (f'[0:v]{DEC_TO_YUV8},{trim},split=3[d0][d1][d2];'
         f'[1:v]{SRC_TO_YUV.format(fmt="yuv420p")},{trim},split=3[s0][s1][s2];'
         f'[d0][s0]ssim=stats_file=ssim.log,nullsink;'
         f'[d1]split[d1a][d1b];[s1]split[s1a][s1b];'
         f'[d1a][s1a]psnr=stats_file=psnr.log,nullsink;'
         f'[d1b][s1b]{ERR.format("eflick.log")},nullsink;'
         f'[d2]{C},split=3[c0][c1][c2];[s2]{C},split=2[t0][t1];'
         f'[c0][t0]ssim=stats_file=ssimc.log,nullsink;'
         f'[c1][t1]{ERR.format("eflickc.log")},nullsink;'
         f'[c2]tblend=all_mode=difference,{YAVG.format("tdiffc.log")}[out]')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(enc.resolve()),
         *src_input(cap, meta),
         '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], cwd=work)
    return {
        'ssim': parse_ssim(work / 'ssim.log'),
        'psnr': parse_psnr(work / 'psnr.log'),
        'ssim_crop': parse_ssim(work / 'ssimc.log'),
        'shimmer': parse_yavg(work / 'eflick.log', 2),
        'shimmer_crop': parse_yavg(work / 'eflickc.log', 2),
        'tdiff_crop': parse_yavg(work / 'tdiffc.log'),
    }


def source_tdiff(cap, meta, crop, work):
    work.mkdir(parents=True, exist_ok=True)
    C = f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}"
    trim = f'trim=start_frame={WARMUP},setpts=PTS-STARTPTS'
    g = f'[0:v]{SRC_TO_YUV.format(fmt="yuv420p")},{trim},{C},tblend=all_mode=difference,{YAVG.format("src_tdiffc.log")}[out]'
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *src_input(cap, meta),
         '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], cwd=work)
    return parse_yavg(work / 'src_tdiffc.log')


def source_crop_mean(cap, res):
    """Mean luma of the source's dense crop (after warm-up), to put shimmer in proportion; cached in results.json."""
    src = res.setdefault('source', {})
    if src.get('mean_crop') is None:
        meta = res['capture']
        crop = res['crop']
        work = cap / 'work'
        work.mkdir(exist_ok=True)
        C = f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}"
        g = f'[0:v]{SRC_TO_YUV.format(fmt="yuv420p")},trim=start_frame={WARMUP},{C},{YAVG.format("src_meanc.log")}[out]'
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *src_input(cap, meta),
             '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], cwd=work)
        src['mean_crop'] = full(parse_yavg(work / 'src_meanc.log'))
        (cap / 'results.json').write_text(json.dumps(res, indent=1))
    return src['mean_crop']


def cmd_measure(caps, codecs, rates, force):
    for cap in caps:
        meta = load_meta(cap)
        if meta['frames'] < WARMUP + 10:
            sys.exit(f"{cap.name}: {meta['frames']} frames; measuring needs at least {WARMUP + 10} (the first {WARMUP} are warm-up)")
        res_path = cap / 'results.json'
        res = json.loads(res_path.read_text()) if res_path.exists() and not force else {}
        res['capture'] = meta
        res.setdefault('crop', pick_crop(cap, meta))
        work = cap / 'work'
        res['source'] = {'tdiff_crop': source_tdiff(cap, meta, res['crop'], work)}
        track, n = load_track(cap)
        src = source_peaks(cap, meta, track, n)
        res.setdefault('variants', {})
        todo = [(c, r) for c, r in variants(codecs, rates) if f'{c}_{r}' not in res['variants']]

        def one(v):
            c, r = v
            enc = encode_one(cap, meta, c, r)
            fm = frame_metrics(cap, meta, enc, res['crop'], work / f'{c}_{r}')
            cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(enc), '-vf', DEC_TO_YUV8, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']
            dec = [dot_peaks(y, meta['size'], track[f], n) for f, y in enumerate(y_frames(cmd, meta['size']))]
            mbps = enc.stat().st_size * 8 / (meta['frames'] / meta['fps']) / 1e6
            return f'{c}_{r}', {'codec': c, 'rate': r, 'mbps': round(mbps, 1), **fm, 'dots': dot_metrics(meta, track, n, src, dec)}

        with ThreadPoolExecutor(3) as ex:
            for key, v in ex.map(one, todo):
                res['variants'][key] = v
                a = v['dots']['all']
                print(f"{cap.name} {key}: ssim {v['ssim']:.4f} crop {v['ssim_crop']:.4f}  dots med {a['med']:.2f} p10 {a['p10']:.2f}"
                      f"  shimmer {v['shimmer_crop']:.3f}  {v['mbps']} Mbps", flush=True)
                res_path.write_text(json.dumps(res, indent=1))
        res_path.write_text(json.dumps(res, indent=1))


# ---------------------------------------------------------------- crops


def font(size=16):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def decoded_frame(enc, index, out):
    if not out.exists():
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(enc),
             '-vf', f'select=eq(n\\,{index}),{DEC_TO_RGB}', '-fps_mode', 'passthrough', '-frames:v', '1', str(out)])
    return Image.open(out).convert('RGB')


def pick_regions(cap, meta, frame):
    """Two ZOOM_TILE² regions in a frame: the most textured, and the most textured in the far field (8 m+)."""
    img = Image.open(cap / f'{frame:04d}.png').convert('L')
    track, n = load_track(cap)
    row = track[frame - 1]
    T = ZOOM_TILE
    step = T // 2
    best = {}
    for y in range(0, meta['size'] - T + 1, step):
        for x in range(0, meta['size'] - T + 1, step):
            sd = ImageStat.Stat(img.crop((x, y, x + T, y + T))).stddev[0]
            dists = [row[5 * i + 2] for i in range(n) if x <= row[5 * i] < x + T and y <= row[5 * i + 1] < y + T]
            if 'dense' not in best or sd > best['dense'][0]:
                best['dense'] = (sd, x, y)
            if len(dists) >= 3 and statistics.median(dists) >= 8 and ('far' not in best or sd > best['far'][0]):
                best['far'] = (sd, x, y)
    return {k: {'x': v[1], 'y': v[2], 'w': T, 'h': T} for k, v in best.items()}


def zoom(img, r):
    return img.crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h'])).resize((r['w'] * ZOOM, r['h'] * ZOOM), Image.NEAREST)


def sheet(rows, cols, tiles, title=None):
    """tiles[r][c] = PIL image (all the same size) or None; labels on top of columns and left of rows."""
    T = next(t for row in tiles for t in row if t is not None).size[0]
    gap, left, top = 6, 210, 28 + (30 if title else 0)
    W = left + len(cols) * (T + gap)
    H = top + len(rows) * (T + gap)
    out = Image.new('RGB', (W, H), (24, 24, 26))
    d = ImageDraw.Draw(out)
    f = font(18)
    if title:
        d.text((8, 6), title, fill=(220, 220, 220), font=font(20))
    for c, label in enumerate(cols):
        d.text((left + c * (T + gap) + 4, top - 24), label, fill=(200, 200, 200), font=f)
    for r, label in enumerate(rows):
        d.text((8, top + r * (T + gap) + 6), label, fill=(200, 200, 200), font=f)
        for c in range(len(cols)):
            t = tiles[r][c]
            if t is not None:
                out.paste(t, (left + c * (T + gap), top + r * (T + gap)))
    return out


def cmd_crops(caps, codecs, rates, frame=None):
    for cap in caps:
        meta = load_meta(cap)
        fr = frame or max(1, meta['frames'] * 2 // 3)
        res_path = cap / 'results.json'
        res = json.loads(res_path.read_text()) if res_path.exists() else {'capture': meta}
        regions = pick_regions(cap, meta, fr)
        res['regions'] = {'frame': fr, **regions}
        src = Image.open(cap / f'{fr:04d}.png').convert('RGB')
        frames = {}
        for c, r in variants(codecs, rates):
            enc = encode_one(cap, meta, c, r)
            frames[(c, r)] = decoded_frame(enc, fr - 1, cap / 'work' / f'{c}_{r}_f{fr}.png')
        for name, reg in regions.items():
            tiles = [[zoom(src, reg)] + [zoom(frames[(c, r)], reg) for r in rates] for c in codecs]
            img = sheet([CODECS[c]['label'] for c in codecs], ['source'] + [f'{r} Mbps' for r in rates], tiles,
                        f"{cap.name}: {name} region at ({reg['x']}, {reg['y']}), frame {fr}, {ZOOM}x")
            img.save(cap / f'crops_{name}.png')
        res_path.write_text(json.dumps(res, indent=1))
        print(f'{cap.name}: crops at frame {fr}: {", ".join(regions)}', flush=True)


# ---------------------------------------------------------------- report


def f2(v, d=2):
    return '–' if v is None else f'{v:.{d}f}'


def pc(v):
    return '–' if v is None else f'{v * 100:.1f}%'


def style_label(meta):
    s = meta['style']
    return f"{s['minPx']} px, {s['palette']}, {round(s['cell'] * 100, 1)} cm"


def cmd_report(caps, codecs, rates, out, region_from=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    results = [(cap, json.loads((cap / 'results.json').read_text())) for cap in caps]
    # 1. Everything, one row per capture, codec and rate.
    full = ['| Capture | Style | Codec | Mbps (used) | SSIM frame / crop | Dot peak med / p10 | Lost | Contrast med / p10 | Shimmer crop / frame | Dot flicker |',
            '|---|---|---|---|---|---|---|---|---|---|']
    for cap, res in results:
        meta = res['capture']
        for c in codecs:
            for r in rates:
                v = res['variants'].get(f'{c}_{r}')
                if not v:
                    continue
                a = v['dots']['all']
                full.append(f"| {cap.name} | {style_label(meta)} | {CODECS[c]['label']} | {r} ({v['mbps']}) | {f2(v['ssim'], 4)} / {f2(v['ssim_crop'], 3)} |"
                            f" {f2(a['med'])} / {f2(a['p10'])} | {pc(a['lost'])} |"
                            f" {f2(a['cmed'])} / {f2(a['cp10'])} | {f2(v['shimmer_crop'], 2)} / {f2(v['shimmer'], 2)} | {pc(a['flicker'])} |")
    (out / 'tables_full.md').write_text('\n'.join(full) + '\n', encoding='utf-8')

    # 2. Compact: per codec, one row per capture, one column per rate.
    lines = []
    for c in codecs:
        lines.append(f"**{CODECS[c]['label']}**: dot peak p10 · dots lost (under half) · shimmer (frame-to-frame change of the coding"
                     " error in the dense crop, relative to the crop's mean brightness)")
        lines.append('')
        lines.append('| Capture | Style | Motion | ' + ' | '.join(f'{r} Mbps' for r in rates) + ' |')
        lines.append('|---|---|---|' + '---|' * len(rates))
        for cap, res in results:
            meta = res['capture']
            mean = source_crop_mean(cap, res)
            cells = []
            for r in rates:
                v = res['variants'].get(f'{c}_{r}')
                if not v:
                    cells.append('–')
                    continue
                a = v['dots']['all']
                cells.append(f"{f2(a['p10'])} · {pc(a['lost'])} · {pc(v['shimmer_crop'] * 255 / 219 / mean if mean else None)}")
            lines.append(f"| {cap.name} | {style_label(meta)} | {meta['motion']} | " + ' | '.join(cells) + ' |')
        lines.append('')
    # 3. By distance band, for each capture at the first codec.
    for cap, res in results:
        meta = res['capture']
        bands = meta['bands']
        names = [f"{bands[i]}–{bands[i + 1]} m" if bands[i + 1] is not None else f"{bands[i]} m+" for i in range(len(bands) - 1)]
        lines.append(f"**{cap.name}** ({style_label(meta)}), {CODECS[codecs[0]]['label']}: dot peak median / p10 by distance (dots measured)")
        lines.append('')
        lines.append('| Mbps | ' + ' | '.join(names) + ' |')
        lines.append('|---|' + '---|' * len(names))
        for r in rates:
            v = res['variants'].get(f'{codecs[0]}_{r}')
            if not v:
                continue
            cells = [f"{f2(b['med'])} / {f2(b['p10'])} ({b['n']})" for b in v['dots']['bands']]
            lines.append(f'| {r} | ' + ' | '.join(cells) + ' |')
        lines.append('')
    (out / 'tables.md').write_text('\n'.join(lines), encoding='utf-8')
    print('\n'.join(lines))

    # 4. With --region-from: style sheets, the same region of every capture with that capture's view and
    #    motion, per codec, every rate.
    if region_from is None:
        return
    base_cap, base = next((c, r) for c, r in results if c.name == region_from)
    regs = base.get('regions')
    if not regs:
        return
    fr = regs['frame']
    for name in ('dense', 'far'):
        if name not in regs:
            continue
        reg = regs[name]
        for c in codecs:
            tiles = []
            labels = []
            for cap, res in results:
                meta = res['capture']
                if meta['motion'] != base['capture']['motion'] or meta['view'] != base['capture']['view']:
                    continue
                src = Image.open(cap / f'{fr:04d}.png').convert('RGB')
                row = [zoom(src, reg)]
                for r in rates:
                    enc = cap / 'enc' / f'{c}_{r}.mp4'
                    row.append(zoom(decoded_frame(enc, fr - 1, cap / 'work' / f'{c}_{r}_f{fr}.png'), reg) if enc.exists() else None)
                tiles.append(row)
                labels.append(style_label(meta))
            img = sheet(labels, ['source'] + [f'{r} Mbps' for r in rates], tiles,
                        f"{base['capture']['motion']}, {CODECS[c]['label']}: {name} region, frame {fr}, {ZOOM}x nearest")
            img.save(out / f"styles_{base['capture']['view']}_{base['capture']['motion']}_{c}_{name}.png")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['encode', 'measure', 'crops', 'report', 'all'])
    ap.add_argument('captures', nargs='+', help='names in .captures/ (globs allowed) or paths')
    ap.add_argument('--codecs', default=','.join(CODECS))
    ap.add_argument('--rates', default=','.join(map(str, RATES)))
    ap.add_argument('--force', action='store_true', help='redo encodes and measurements')
    ap.add_argument('--out', default=str(ROOT / 'docs' / 'codec'), help='report: where tables and sheets go')
    ap.add_argument('--frame', type=int, help='crops: which frame (1-based; default two thirds in)')
    ap.add_argument('--region-from', help='report: take the crop regions from this capture')
    a = ap.parse_args()
    caps = []
    for c in a.captures:
        hits = sorted(glob.glob(str(CAPTURES / c))) if any(ch in c for ch in '*?[') else [str(cap_dir(c))]
        caps += [Path(h).resolve() for h in hits if (Path(h) / 'capture.json').exists()]
    if not caps:
        sys.exit('no captures found')
    codecs = [c for c in a.codecs.split(',') if c]
    rates = [int(r) for r in a.rates.split(',') if r]
    if a.command == 'all':
        # One capture at a time, skipping finished ones and ones another run is working on,
        # so several runs can share a list of captures.
        for cap in caps:
            res = cap / 'results.json'
            if not a.force and res.exists():
                r = json.loads(res.read_text())
                if 'regions' in r and all(f'{c}_{n}' in r.get('variants', {}) for c, n in variants(codecs, rates)):
                    print(f'{cap.name}: done already')
                    continue
            lock = cap / 'analysis.lock'
            try:
                os.close(os.open(lock, os.O_CREAT | os.O_EXCL))
            except FileExistsError:
                print(f'{cap.name}: another run is on it ({lock.name})')
                continue
            try:
                cmd_encode([cap], codecs, rates, a.force)
                cmd_measure([cap], codecs, rates, a.force)
                cmd_crops([cap], codecs, rates, a.frame)
            finally:
                lock.unlink(missing_ok=True)
        return
    if a.command == 'encode':
        cmd_encode(caps, codecs, rates, a.force)
    if a.command == 'measure':
        cmd_measure(caps, codecs, rates, a.force)
    if a.command == 'crops':
        cmd_crops(caps, codecs, rates, a.frame)
    if a.command == 'report':
        cmd_report(caps, codecs, rates, a.out, a.region_from)


if __name__ == '__main__':
    main()
