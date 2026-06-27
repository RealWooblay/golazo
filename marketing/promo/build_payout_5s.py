#!/usr/bin/env python3
"""
GOLAZO — "payout_5s" frame renderer (Pillow), SELF-CONTAINED.

Renders a ~5 second, 1080x1080, 30fps flat-brand payout moment to
frames_payout_5s/ (its OWN dir) and prints the exact ffmpeg assemble command.

The win, in order:
  1) the resolved shot: a mini pitch + score + "Brazil shoots!" + a green
     "BET IN" lit half flips to RESOLVED.
  2) the big green multiple 1.85x ticking up (count-up, ease-out).
  3) "You won" + "+$46.25", and a stake -> return line "$25 -> $71.25".
  4) end card: the strike-mark logo + GOLAZO + "Bet the next moment." + url.

Brand (STRICT, flat + dark):
  canvas    #0B0C0F
  surface   #14181E / #1B1F27
  hairline  #23262D
  accent    #27E08A   (exactly one accent, used surgically)
  text      #E8EDF2   muted #8A93A0   loss-red #FF5C5C (UNUSED here — it's a win)
  No gradients, no glow, no shadows, no grain, no 3D. Sentence case.

Self-contained: standard library + Pillow only. Degrades gracefully through a
font fallback list, then PIL's bitmap default.
"""

import os
import sys
import math

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write(
        "ERROR: Pillow (PIL) is not installed. Install with: "
        "python3 -m pip install Pillow\n"
    )
    sys.exit(1)

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
W = H = 1080
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(HERE, "frames_payout_5s")
OUT_MP4 = os.path.join(HERE, "golazo_payout_5s.mp4")

# Brand palette
BG       = (11, 12, 15)      # #0B0C0F
SURFACE  = (20, 24, 30)      # #14181E
SURFACE2 = (27, 31, 39)      # #1B1F27
HAIRLINE = (35, 38, 45)      # #23262D
ACCENT   = (39, 224, 138)    # #27E08A
TEXT     = (232, 237, 242)   # #E8EDF2
MUTED    = (138, 147, 160)   # #8A93A0
LOSS     = (255, 92, 92)     # #FF5C5C (only on a loss — not used in a payout)

# Pitch + crest tints (flat)
PITCH    = (19, 53, 31)      # flat dark-green pitch band
PITCH_LN = (210, 222, 214)   # thin white-ish markings
BRA_Y    = (245, 209, 66)    # Brazil yellow disc
ARG_B    = (118, 178, 221)   # Argentina light-blue disc

# ----------------------------------------------------------------------------
# Fonts (graceful fallback)
# ----------------------------------------------------------------------------
FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/DejaVuSans.ttf",
]


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


_BOLD_PATH = _first_existing(FONT_BOLD_CANDIDATES)
_REG_PATH = _first_existing(FONT_REG_CANDIDATES) or _BOLD_PATH
if _BOLD_PATH is None:
    _BOLD_PATH = _REG_PATH

if _BOLD_PATH is None:
    print("WARNING: no TrueType font found; falling back to PIL bitmap font "
          "(sizes will be ignored).", file=sys.stderr)

_font_cache = {}


def font(size, bold=True):
    key = (size, bold)
    if key in _font_cache:
        return _font_cache[key]
    path = _BOLD_PATH if bold else _REG_PATH
    try:
        f = ImageFont.truetype(path, size) if path else ImageFont.load_default()
    except Exception:
        f = ImageFont.load_default()
    _font_cache[key] = f
    return f


# ----------------------------------------------------------------------------
# Easing + helpers
# ----------------------------------------------------------------------------
def clamp01(t):
    return max(0.0, min(1.0, t))


def ease_out(t):
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return 3 * t * t - 2 * t * t * t


def ease_out_back(t, s=1.70158):
    """Slight overshoot — used for the card/score pop."""
    t = clamp01(t) - 1
    return 1 + (s + 1) * t ** 3 + s * t ** 2


def lerp(a, b, t):
    return a + (b - a) * t


def fade_color(color, alpha):
    """Blend a color toward BG by alpha (0 = invisible, 1 = full)."""
    a = clamp01(alpha)
    return tuple(int(round(lerp(BG[i], color[i], a))) for i in range(3))


def mix(c0, c1, t):
    t = clamp01(t)
    return tuple(int(round(lerp(c0[i], c1[i], t))) for i in range(3))


def measure(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def draw_text_center(draw, cx, cy, text, fnt, fill, tracking=0):
    """Draw text centered at (cx, cy). Optional letter tracking (px)."""
    if tracking == 0:
        w, h, bbox = measure(draw, text, fnt)
        x = cx - w / 2 - bbox[0]
        y = cy - h / 2 - bbox[1]
        draw.text((x, y), text, font=fnt, fill=fill)
        return w
    widths = []
    total = 0
    for ch in text:
        bb = draw.textbbox((0, 0), ch, font=fnt)
        cw = bb[2] - bb[0]
        widths.append(cw)
        total += cw
    total += tracking * (len(text) - 1)
    _, fh, fbb = measure(draw, text, fnt)
    x = cx - total / 2
    y = cy - fh / 2 - fbb[1]
    for ch, cw in zip(text, widths):
        bb = draw.textbbox((0, 0), ch, font=fnt)
        draw.text((x - bb[0], y), ch, font=fnt, fill=fill)
        x += cw + tracking
    return total


# ----------------------------------------------------------------------------
# Logo strike-mark (the brand icon) — reference coord system 100x100
# ----------------------------------------------------------------------------
def draw_logo(draw, cx, cy, scale, draw_progress=1.0, alpha=1.0):
    s = scale / 100.0

    def P(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)

    acc = fade_color(ACCENT, alpha)
    dark = fade_color(BG, alpha)
    lw = max(2, int(round(7 * s)))

    line_p = clamp01(draw_progress / 0.58)
    disc_p = clamp01((draw_progress - 0.42) / 0.58)

    lines = [((18, 38), (40, 38)), ((13, 50), (38, 50)), ((18, 62), (40, 62))]
    for i, ((x0, y0), (x1, y1)) in enumerate(lines):
        lp = ease_out(clamp01((line_p - i * 0.10) / 0.70))
        if lp <= 0:
            continue
        xe = lerp(x0, x1, lp)
        a, b = P(x0, y0), P(xe, y1)
        draw.line([a, b], fill=acc, width=lw)
        r = lw / 2
        for pt in (a, b):
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=acc)

    if disc_p > 0:
        dp = ease_out(disc_p)
        R = 19 * s * dp
        dc = P(64, 50)
        draw.ellipse([dc[0] - R, dc[1] - R, dc[0] + R, dc[1] + R], fill=acc)
        if disc_p > 0.65:
            poly = [P(64, 41), P(71, 47), P(68, 55), P(60, 55), P(57, 47)]
            draw.polygon(poly, fill=dark)


def draw_logo_tile(draw, cx, cy, tile, alpha=1.0):
    """The strike-mark on a dark rounded tile (footer/end lockup)."""
    half = tile / 2
    draw.rounded_rectangle(
        [cx - half, cy - half, cx + half, cy + half],
        radius=int(tile * 0.22),
        fill=fade_color(SURFACE2, alpha),
        outline=fade_color(HAIRLINE, alpha), width=2,
    )
    draw_logo(draw, cx, cy, scale=tile * 0.62, draw_progress=1.0, alpha=alpha)


# ----------------------------------------------------------------------------
# Mini pitch hero (flat) — pitch band, markings, LIVE, clock, scoreline
# ----------------------------------------------------------------------------
def draw_pitch_hero(draw, cx, cy, w, h, alpha=1.0, clock="67'",
                    score=("BRA", "1", "1", "ARG")):
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2
    rad = int(h * 0.10)

    # pitch band
    draw.rounded_rectangle([x0, y0, x1, y1], radius=rad,
                           fill=fade_color(PITCH, alpha),
                           outline=fade_color(HAIRLINE, alpha), width=2)

    # markings live in the UPPER half so the scoreline (lower-center) stays clear
    ln = fade_color(PITCH_LN, alpha * 0.45)
    mark_top = y0 + h * 0.10
    mark_bot = cy - h * 0.02
    # halfway line (only across the upper band)
    draw.line([cx, mark_top, cx, mark_bot], fill=ln, width=2)
    # center circle, small and sitting in the upper band
    ccy = (mark_top + mark_bot) / 2
    cr = h * 0.16
    draw.ellipse([cx - cr, ccy - cr, cx + cr, ccy + cr], outline=ln, width=2)
    draw.ellipse([cx - 3, ccy - 3, cx + 3, ccy + 3], fill=ln)

    # LIVE dot + pill (top-left)
    px = x0 + w * 0.045
    py = y0 + h * 0.13
    dotr = 7
    draw.ellipse([px, py - dotr, px + dotr * 2, py + dotr], fill=fade_color(LOSS, alpha))
    lf = font(int(h * 0.115), bold=True)
    draw.text((px + dotr * 2 + 12, py - measure(draw, "LIVE", lf)[1] / 2 - 2),
              "LIVE", font=lf, fill=fade_color(TEXT, alpha))

    # clock (top-right)
    cf = font(int(h * 0.135), bold=True)
    cw, ch, cbb = measure(draw, clock, cf)
    draw.text((x1 - w * 0.045 - cw - cbb[0], py - ch / 2 - cbb[1]),
              clock, font=cf, fill=fade_color(TEXT, alpha))

    # scoreline row "(o)BRA  1 - 1  ARG(o)" as ONE centered group over a plate
    a, hs, as_, b = score
    sf = font(int(h * 0.30), bold=True)
    small = font(int(h * 0.165), bold=True)
    sy = cy + h * 0.255  # lower-center, below the markings

    score_str = "%s - %s" % (hs, as_)
    sw, _sh, sbb = measure(draw, score_str, sf)
    aw, _ah, abb = measure(draw, a, small)
    bw, _bh, bbb = measure(draw, b, small)
    discr = h * 0.085
    inner_gap = h * 0.06    # disc<->abbrev
    block_gap = h * 0.085   # abbrev<->score
    left_block = discr * 2 + inner_gap + aw
    right_block = bw + inner_gap + discr * 2
    group_w = left_block + block_gap + sw + block_gap + right_block

    # subtle darker plate behind the scoreline so it reads over the pitch
    plate_h = h * 0.40
    plate_pad = h * 0.12
    draw.rounded_rectangle(
        [cx - group_w / 2 - plate_pad, sy - plate_h / 2,
         cx + group_w / 2 + plate_pad, sy + plate_h / 2],
        radius=int(plate_h * 0.30),
        fill=fade_color(mix(PITCH, BG, 0.55), alpha))

    gx = cx - group_w / 2
    # home disc
    hdcx = gx + discr
    draw.ellipse([hdcx - discr, sy - discr, hdcx + discr, sy + discr],
                 fill=fade_color(BRA_Y, alpha))
    # home abbrev
    hax = hdcx + discr + inner_gap
    draw.text((hax - abb[0], sy - _ah / 2 - abb[1]), a, font=small,
              fill=fade_color(TEXT, alpha))
    # score
    scx = hax + aw + block_gap
    draw.text((scx - sbb[0], sy - _sh / 2 - sbb[1]), score_str, font=sf,
              fill=fade_color(TEXT, alpha))
    # away abbrev
    bax = scx + sw + block_gap
    draw.text((bax - bbb[0], sy - _bh / 2 - bbb[1]), b, font=small,
              fill=fade_color(TEXT, alpha))
    # away disc
    bdcx = bax + bw + inner_gap + discr
    draw.ellipse([bdcx - discr, sy - discr, bdcx + discr, sy + discr],
                 fill=fade_color(ARG_B, alpha))


# ----------------------------------------------------------------------------
# Confetti-free accent burst: a clean radial set of short green ticks (flat).
# A single surgical pop on resolve — no glow, just lines that shoot out + fade.
# ----------------------------------------------------------------------------
def draw_burst(draw, cx, cy, p, alpha=1.0, n=12, r0=70, r1=230):
    """p in [0,1]: ticks travel outward and fade. Flat accent lines only."""
    if p <= 0 or alpha <= 0:
        return
    e = ease_out(p)
    fade = (1 - p)  # fade as they travel
    a = clamp01(alpha * fade)
    if a <= 0.02:
        return
    inner = lerp(r0, r1 * 0.78, e)
    outer = lerp(r0 + 26, r1, e)
    col = fade_color(ACCENT, a * 0.85)
    for k in range(n):
        ang = (2 * math.pi * k / n) - math.pi / 2 + 0.18
        ix, iy = cx + math.cos(ang) * inner, cy + math.sin(ang) * inner
        ox, oy = cx + math.cos(ang) * outer, cy + math.sin(ang) * outer
        draw.line([ix, iy, ox, oy], fill=col, width=5)


# ----------------------------------------------------------------------------
# Timeline (seconds). Total ~5.0s.
# ----------------------------------------------------------------------------
#  a) RESOLVE  : pitch + "Brazil shoots!" + bet-in half lights green      0.00-1.30
#  b) MULTIPLE : big green 1.85x counts up, burst on land               1.30-3.10
#  c) PAYOUT   : "You won" + "+$46.25" + stake->return line             2.60-4.05
#  d) END      : logo tile + GOLAZO + "Bet the next moment." + url       4.05-5.00
SECTIONS = {
    "resolve": (0.00, 1.30),
    "mult":    (1.30, 3.10),
    "payout":  (2.60, 4.05),
    "end":     (4.05, 5.00),
}
DURATION = 5.00
TOTAL_FRAMES = int(round(DURATION * FPS))


def seg_t(t, key):
    a, b = SECTIONS[key]
    return clamp01((t - a) / (b - a))


def render_frame(i):
    t = i / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    cx = W / 2

    # ---- (a) RESOLVE: pitch hero + "Brazil shoots!" + bet half resolves ----
    # Visible during resolve, and lingers/fades as the multiple takes the stage.
    res_a, res_b = SECTIONS["resolve"]
    if t < SECTIONS["mult"][0]:
        p = seg_t(t, "resolve")
        a_in = ease_out(clamp01(p / 0.18))
        # fade the whole resolve stage out cleanly BEFORE the multiple rises,
        # so there's no overlap/collision between the card and the big number.
        out = ease_in_out(clamp01((p - 0.74) / 0.26))
        alpha = a_in * (1 - out)

        if alpha > 0.01:
            # pitch hero near the top
            draw_pitch_hero(d, cx, H * 0.205, W * 0.74, H * 0.215, alpha=alpha)

            # commentary line, muted, just under the hero — fades out as the
            # shot fires so the "Brazil shoots!" stamp takes its place cleanly.
            shoot_pre = clamp01((p - 0.34) / 0.30)
            com = font(40, bold=False)
            com_a = ease_out(clamp01((p - 0.05) / 0.18)) * (1 - out) \
                * (1 - ease_in_out(shoot_pre))
            if com_a > 0.01:
                draw_text_center(d, cx, H * 0.345,
                                 "Brazil surging down the right.",
                                 com, fade_color(MUTED, com_a))

            # the resolved betting card: lane chip + question + a split where the
            # Brazil half is lit green ("BET IN") and stamps to "RESOLVED".
            card_cy = H * 0.585
            card_w, card_h = W * 0.74, H * 0.30
            cx0, cy0 = cx - card_w / 2, card_cy - card_h / 2
            cx1, cy1 = cx + card_w / 2, card_cy + card_h / 2
            d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=28,
                                fill=fade_color(SURFACE, alpha),
                                outline=fade_color(HAIRLINE, alpha), width=2)

            # NEXT lane chip
            chip_f = font(28, bold=True)
            ctxt = "NEXT"
            cwf, chf, cbb = measure(d, ctxt, chip_f)
            chip_x0 = cx0 + 34
            chip_y0 = cy0 + 30
            d.rounded_rectangle(
                [chip_x0, chip_y0, chip_x0 + cwf + 36, chip_y0 + chf + 22],
                radius=12, fill=fade_color(mix(BG, ACCENT, 0.16), alpha),
                outline=fade_color(ACCENT, alpha), width=2)
            d.text((chip_x0 + 18 - cbb[0], chip_y0 + 11 - cbb[1]), ctxt,
                   font=chip_f, fill=fade_color(ACCENT, alpha))

            # question
            qf = font(46, bold=True)
            d.text((cx0 + 34, chip_y0 + chf + 48),
                   "Next shot: Brazil or Argentina?",
                   font=qf, fill=fade_color(TEXT, alpha))

            # split price board (two halves)
            board_y0 = cy0 + card_h * 0.52
            board_y1 = cy1 - 30
            mid = cx
            lhx0 = cx0 + 30
            lhx1 = mid - 8
            rhx0 = mid + 8
            rhx1 = cx1 - 30

            # "shoot" / "bet-in" progress: Brazil half lights green, then stamps
            shoot = clamp01((p - 0.34) / 0.30)   # the shot happening
            litg = ease_out(shoot)

            # left half (Brazil) — lit green, our pick
            left_fill = mix(SURFACE2, mix(BG, ACCENT, 0.22), litg)
            d.rounded_rectangle([lhx0, board_y0, lhx1, board_y1], radius=18,
                                fill=fade_color(left_fill, alpha),
                                outline=fade_color(ACCENT, max(0.35, litg) * alpha),
                                width=int(2 + 2 * litg))
            lf = font(40, bold=True)
            draw_text_center(d, (lhx0 + lhx1) / 2, (board_y0 + board_y1) / 2,
                             "Brazil  1.85x", lf,
                             fade_color(mix(TEXT, ACCENT, litg), alpha))

            # right half (Argentina) — neutral, dims as we resolve
            d.rounded_rectangle([rhx0, board_y0, rhx1, board_y1], radius=18,
                                fill=fade_color(SURFACE2, alpha * (1 - 0.35 * litg)),
                                outline=fade_color(HAIRLINE, alpha * (1 - 0.4 * litg)),
                                width=2)
            rf = font(40, bold=True)
            draw_text_center(d, (rhx0 + rhx1) / 2, (board_y0 + board_y1) / 2,
                             "Argentina  2.10x", rf,
                             fade_color(MUTED, alpha * (1 - 0.45 * litg)))

            # "Brazil shoots!" stamp over the card once the shot fires
            if shoot > 0.05:
                st_a = ease_out(clamp01((shoot - 0.05) / 0.5)) * alpha
                sc = ease_out_back(clamp01((shoot - 0.05) / 0.6))
                sf2 = font(int(64 * (0.7 + 0.3 * sc)), bold=True)
                draw_text_center(d, cx, H * 0.345, "Brazil shoots!", sf2,
                                 fade_color(ACCENT, st_a))

    # ---- (b) MULT: big green multiple counts up + burst on land ------------
    # Stays on screen as the hero number through the payout beat, resting in the
    # upper third so the final stack reads 1.85x / You won / +$46.25 / stake.
    mp_a, mp_b = SECTIONS["mult"]
    if mp_a <= t < SECTIONS["end"][0]:
        p = seg_t(t, "mult")
        a_in = ease_out(clamp01(p / 0.16))
        out = clamp01((t - (SECTIONS["end"][0] - 0.05)) / 0.30)
        alpha = a_in * (1 - out)

        # count up 1.00 -> 1.85, ease-out, landing ~62% through the section
        tick_p = ease_out(clamp01(p / 0.62))
        val = lerp(1.00, 1.85, tick_p)
        landed = tick_p >= 0.999
        mult_str = "%.2fx" % val

        # the number lifts toward an upper-third resting spot as payout appears
        pay_in = clamp01((t - SECTIONS["payout"][0]) / 0.45)
        num_cy = lerp(H * 0.46, H * 0.335, ease_in_out(pay_in))
        num_size = int(lerp(300, 196, ease_in_out(pay_in)))

        # tiny pop on landing
        pop = 0.0
        land_frac = clamp01((p - 0.55) / 0.12)
        if 0 < land_frac < 1:
            pop = math.sin(land_frac * math.pi) * 0.05
        nf = font(int(num_size * (1 + pop)), bold=True)
        draw_text_center(d, cx, num_cy, mult_str, nf,
                         fade_color(ACCENT, alpha))

        # eyebrow above the number while it ticks (before payout text shows)
        if pay_in < 0.5:
            eb_a = alpha * (1 - pay_in * 2)
            eb = font(34, bold=True)
            draw_text_center(d, cx, num_cy - num_size * 0.62, "PAYOUT", eb,
                             fade_color(MUTED, eb_a), tracking=10)

        # burst on land (one clean flat accent pop)
        if landed and pay_in < 0.6:
            burst_p = clamp01((p - 0.62) / 0.30)
            draw_burst(d, cx, num_cy, burst_p, alpha=alpha, n=12,
                       r0=num_size * 0.30, r1=num_size * 0.92)

    # ---- (c) PAYOUT: "You won" + "+$46.25" + stake -> return --------------
    py_a, py_b = SECTIONS["payout"]
    if py_a <= t < SECTIONS["end"][0]:
        p = seg_t(t, "payout")
        a_in = ease_out(clamp01(p / 0.22))
        out = clamp01((t - (SECTIONS["end"][0] - 0.05)) / 0.30)
        alpha = a_in * (1 - out)

        # "You won"
        won_f = font(70, bold=True)
        won_oy = (1 - a_in) * 18
        draw_text_center(d, cx, H * 0.495 + won_oy, "You won", won_f,
                         fade_color(TEXT, alpha))

        # "+$46.25" big green — pops in just after "You won"
        amt_a = ease_out(clamp01((p - 0.14) / 0.26)) * (1 - out)
        amt_scale = ease_out_back(clamp01((p - 0.14) / 0.34))
        amt_f = font(int(126 * (0.80 + 0.20 * amt_scale)), bold=True)
        draw_text_center(d, cx, H * 0.595, "+$46.25", amt_f,
                         fade_color(ACCENT, amt_a))

        # stake -> return line, in a flat pill
        line_a = ease_out(clamp01((p - 0.34) / 0.26)) * (1 - out)
        if line_a > 0.02:
            pill_f = font(44, bold=True)
            txt = "$25  →  $71.25"
            tw, th, tbb = measure(d, txt, pill_f)
            pw = tw + 80
            ph = th + 44
            pcx, pcy = cx, H * 0.695
            d.rounded_rectangle(
                [pcx - pw / 2, pcy - ph / 2, pcx + pw / 2, pcy + ph / 2],
                radius=int(ph * 0.5),
                fill=fade_color(SURFACE2, line_a),
                outline=fade_color(HAIRLINE, line_a), width=2)
            # render "stake" muted, arrow + return in accent for the win read
            stake = "$25"
            rest = "  →  $71.25"
            sf = pill_f
            sw, sh, sbb = measure(d, stake, sf)
            rw, rh, rbb = measure(d, rest, sf)
            startx = pcx - (sw + rw) / 2
            base_y = pcy - th / 2 - tbb[1]
            d.text((startx - sbb[0], base_y), stake, font=sf,
                   fill=fade_color(MUTED, line_a))
            d.text((startx + sw - rbb[0], base_y), rest, font=sf,
                   fill=fade_color(ACCENT, line_a))

    # ---- (d) END CARD: logo tile + GOLAZO + tagline + url ------------------
    if t >= SECTIONS["end"][0]:
        p = seg_t(t, "end")
        a = ease_out(clamp01(p / 0.30))

        # strike-mark on dark tile + wordmark beside it (lockup), centered group
        tile = 150
        # lockup measured so the [tile][gap][GOLAZO] group is centered
        word_f = font(96, bold=True)
        ww, wh, wbb = measure(d, "GOLAZO", word_f)
        gap = 36
        group_w = tile + gap + ww
        gx0 = cx - group_w / 2
        tile_cx = gx0 + tile / 2
        lock_cy = H * 0.42
        draw_logo_tile(d, tile_cx, lock_cy, tile, alpha=a)
        word_x = gx0 + tile + gap
        d.text((word_x - wbb[0], lock_cy - wh / 2 - wbb[1]), "GOLAZO",
               font=word_f, fill=fade_color(TEXT, a))

        # tagline
        tag_a = ease_out(clamp01((p - 0.18) / 0.30))
        tag_f = font(60, bold=True)
        draw_text_center(d, cx, H * 0.565, "Bet the next moment.", tag_f,
                         fade_color(TEXT, tag_a))

        # url in accent
        url_a = ease_out(clamp01((p - 0.34) / 0.30))
        url_f = font(46, bold=False)
        draw_text_center(d, cx, H * 0.645, "golazo.wooblay.com", url_f,
                         fade_color(ACCENT, url_a), tracking=3)

    return img


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    print("Rendering %d frames (%.2fs @ %dfps, %dx%d) -> %s"
          % (TOTAL_FRAMES, DURATION, FPS, W, H, FRAMES_DIR))
    for i in range(TOTAL_FRAMES):
        img = render_frame(i)
        img.save(os.path.join(FRAMES_DIR, "frame_%04d.png" % i))
        if i % 30 == 0 or i == TOTAL_FRAMES - 1:
            print("  frame %4d / %d" % (i, TOTAL_FRAMES - 1))
    print("Done rendering %d frames." % TOTAL_FRAMES)

    cmd = (
        'ffmpeg -y -framerate {fps} -i "{frames}/frame_%04d.png" '
        '-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 '
        '-movflags +faststart "{out}"'
    ).format(fps=FPS, frames=FRAMES_DIR, out=OUT_MP4)

    print("\n=== FFMPEG ASSEMBLE COMMAND ===")
    print(cmd)
    print("===============================")


if __name__ == "__main__":
    main()
