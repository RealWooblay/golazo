import React from "react";
import Svg, { Circle, Path, Polyline } from "react-native-svg";

/**
 * icons — a tiny, dependency-free icon set (react-native-svg, web-safe) so we
 * don't pull a whole icon library into the foundation. Each takes `size` + `color`
 * and inherits the current accent. Stroke-based, 24px grid, rounded caps to match
 * the premium feel.
 *
 * Add more as features need them; keep them stroke-only + 24-grid for consistency.
 */
export interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

function base(size: number) {
  return { width: size, height: size, viewBox: "0 0 24 24" } as const;
}

/** Play / lobby — a ball-ish target. */
export function IconPlay({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M12 7l3.5 2.5-1.3 4h-4.4l-1.3-4L12 7z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Wallet. */
export function IconWallet({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Path
        d="M3 7.5A2.5 2.5 0 015.5 5h11A1.5 1.5 0 0118 6.5V8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Path
        d="M3 7.5V17a2 2 0 002 2h13a2 2 0 002-2v-6a2 2 0 00-2-2H5a2 2 0 01-2-1.5z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Circle cx="16.5" cy="13" r="1.2" fill={color} />
    </Svg>
  );
}

/** Profile / person. */
export function IconProfile({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Circle
        cx="12"
        cy="8.5"
        r="3.5"
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <Path
        d="M5 19c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Back chevron. */
export function IconBack({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Polyline
        points="14,6 8,12 14,18"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Close X. */
export function IconClose({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Path
        d="M6 6l12 12M18 6L6 18"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Plus (deposit). */
export function IconPlus({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Path
        d="M12 5v14M5 12h14"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Arrow up (withdraw / send). */
export function IconArrowUp({
  size = 24,
  color = "#fff",
  strokeWidth = 2,
}: IconProps) {
  return (
    <Svg {...base(size)} fill="none">
      <Path
        d="M12 19V6M6 11l6-6 6 6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
