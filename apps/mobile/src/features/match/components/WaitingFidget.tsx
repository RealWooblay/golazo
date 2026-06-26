import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import Svg, { Circle, G, Line, Polygon } from "react-native-svg";
import { colors, spacing } from "@/theme";
import { Text } from "@/ui";
import { hapticIf } from "@/ui/haptics";

// Animated SVG components — created once at module scope (not per render).
const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * WaitingFidget — the between-markets idle toy. A soccer ball on a string that
 * pops off the page: no card, no box, transparent stage so the ball and its
 * string float over whatever is around them and can swing WIDE past the edges.
 *
 * It is a real two-degree-of-freedom toy, not a canned loop:
 *   • ANGLE  — a pendulum. Gravity pulls it back to centre, air-damping bleeds
 *     the swing. A flick on release imparts angular momentum.
 *   • LENGTH — the string is elastic. Pull the ball and the string STRETCHES;
 *     let go and a radial spring yanks it back, overshoots past rest, and
 *     bounces a couple of times before settling. That is the juicy "conker /
 *     yo-yo snap-back" the ball is meant to have.
 *
 * Both integrate on the UI thread (semi-implicit Euler) and are clamped so
 * nothing explodes and everything always settles within a few seconds.
 *
 * Flat by design: no glow, gradient, grain or shadow. Neutral ball, dark seams,
 * exactly one pentagon in the green accent. A calm rotating line sits below.
 *
 * Web-safe: RN PanResponder + reanimated shared values (useFrameCallback /
 * useAnimatedProps / runOnJS) + pure react-native-svg art. No native modules.
 */

const LINES = [
  "Reading the play",
  "Next market incoming",
  "Watching the run of play",
  "Lining up the next call",
  "Feeling out the momentum",
] as const;

// Stage geometry (logical px inside the SVG canvas). The stage is intentionally
// taller/wider than the swing so the ball can fly out toward the edges without
// being clipped — overflow is visible on top of that.
const STAGE_W = 280;
const STAGE_H = 240;
const PIVOT_X = STAGE_W / 2;
const PIVOT_Y = 22; // string anchor near the top
const REST_LEN = 118; // natural string length, pivot -> ball centre
const MIN_LEN = 70; // string can't bunch shorter than this
const MAX_LEN = 196; // and can't be pulled past this (cap the stretch)
const BALL_R = 24;
const MAX_ANGLE = Math.PI * 0.74; // never let the ball flip over the bar

// Physics. Tuned for "lively + bouncy but always settles".
//   Angular: a pendulum — gravity restores, damping bleeds the swing.
//   Radial : a stiff, lightly-damped spring — overshoots on snap-back, bounces
//            ~2 times, then settles. Higher STIFF = snappier, higher RDAMP =
//            fewer bounces.
const GRAVITY = 30; // angular restoring strength toward vertical
const ADAMP = 1.15; // angular air resistance (higher => settles sooner)
const STIFF = 190; // radial spring stiffness (the bounce energy)
const RDAMP = 7.5; // radial spring damping (controls how many bounces)
const REST_EPS = 0.004; // below this, swing is at rest
const LEN_EPS = 0.25; // px: below this, stretch is at rest
const PEAK_VEL_EPS = 0.45; // |angular vel| under this at a turn => peak tick
const BOUNCE_EPS = 6; // radial speed at a turning point worth a bump tick

export interface WaitingFidgetProps {
  /** Fire a tiny tactile tick on flick / bounce / swing-peak. No-op on web. Default true. */
  hapticsEnabled?: boolean;
}

export default function WaitingFidget({
  hapticsEnabled = true,
}: WaitingFidgetProps) {
  // angle: radians from straight-down. +ve swings the ball to the right.
  const angle = useSharedValue(0.5);
  const angularVel = useSharedValue(0);
  // length: current string length pivot -> ball centre (the radial DOF).
  const len = useSharedValue(REST_LEN);
  const lenVel = useSharedValue(0);
  // While dragging we hold both DOFs directly and skip the integrator.
  const dragging = useSharedValue(false);
  // Sign trackers so we tick once per turning point (angular + radial).
  const lastTurnSign = useSharedValue(0);
  const lastLenSign = useSharedValue(0);

  const [lineIdx, setLineIdx] = useState(0);

  // Rotate the waiting line on a calm cadence (independent of the swing).
  useEffect(() => {
    const id = setInterval(
      () => setLineIdx((i) => (i + 1) % LINES.length),
      3600,
    );
    return () => clearInterval(id);
  }, []);

  const tick = useMemo(
    () => () => hapticIf(hapticsEnabled, "tap"),
    [hapticsEnabled],
  );

  // Two-DOF integrator on the UI thread. Semi-implicit Euler for both the
  // pendulum (angle) and the elastic string (len). Clamped to guarantee a
  // bounded, settling motion.
  useFrameCallback((frame) => {
    "worklet";
    if (dragging.value) return;
    const dt = Math.min((frame.timeSincePreviousFrame ?? 16) / 1000, 0.032);
    if (dt <= 0) return;

    // --- Angular DOF: pendulum (gravity restoring + air damping) ---
    const a = angle.value;
    const aAccel = -GRAVITY * Math.sin(a) - ADAMP * angularVel.value;
    angularVel.value += aAccel * dt;
    let nextA = a + angularVel.value * dt;
    if (nextA > MAX_ANGLE) {
      nextA = MAX_ANGLE;
      if (angularVel.value > 0) angularVel.value = 0;
    } else if (nextA < -MAX_ANGLE) {
      nextA = -MAX_ANGLE;
      if (angularVel.value < 0) angularVel.value = 0;
    }
    angle.value = nextA;

    // --- Radial DOF: elastic string (spring toward REST_LEN) — the bounce ---
    const stretch = len.value - REST_LEN;
    const lAccel = -STIFF * stretch - RDAMP * lenVel.value;
    lenVel.value += lAccel * dt;
    let nextL = len.value + lenVel.value * dt;
    if (nextL < MIN_LEN) {
      nextL = MIN_LEN;
      if (lenVel.value < 0) lenVel.value = 0;
    } else if (nextL > MAX_LEN) {
      nextL = MAX_LEN;
      if (lenVel.value > 0) lenVel.value = 0;
    }
    len.value = nextL;

    // --- Haptic ticks at turning points (guarded; no-op on web) ---
    // Angular peak: velocity changed sign while moving slowly.
    const aSign = angularVel.value > 0 ? 1 : -1;
    if (
      aSign !== lastTurnSign.value &&
      lastTurnSign.value !== 0 &&
      Math.abs(angularVel.value) < PEAK_VEL_EPS &&
      Math.abs(angle.value) > 0.06
    ) {
      runOnJS(tick)();
    }
    lastTurnSign.value = aSign;

    // Radial bounce: spring velocity flipped sign with real energy = a "boing".
    const lSign = lenVel.value > 0 ? 1 : -1;
    if (
      lSign !== lastLenSign.value &&
      lastLenSign.value !== 0 &&
      Math.abs(lenVel.value) > BOUNCE_EPS
    ) {
      runOnJS(tick)();
    }
    lastLenSign.value = lSign;

    // --- Settle: park dead-centre once both DOFs run out of energy ---
    if (
      Math.abs(angularVel.value) < REST_EPS &&
      Math.abs(angle.value) < REST_EPS &&
      Math.abs(lenVel.value) < LEN_EPS &&
      Math.abs(stretch) < LEN_EPS
    ) {
      angularVel.value = 0;
      angle.value = 0;
      lenVel.value = 0;
      len.value = REST_LEN;
    }
  });

  // Stop the integrator if the component unmounts mid-swing.
  useEffect(() => {
    return () => {
      cancelAnimation(angle);
      cancelAnimation(angularVel);
      cancelAnimation(len);
      cancelAnimation(lenVel);
    };
  }, [angle, angularVel, len, lenVel]);

  // --- Drag handling -----------------------------------------------------
  // Map finger position (relative to the stage) to BOTH angle and stretched
  // length around the fixed pivot. Track angular + radial velocity for a real
  // flick + snap on release.
  const lastAngle = useRef(0);
  const lastLen = useRef(REST_LEN);
  const lastT = useRef(0);
  const flingVel = useRef(0); // smoothed angular velocity (rad/s)
  const radialVel = useRef(0); // smoothed radial velocity (px/s)

  const fromTouch = (e: GestureResponderEvent) => {
    // locationX/Y are relative to the responder view (the stage).
    const { locationX, locationY } = e.nativeEvent;
    const dx = locationX - PIVOT_X;
    const dy = Math.max(locationY - PIVOT_Y, 1); // keep the ball below the pivot
    let a = Math.atan2(dx, dy); // angle from straight-down
    if (a > MAX_ANGLE) a = MAX_ANGLE;
    if (a < -MAX_ANGLE) a = -MAX_ANGLE;
    let l = Math.sqrt(dx * dx + dy * dy); // raw distance = how far it's pulled
    if (l < MIN_LEN) l = MIN_LEN;
    if (l > MAX_LEN) l = MAX_LEN;
    return { a, l };
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          dragging.value = true;
          angularVel.value = 0;
          lenVel.value = 0;
          lastTurnSign.value = 0;
          lastLenSign.value = 0;
          const { a, l } = fromTouch(e);
          angle.value = a;
          len.value = l;
          lastAngle.current = a;
          lastLen.current = l;
          lastT.current = Date.now();
          flingVel.current = 0;
          radialVel.current = 0;
        },
        onPanResponderMove: (e) => {
          const { a, l } = fromTouch(e);
          const now = Date.now();
          const dt = (now - lastT.current) / 1000;
          if (dt > 0) {
            // Smooth instantaneous velocities for clean flick + snap.
            const av = (a - lastAngle.current) / dt;
            const lv = (l - lastLen.current) / dt;
            flingVel.current = flingVel.current * 0.4 + av * 0.6;
            radialVel.current = radialVel.current * 0.4 + lv * 0.6;
          }
          angle.value = a;
          len.value = l;
          lastAngle.current = a;
          lastLen.current = l;
          lastT.current = now;
        },
        onPanResponderRelease: () => {
          dragging.value = false;
          // Hand off the flick (angular) + snap (radial), each clamped so the
          // integrator can't go wild. The radial spring does the bounce on its
          // own from wherever the string was stretched to; the released radial
          // velocity just adds a little extra life.
          const av = Math.max(-10, Math.min(10, flingVel.current));
          const lv = Math.max(-900, Math.min(900, radialVel.current));
          angularVel.value = av;
          lenVel.value = lv;
          lastTurnSign.value = av > 0 ? 1 : -1;
          lastLenSign.value = lv > 0 ? 1 : -1;
          // Tick on a real flick OR a real stretch let go (the snap-back).
          const stretched = Math.abs(len.value - REST_LEN) > 14;
          if (Math.abs(av) > 1.3 || stretched) hapticIf(hapticsEnabled, "tap");
        },
        onPanResponderTerminate: () => {
          dragging.value = false;
        },
      }),
    // shared values + refs are stable; hapticsEnabled is the only real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hapticsEnabled],
  );

  // Drive the SVG directly from the shared values via animated props, so the
  // string endpoint + ball position follow angle AND length every frame. This
  // keeps the elastic stretch visible (a rotate transform alone can't stretch).
  const ballAt = (a: number, l: number) => {
    "worklet";
    return {
      x: PIVOT_X + Math.sin(a) * l,
      y: PIVOT_Y + Math.cos(a) * l,
    };
  };

  const stringProps = useAnimatedProps(() => {
    const p = ballAt(angle.value, len.value);
    // Stop the visible string a touch short of the ball centre.
    const t = (len.value - BALL_R + 2) / len.value;
    return {
      x1: PIVOT_X,
      y1: PIVOT_Y,
      x2: PIVOT_X + (p.x - PIVOT_X) * t,
      y2: PIVOT_Y + (p.y - PIVOT_Y) * t,
    };
  });

  const ballGroupProps = useAnimatedProps(() => {
    const p = ballAt(angle.value, len.value);
    return { x: p.x - PIVOT_X, y: p.y - PIVOT_Y };
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.stage} {...panResponder.panHandlers}>
        <Svg
          width={STAGE_W}
          height={STAGE_H}
          style={styles.svg}
          pointerEvents="none"
        >
          {/* Static pivot nub on the (implied) bar. */}
          <Line
            x1={PIVOT_X - 30}
            y1={PIVOT_Y}
            x2={PIVOT_X + 30}
            y2={PIVOT_Y}
            stroke={colors.hairline}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <Circle
            cx={PIVOT_X}
            cy={PIVOT_Y}
            r={3}
            fill={colors.surface3}
            stroke={colors.hairline}
            strokeWidth={1}
          />

          {/* Elastic string — endpoint tracks angle + stretch every frame. */}
          <AnimatedLine
            animatedProps={stringProps}
            stroke={colors.hairlineSoft}
            strokeWidth={1.5}
          />

          {/* The ball, translated to the live string endpoint. Drawn around the
              pivot origin then offset, so the seams stay upright (no spin). */}
          <AnimatedG animatedProps={ballGroupProps}>
            <SoccerBall cx={PIVOT_X} cy={PIVOT_Y} r={BALL_R} />
          </AnimatedG>
        </Svg>
      </View>

      <Text preset="caption" muted center style={styles.line}>
        {LINES[lineIdx]}
      </Text>
    </View>
  );
}

/**
 * A flat soccer ball drawn from the classic truncated-icosahedron seams: a
 * centre pentagon ringed by hexagon spokes. Neutral fill, dark seams, and a
 * single accent pentagon — no gradients or glow.
 */
function SoccerBall({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const centre = pentagon(cx, cy, r * 0.34, -90);
  const spokeAngles = [-90, -18, 54, 126, 198];

  return (
    <G>
      {/* Ball body */}
      <Circle
        cx={cx}
        cy={cy}
        r={r}
        fill={colors.surface3}
        stroke={colors.hairline}
        strokeWidth={1.5}
      />
      {/* Accent pentagon (the one surgical use of green). */}
      <Polygon points={centre} fill={colors.yes} opacity={0.9} />
      {/* Seams from the centre pentagon vertices out toward the rim. */}
      {spokeAngles.map((deg, i) => {
        const inner = pointOn(cx, cy, r * 0.34, deg);
        const outer = pointOn(cx, cy, r * 0.92, deg);
        return (
          <Line
            key={i}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke={colors.bg}
            strokeWidth={2}
            strokeLinecap="round"
          />
        );
      })}
      {/* Small dark nodes between spokes to suggest the panel pattern. */}
      {spokeAngles.map((deg, i) => {
        const mid = pointOn(cx, cy, r * 0.86, deg + 36);
        return (
          <Circle key={`p-${i}`} cx={mid.x} cy={mid.y} r={2.2} fill={colors.bg} />
        );
      })}
    </G>
  );
}

// --- tiny geometry helpers (module-level, pure) ---
function pointOn(cx: number, cy: number, dist: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * dist, y: cy + Math.sin(rad) * dist };
}

function pentagon(cx: number, cy: number, r: number, startDeg: number) {
  return [0, 1, 2, 3, 4]
    .map((i) => {
      const p = pointOn(cx, cy, r, startDeg + i * 72);
      return `${p.x},${p.y}`;
    })
    .join(" ");
}

const styles = StyleSheet.create({
  // No card, no box, no fill — just reserved space so layout stays stable while
  // the ball is free to swing out and overlap neighbouring content.
  wrap: {
    minHeight: 252,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  // The drag surface is the swing footprint; overflow visible lets the ball
  // fly past its bounds (the "popped off the page" feel).
  stage: {
    width: STAGE_W,
    height: STAGE_H,
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
    backgroundColor: "transparent",
  },
  svg: {
    overflow: "visible",
  },
  line: {
    marginTop: spacing.xs,
    letterSpacing: 0.2,
  },
});
