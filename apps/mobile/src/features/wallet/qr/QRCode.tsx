import React, { useMemo } from "react";
import { View, type ViewStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encodeQR, type ECLevel } from "./encoder";

/**
 * QRCode — renders a QR matrix as crisp SVG, dependency-free.
 *
 * We encode the payload ourselves ({@link encodeQR}) and draw the dark modules
 * as a single SVG <Path> (one draw call, sharp at any size, identical on web +
 * native). A light quiet-zone border is baked in (4 modules, per spec) so
 * scanners lock on reliably. Used for the Solana Pay deposit QR.
 *
 * Defaults to a near-white module colour on a dark rounded card so it reads as a
 * premium "scan me" panel rather than a stark black/white block.
 */
export interface QRCodeProps {
  value: string;
  /** Pixel size of the square (including quiet zone). Default 200. */
  size?: number;
  /** Module (dark) colour. */
  color?: string;
  /** Background colour of the whole square (quiet zone included). */
  background?: string;
  /** Error-correction level. Higher = more robust but denser. Default 'M'. */
  ecLevel?: ECLevel;
  /** Quiet-zone width in modules (spec minimum is 4). */
  quietZone?: number;
  style?: ViewStyle;
}

export function QRCode({
  value,
  size = 200,
  color = "#0a0b0f",
  background = "#f4f6fb",
  ecLevel = "M",
  quietZone = 4,
  style,
}: QRCodeProps) {
  const { path, total } = useMemo(() => {
    let matrix: boolean[][];
    try {
      matrix = encodeQR(value, ecLevel);
    } catch {
      matrix = [];
    }
    const count = matrix.length;
    const totalModules = count + quietZone * 2;
    // Build a single path string of 1x1 rects for every dark module, offset by
    // the quiet zone. One Path keeps the SVG light even on dense versions.
    let d = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (matrix[r]![c]) {
          const x = c + quietZone;
          const y = r + quietZone;
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { path: d, total: totalModules };
  }, [value, ecLevel, quietZone]);

  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill={background} />
        {path ? <Path d={path} fill={color} /> : null}
      </Svg>
    </View>
  );
}
