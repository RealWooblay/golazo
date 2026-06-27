#!/usr/bin/env python3
"""
GOLAZO "feed_square" promo — REAL app-UI loop renderer (Pillow).

Renders a ~11s, 1080x1080, 30fps, 1:1 (X/IG feed) flat-brand promo that walks
through the actual GOLAZO in-play betting loop, then prints the ffmpeg command.

It draws the real app UI per frame (flat mock):
  - PITCH HERO: dark-green pitch band w/ halfway line + center circle, a red
    LIVE pill, match clock ("67'"), scoreline "BRA 1 - 1 ARG" with crest discs.
  - COMMENTARY line in muted text.
  - MARKET-INCOMING telegraph: centered "NEXT MARKET" pill + 3/2/1 countdown
    with a soft pulse (the get-ready pause).
  - BETTING CARD: rounded surface, "NEXT" lane chip, the question, a split
    PRICE BOARD (two halves) with a crowd-lean divider, and a SEGMENTED FUSE
    timer (~12 pips depleting) + "RESOLVES IN 0:08".
  - TAP highlight on "Brazil 1.85x" -> "Bet in".
  - SHOT resolve -> PAYOUT: big "1.85x", "You won", "+$46.25", stake->return.
  - END CARD: strike logo + GOLAZO + "Bet the next moment." + url.

THE 7 BEATS (square, tighter):
  1. Live pitch + score + clock; commentary builds.
  2. TENSION/PAUSE: lean toward Brazil, hush, "NEXT MARKET" pill pulses 3..2..1.
  3. MARKET POPS UP: card slides + scales in, fuse counting down.
  4. TAP highlights "Brazil 1.85x" (lights green) -> "Bet in".
  5. SHOT: "Brazil shoots!" resolves.
  6. PAYOUT: 1.85x, "You won +$46.25", $25 -> $71.25.
  7. END CARD.

Brand (STRICT, flat + dark):
  canvas   #0B0C0F   surfaces #14181E / #1B1F27   hairline #23262D
  accent   #27E08A (exactly one)   text #E8EDF2   muted #8A93A0
  loss red #FF5C5C only on a loss. No gradients/glow/shadow/grain/3D.

Self-contained: standard library + Pillow only. Degrades gracefully if a
preferred font path is missing (falls back through a list, then PIL default).
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
FRAMES_DIR = os.path.join(HERE, "frames_feed_square")
OUT_MP4 = os.path.join(HERE, "golazo_feed_square.mp4")

# Brand palette
BG       = (11, 12, 15)      # #0B0C0F
SURFACE  = (20, 24, 30)      # #14181E
SURFACE2 = (27, 31, 39)      # #1B1F27
HAIRLINE = (35, 38, 45)      # #23262D
ACCENT   = (39, 224, 138)    # #27E08A
TEXT     = (232, 237, 242)   # #E8EDF2
MUTED    = (138, 147, 160)   # #8A93A0
LOSS     = (255, 92, 92)     # #FF5C5C (only on a loss; unused here, we win)

# Pitch + crest tints (flat)
PITCH    = (19, 53, 31)      # #13351f-ish flat dark-green band
PITCH_LN = (210, 222, 214)   # thin white-ish markings
LIVE_RED = (255, 68, 68)
BRA_Y    = (245, 209, 46)    # Brazil yellow disc
ARG_B    = (124, 184, 224)   # Argentina light blue disc

# ----------------------------------------------------------------------------
# Fonts (graceful fallback)
# ----------------------------------------------------------------------------
FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/"
    "lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/"
    "DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/"
    "lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
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


def ease_back(t):
    """Slight overshoot ease-out (for pop-in)."""
    t = clamp01(t)
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c0, c1, t):
    t = clamp01(t)
    return tuple(int(round(lerp(c0[i], c1[i], t))) for i in range(3))


def fade_color(color, alpha):
    """Blend a color toward BG by alpha (0 = invisible, 1 = full)."""
    return mix(BG, color, alpha)


def fade_over(color, base, alpha):
    """Blend a color toward an arbitrary base by alpha."""
    return mix(base, color, alpha)


def measure(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def text_center(draw, cx, cy, text, fnt, fill, tracking=0):
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


def text_left(draw, x, cy, text, fnt, fill):
    _, th, tbb = measure(draw, text, fnt)
    draw.text((x - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


def text_right(draw, x, cy, text, fnt, fill):
    w, th, tbb = measure(draw, text, fnt)
    draw.text((x - w - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


# ----------------------------------------------------------------------------
# Logo strike-mark (brand icon): three speed lines + accent disc w/ pentagon
# ----------------------------------------------------------------------------
def draw_logo(draw, cx, cy, scale, alpha=1.0):
    s = scale / 100.0

    def P(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)

    acc = fade_color(ACCENT, alpha)
    dark = fade_color(BG, alpha)
    lw = max(2, int(round(7 * s)))

    lines = [((18, 38), (40, 38)), ((13, 50), (38, 50)), ((18, 62), (40, 62))]
    for (x0, y0), (x1, y1) in lines:
        a, b = P(x0, y0), P(x1, y1)
        draw.line([a, b], fill=acc, width=lw)
        r = lw / 2
        for pt in (a, b):
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=acc)

    R = 19 * s
    dc = P(64, 50)
    draw.ellipse([dc[0] - R, dc[1] - R, dc[0] + R, dc[1] + R], fill=acc)
    poly = [P(64, 41), P(71, 47), P(68, 55), P(60, 55), P(57, 47)]
    draw.polygon(poly, fill=dark)


def draw_logo_tile(draw, cx, cy, size, alpha=1.0):
    """Logo on a dark rounded tile (the brand lockup)."""
    half = size / 2
    surf = fade_color(SURFACE2, alpha)
    hair = fade_color(HAIRLINE, alpha)
    draw.rounded_rectangle(
        [cx - half, cy - half, cx + half, cy + half],
        radius=int(size * 0.22), fill=surf, outline=hair, width=2,
    )
    draw_logo(draw, cx, cy, scale=size * 0.74, alpha=alpha)


# ----------------------------------------------------------------------------
# App UI pieces
# ----------------------------------------------------------------------------
def draw_pill(draw, cx, cy, label, fnt, fg, bg, alpha=1.0, dot=None,
              pad_x=22, pad_y=12, outline=None):
    w, th, tbb = measure(draw, label, fnt)
    dot_w = 0
    if dot is not None:
        dot_w = th * 1.5
    pw = w + pad_x * 2 + dot_w
    ph = th + pad_y * 2
    x0 = cx - pw / 2
    x1 = cx + pw / 2
    y0 = cy - ph / 2
    y1 = cy + ph / 2
    fillc = fade_color(bg, alpha) if isinstance(bg, tuple) else None
    outc = fade_color(outline, alpha) if outline else None
    draw.rounded_rectangle([x0, y0, x1, y1], radius=int(ph / 2),
                           fill=fillc, outline=outc, width=2 if outc else 0)
    tx = x0 + pad_x
    if dot is not None:
        dr = th * 0.30
        dcx = tx + dr
        draw.ellipse([dcx - dr, cy - dr, dcx + dr, cy + dr],
                     fill=fade_color(dot, alpha))
        tx = tx + dot_w
    draw.text((tx - tbb[0], cy - th / 2 - tbb[1]), label, font=fnt,
              fill=fade_color(fg, alpha))


def draw_crest(draw, cx, cy, r, color, alpha=1.0):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fade_color(color, alpha))


def draw_pitch_hero(draw, x0, y0, x1, y1, clock_str, commentary, alpha=1.0,
                    lean=0.0, score=("1", "1")):
    """Flat dark-green pitch band with markings, LIVE pill, clock, scoreline.
    `lean` in [-1,1]: positive = action leaning toward Brazil (left)."""
    w = x1 - x0
    h = y1 - y0
    rad = 34
    # pitch surface
    draw.rounded_rectangle([x0, y0, x1, y1], radius=rad,
                           fill=fade_color(PITCH, alpha))
    # markings: halfway line + center circle (flat thin)
    mid = (x0 + x1) / 2
    ln = fade_over(PITCH_LN, PITCH, 0.55 * alpha)
    draw.line([mid, y0 + 18, mid, y1 - 18], fill=ln, width=3)
    ccy = (y0 + y1) / 2
    cr = h * 0.20
    draw.ellipse([mid - cr, ccy - cr, mid + cr, ccy + cr], outline=ln, width=3)
    # outer touchline inset
    inset = 18
    draw.rounded_rectangle([x0 + inset, y0 + inset, x1 - inset, y1 - inset],
                           radius=rad - 8, outline=ln, width=2)
    # a subtle lean glow-free marker: a small accent arc near the leaning side
    if lean != 0.0:
        la = clamp01(abs(lean))
        # a flat accent chevron set on the leaning half (motion hint)
        side = -1 if lean > 0 else 1  # lean>0 -> Brazil (left)
        bx = mid + side * (w * 0.22)
        for k in range(3):
            off = k * 26
            cxk = bx + side * off
            chev = fade_over(ACCENT, PITCH, 0.30 * la * alpha)
            draw.line([(cxk, ccy - 22), (cxk - side * 16, ccy)], fill=chev,
                      width=5)
            draw.line([(cxk - side * 16, ccy), (cxk, ccy + 22)], fill=chev,
                      width=5)

    # LIVE pill (top-left)
    pf = font(28, bold=True)
    draw_pill(draw, x0 + 90, y0 + 50, "LIVE", pf, TEXT, (24, 20, 20),
              alpha=alpha, dot=LIVE_RED, pad_x=18, pad_y=9)
    # clock (top-right)
    cf = font(34, bold=True)
    text_right(draw, x1 - 36, y0 + 50, clock_str, cf, fade_color(TEXT, alpha))

    # scoreline row: BRA (yellow)  1 - 1  ARG (blue) — centered band lower
    sy = y1 - h * 0.30
    nf = font(46, bold=True)
    sf = font(58, bold=True)
    # measure to lay out symmetric around mid
    score_str = "%s  -  %s" % (score[0], score[1])
    sw, sh, sbb = measure(draw, score_str, sf)
    text_center(draw, mid, sy, score_str, sf, fade_color(TEXT, alpha))
    # Brazil side (left of score)
    gap = 26
    bra_x = mid - sw / 2 - gap
    text_right(draw, bra_x, sy, "BRA", nf, fade_color(TEXT, alpha))
    bw, _, _ = measure(draw, "BRA", nf)
    draw_crest(draw, bra_x - bw - 36, sy, 22, BRA_Y, alpha=alpha)
    # Argentina side (right of score)
    arg_x = mid + sw / 2 + gap
    text_left(draw, arg_x, sy, "ARG", nf, fade_color(TEXT, alpha))
    aw, _, _ = measure(draw, "ARG", nf)
    draw_crest(draw, arg_x + aw + 36, sy, 22, ARG_B, alpha=alpha)


def draw_fuse(draw, cx, cy, w, n, remaining_frac, alpha=1.0):
    """A row of n pips that deplete left->right. remaining_frac in [0,1]."""
    gap = 10
    pip_w = (w - gap * (n - 1)) / n
    pip_h = 14
    x = cx - w / 2
    lit = remaining_frac * n
    for i in range(n):
        x0 = x + i * (pip_w + gap)
        full = clamp01(lit - i)
        col = mix(HAIRLINE, ACCENT, full)
        draw.rounded_rectangle([x0, cy - pip_h / 2, x0 + pip_w, cy + pip_h / 2],
                               radius=pip_h / 2, fill=fade_color(col, alpha))


def draw_price_board(draw, cx, cy, w, h, left_label, left_mult, right_label,
                     right_mult, lean, highlight=0.0, alpha=1.0):
    """Two rounded halves side by side w/ a crowd-lean divider.
    `lean` in [0,1] = fraction toward left (Brazil). `highlight` lights left."""
    rad = int(h * 0.26)
    x0 = cx - w / 2
    x1 = cx + w / 2
    y0 = cy - h / 2
    y1 = cy + h / 2
    midgap = 10
    half_w = (w - midgap) / 2
    lx1 = x0 + half_w
    rx0 = x1 - half_w

    # left half (Brazil) — green tint, lights up on highlight
    left_base = mix(SURFACE2, (18, 46, 34), 0.6)  # subtle green-tinted surface
    left_fill = mix(left_base, (24, 70, 50), highlight)
    left_out = mix(HAIRLINE, ACCENT, max(0.25, highlight))
    draw.rounded_rectangle([x0, y0, lx1, y1], radius=rad,
                           fill=fade_color(left_fill, alpha),
                           outline=fade_color(left_out, alpha),
                           width=2 + int(2 * highlight))
    # right half (Argentina) — neutral
    draw.rounded_rectangle([rx0, y0, x1, y1], radius=rad,
                           fill=fade_color(SURFACE2, alpha),
                           outline=fade_color(HAIRLINE, alpha), width=2)

    # labels + mults
    lf = font(38, bold=True)
    mf = font(54, bold=True)
    lcx = (x0 + lx1) / 2
    rcx = (rx0 + x1) / 2
    text_center(draw, lcx, cy - h * 0.16, left_label, lf, fade_color(TEXT, alpha))
    text_center(draw, lcx, cy + h * 0.20, left_mult, mf, fade_color(ACCENT, alpha))
    text_center(draw, rcx, cy - h * 0.16, right_label, lf,
                fade_color(TEXT, alpha))
    text_center(draw, rcx, cy + h * 0.20, right_mult, mf,
                fade_color(TEXT, alpha))

    # crowd-lean marker on the divider: a small triangle that slides with lean
    div_x = lerp(rx0, lx1, 0.5)
    # lean bar above the board
    bar_w = w
    bar_y = y0 - 26
    draw.rounded_rectangle([x0, bar_y - 4, x1, bar_y + 4], radius=4,
                           fill=fade_color(HAIRLINE, alpha))
    marker_x = lerp(x0 + 20, x1 - 20, 1.0 - lean)  # lean=1 -> toward left
    draw.ellipse([marker_x - 9, bar_y - 9, marker_x + 9, bar_y + 9],
                 fill=fade_color(ACCENT, alpha))


def draw_card(draw, cx, cy, w, h, alpha=1.0, scale=1.0):
    """The betting card surface (rounded). Returns inner geometry helpers via
    drawing only; callers compute their own positions relative to cx,cy."""
    sw = w * scale
    sh = h * scale
    x0 = cx - sw / 2
    x1 = cx + sw / 2
    y0 = cy - sh / 2
    y1 = cy + sh / 2
    draw.rounded_rectangle([x0, y0, x1, y1], radius=int(34 * scale),
                           fill=fade_color(SURFACE, alpha),
                           outline=fade_color(HAIRLINE, alpha), width=2)
    return x0, y0, x1, y1


# ----------------------------------------------------------------------------
# Timeline (seconds). Total ~11.0s. 7 beats, tighter.
# ----------------------------------------------------------------------------
#  1 live      : 0.00 - 2.00   pitch + score + clock; commentary builds
#  2 pause     : 2.00 - 3.80   tension lean + "NEXT MARKET" 3..2..1 pulse
#  3 market    : 3.80 - 5.40   card slides+scales in, fuse counts down
#  4 tap       : 5.40 - 6.80   tap highlights Brazil 1.85x -> "Bet in"
#  5 shot      : 6.80 - 7.80   "Brazil shoots!" resolves
#  6 payout    : 7.80 - 9.60   1.85x, "You won +$46.25", $25 -> $71.25
#  7 end       : 9.60 - 11.00  end card
SECTIONS = {
    "live":   (0.00, 2.00),
    "pause":  (2.00, 3.80),
    "market": (3.80, 5.40),
    "tap":    (5.40, 6.80),
    "shot":   (6.80, 7.80),
    "payout": (7.80, 9.60),
    "end":    (9.60, 11.00),
}
DURATION = 11.00
TOTAL_FRAMES = int(round(DURATION * FPS))

# Hero band geometry (top of the square)
HERO_X0 = 70
HERO_X1 = W - 70
HERO_Y0 = 90
HERO_Y1 = 430
HERO_MID = (HERO_X0 + HERO_X1) / 2


def seg_t(t, key):
    a, b = SECTIONS[key]
    return clamp01((t - a) / (b - a))


def in_seg(t, key):
    a, b = SECTIONS[key]
    return a <= t < b


def clock_for(t):
    """Match clock ticking 67' across the early beats."""
    return "67'"


# ----------------------------------------------------------------------------
# Persistent app frame (hero + commentary) shown across beats 1-5
# ----------------------------------------------------------------------------
def draw_app_shell(d, t, commentary, lean=0.0, hero_alpha=1.0,
                   comment_alpha=1.0):
    draw_pitch_hero(d, HERO_X0, HERO_Y0, HERO_X1, HERO_Y1, clock_for(t),
                    commentary, alpha=hero_alpha, lean=lean)
    if comment_alpha > 0 and commentary:
        cf = font(38, bold=False)
        text_center(d, W / 2, HERO_Y1 + 56, commentary, cf,
                    fade_color(MUTED, comment_alpha))


def render_frame(i):
    t = i / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    cx = W / 2

    # ===================== BEAT 1: LIVE =====================
    if in_seg(t, "live"):
        p = seg_t(t, "live")
        a = ease_out(clamp01(p / 0.16))
        # commentary builds: appears partway in
        com_a = ease_out(clamp01((p - 0.30) / 0.30))
        # lean starts to creep toward Brazil near the end of beat 1
        lean = ease_in_out(clamp01((p - 0.6) / 0.4)) * 0.45
        draw_app_shell(d, t, "Brazil break down the right.", lean=lean,
                       hero_alpha=a, comment_alpha=com_a)
        # idle hint card placeholder area kept clean (no card yet)

    # ===================== BEAT 2: PAUSE / TENSION =====================
    if in_seg(t, "pause"):
        p = seg_t(t, "pause")
        # strong lean toward Brazil (left)
        lean = lerp(0.45, 0.92, ease_in_out(clamp01(p / 0.6)))
        # commentary shifts to hush
        com = "Brazil surging. They smell a chance."
        draw_app_shell(d, t, com, lean=lean, hero_alpha=1.0, comment_alpha=1.0)

        # NEXT MARKET telegraph pill, centered in the lower area, with 3..2..1
        # countdown and a soft pulse (no glow — scale pulse only).
        intro = ease_back(clamp01(p / 0.22))
        # countdown number: 3 for first third, 2, then 1
        if p < 0.40:
            num = "3"
            np = p / 0.40
        elif p < 0.70:
            num = "2"
            np = (p - 0.40) / 0.30
        else:
            num = "1"
            np = (p - 0.70) / 0.30
        # soft pulse: a gentle scale on each number tick
        pulse = 1.0 + 0.06 * math.sin(clamp01(np) * math.pi)

        pill_cy = HERO_Y1 + 250
        pf = font(int(34), bold=True)
        # NEXT MARKET pill
        draw_pill(d, cx, pill_cy - 70, "NEXT MARKET", pf, BG, ACCENT,
                  alpha=intro, pad_x=30, pad_y=14)
        # big countdown number with pulse
        big = font(int(220 * pulse), bold=True)
        text_center(d, cx, pill_cy + 110, num, big,
                    fade_color(ACCENT, intro))
        # "Get ready" eyebrow
        eb = font(30, bold=True)
        text_center(d, cx, pill_cy + 250, "GET READY", eb,
                    fade_color(MUTED, intro), tracking=8)

    # ===================== BEAT 3: MARKET POPS UP =====================
    if in_seg(t, "market"):
        p = seg_t(t, "market")
        # hero stays, lean relaxes a touch
        draw_app_shell(d, t, "Next shot is coming.", lean=0.78,
                       hero_alpha=1.0, comment_alpha=ease_out(clamp01(p / 0.2)))
        # card slides up + scales in
        pop = ease_back(clamp01(p / 0.40))
        scale = lerp(0.9, 1.0, clamp01(pop))
        card_cy = lerp(H + 200, H * 0.74, ease_out(clamp01(p / 0.45)))
        card_w = W - 120
        card_h = 470
        a = ease_out(clamp01(p / 0.25))
        x0, y0, x1, y1 = draw_card(d, cx, card_cy, card_w, card_h,
                                   alpha=a, scale=1.0)
        _draw_card_contents(d, cx, card_cy, card_w, card_h, a,
                            fuse_frac=lerp(1.0, 0.66, p),
                            resolve_sec=int(round(lerp(8, 6, p))),
                            highlight=0.0)

    # ===================== BEAT 4: TAP =====================
    if in_seg(t, "tap"):
        p = seg_t(t, "tap")
        draw_app_shell(d, t, "Tap to back Brazil.", lean=0.80,
                       hero_alpha=1.0, comment_alpha=1.0)
        card_cy = H * 0.74
        card_w = W - 120
        card_h = 470
        draw_card(d, cx, card_cy, card_w, card_h, alpha=1.0)
        # highlight grows as the tap lands (around p~0.35)
        hl = ease_out(clamp01((p - 0.20) / 0.30))
        fuse_frac = lerp(0.66, 0.34, p)
        resolve = int(round(lerp(6, 4, p)))
        _draw_card_contents(d, cx, card_cy, card_w, card_h, 1.0,
                            fuse_frac=fuse_frac, resolve_sec=resolve,
                            highlight=hl, bet_in=(p > 0.45))
        # finger/tap marker: a ring that contracts onto the Brazil half
        if 0.05 < p < 0.55:
            tp = clamp01((p - 0.05) / 0.30)
            # Brazil half center
            board_cy = card_cy + 70
            lcx = cx - (card_w - 120) / 4 - 5
            ring_r = lerp(70, 30, ease_out(tp))
            ring_a = 1.0 if tp < 1 else 0.0
            col = fade_color(ACCENT, ring_a)
            d.ellipse([lcx - ring_r, board_cy - ring_r,
                       lcx + ring_r, board_cy + ring_r], outline=col, width=6)
            # small solid dot (fingertip)
            dr = 16
            d.ellipse([lcx - dr, board_cy - dr, lcx + dr, board_cy + dr],
                      fill=fade_color(TEXT, ring_a))

    # ===================== BEAT 5: SHOT =====================
    if in_seg(t, "shot"):
        p = seg_t(t, "shot")
        # commentary snaps to the shot; hero flashes lean hard left
        draw_app_shell(d, t, "Brazil shoots!", lean=0.95,
                       hero_alpha=1.0, comment_alpha=1.0)
        card_cy = H * 0.74
        card_w = W - 120
        card_h = 470
        draw_card(d, cx, card_cy, card_w, card_h, alpha=1.0)
        # fuse empties fast; "RESOLVING"
        fuse_frac = lerp(0.34, 0.0, ease_in_out(p))
        _draw_card_contents(d, cx, card_cy, card_w, card_h, 1.0,
                            fuse_frac=fuse_frac, resolve_sec=0,
                            highlight=1.0, bet_in=True, resolving=(p > 0.4))
        # a quick "SHOT!" tag rising from the card
        if p > 0.25:
            sa = ease_out(clamp01((p - 0.25) / 0.3))
            sf = font(64, bold=True)
            oy = (1 - sa) * 20
            text_center(d, cx, HERO_Y1 + 150 - oy, "SHOT!", sf,
                        fade_color(ACCENT, sa))

    # ===================== BEAT 6: PAYOUT =====================
    if in_seg(t, "payout"):
        p = seg_t(t, "payout")
        _draw_payout(d, cx, p)

    # ===================== BEAT 7: END CARD =====================
    if t >= SECTIONS["end"][0]:
        p = seg_t(t, "end")
        a = ease_out(clamp01(p / 0.28))
        draw_logo_tile(d, cx, H * 0.36, size=240, alpha=a)
        wf = font(118, bold=True)
        text_center(d, cx, H * 0.52, "GOLAZO", wf, fade_color(TEXT, a),
                    tracking=8)
        tag_a = ease_out(clamp01((p - 0.20) / 0.30))
        tf = font(56, bold=True)
        text_center(d, cx, H * 0.62, "Bet the next moment.", tf,
                    fade_color(TEXT, tag_a))
        url_a = ease_out(clamp01((p - 0.40) / 0.30))
        uf = font(44, bold=False)
        text_center(d, cx, H * 0.70, "golazo.wooblay.com", uf,
                    fade_color(ACCENT, url_a), tracking=3)

    return img


def _draw_card_contents(d, cx, card_cy, card_w, card_h, a, fuse_frac,
                        resolve_sec, highlight=0.0, bet_in=False,
                        resolving=False):
    """Inner contents of the betting card: NEXT chip, question, price board,
    fuse + resolves-in line."""
    top = card_cy - card_h / 2
    pad = 48
    # NEXT lane chip (top-left)
    nf = font(28, bold=True)
    draw_pill(d, cx - card_w / 2 + pad + 56, top + 56, "NEXT", nf, BG, ACCENT,
              alpha=a, pad_x=22, pad_y=10)
    # "Bet in" confirmation chip (top-right) once tapped
    if bet_in:
        bf = font(28, bold=True)
        draw_pill(d, cx + card_w / 2 - pad - 70, top + 56, "BET IN", bf,
                  ACCENT, SURFACE2, alpha=a, pad_x=22, pad_y=10,
                  outline=ACCENT)

    # question
    qf = font(46, bold=True)
    text_center(d, cx, top + 130, "Next shot: Brazil or Argentina?", qf,
                fade_color(TEXT, a))

    # price board (two halves)
    board_w = card_w - 120
    board_h = 150
    board_cy = card_cy + 70
    draw_price_board(d, cx, board_cy, board_w, board_h,
                     "Brazil", "1.85x", "Argentina", "2.10x",
                     lean=0.66, highlight=highlight, alpha=a)

    # fuse + resolves-in line
    fuse_cy = card_cy + card_h / 2 - 78
    draw_fuse(d, cx, fuse_cy, board_w, 12, fuse_frac, alpha=a)
    rf = font(30, bold=True)
    if resolving:
        text_center(d, cx, fuse_cy + 44, "RESOLVING...", rf,
                    fade_color(ACCENT, a), tracking=4)
    else:
        text_center(d, cx, fuse_cy + 44, "RESOLVES IN 0:%02d" % resolve_sec, rf,
                    fade_color(MUTED, a), tracking=4)


def _draw_payout(d, cx, p):
    """Beat 6: card flips to a win. Big 1.85x, You won +$46.25, stake->return."""
    # the win card
    card_cy = H * 0.50
    card_w = W - 160
    card_h = 620
    a = ease_out(clamp01(p / 0.20))
    x0, y0, x1, y1 = draw_card(d, cx, card_cy, card_w, card_h, alpha=a)
    top = card_cy - card_h / 2

    # "YOU WON" eyebrow (accent)
    eb = font(40, bold=True)
    eb_a = ease_out(clamp01((p - 0.10) / 0.20))
    text_center(d, cx, top + 90, "YOU WON", eb, fade_color(ACCENT, eb_a),
                tracking=10)

    # big multiple counts/pops in
    pop = ease_back(clamp01((p - 0.12) / 0.35))
    mscale = lerp(0.7, 1.0, clamp01(pop))
    mf = font(int(240 * mscale), bold=True)
    m_a = ease_out(clamp01((p - 0.12) / 0.22))
    text_center(d, cx, card_cy - 70, "1.85x", mf, fade_color(ACCENT, m_a))

    # +$46.25 amount
    amt_a = ease_out(clamp01((p - 0.30) / 0.25))
    amf = font(96, bold=True)
    text_center(d, cx, card_cy + 110, "+$46.25", amf, fade_color(TEXT, amt_a))

    # stake -> return line
    sr_a = ease_out(clamp01((p - 0.45) / 0.25))
    srf = font(44, bold=True)
    # build "$25  ->  $71.25" with arrow
    seg_str = "$25      $71.25"
    # draw two amounts and an arrow between
    left = "$25"
    right = "$71.25"
    lf = font(44, bold=False)
    # measure to center the trio
    lw, _, _ = measure(d, left, lf)
    rw, _, _ = measure(d, right, srf)
    arrow_w = 70
    gap = 30
    total = lw + gap + arrow_w + gap + rw
    sx = cx - total / 2
    sy = card_cy + 215
    text_left(d, sx, sy, left, lf, fade_color(MUTED, sr_a))
    ax0 = sx + lw + gap
    ax1 = ax0 + arrow_w
    d.line([ax0, sy, ax1, sy], fill=fade_color(ACCENT, sr_a), width=5)
    d.line([ax1 - 16, sy - 12, ax1, sy], fill=fade_color(ACCENT, sr_a), width=5)
    d.line([ax1 - 16, sy + 12, ax1, sy], fill=fade_color(ACCENT, sr_a), width=5)
    text_left(d, ax1 + gap, sy, right, srf, fade_color(ACCENT, sr_a))

    # small "Paid in seconds." footer under the card
    foot_a = ease_out(clamp01((p - 0.55) / 0.25))
    ff = font(34, bold=True)
    text_center(d, cx, y1 + 70, "Paid in seconds.", ff,
                fade_color(MUTED, foot_a))


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    print("Rendering %d frames (%.1fs @ %dfps, %dx%d) -> %s"
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
