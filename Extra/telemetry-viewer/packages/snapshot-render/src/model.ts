/**
 * UISnapshot model — TypeScript twin of schema v2 from
 * `Assets/Runtime/Telemetry/Snapshot/SnapshotModel.cs`. Field names match the
 * YAML keys exactly (js-yaml load output); types are deliberately tolerant of
 * partially-captured nodes (`unknown` where the exporter may omit fields).
 */

export interface SnapshotRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface SnapshotAnchorShape {
  pivotX?: number;
  pivotY?: number;
  anchorMinX?: number;
  anchorMinY?: number;
  anchorMaxX?: number;
  anchorMaxY?: number;
  anchoredX?: number;
  anchoredY?: number;
  sizeX?: number;
  sizeY?: number;
}

export interface SnapshotLayoutShape {
  type?: string;
  runtimeSwitchable?: boolean;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  spacing?: number;
  childAlignment?: string;
  controlChildWidth?: boolean;
  controlChildHeight?: boolean;
  childForceExpandWidth?: boolean;
  childForceExpandHeight?: boolean;
  reverseArrangement?: boolean;
}

export interface SnapshotLayoutElementShape {
  minWidth?: number;
  minHeight?: number;
  preferredWidth?: number;
  preferredHeight?: number;
  flexibleWidth?: number;
  flexibleHeight?: number;
  ignoreLayout?: boolean;
}

export interface SnapshotContentSizeFitterShape {
  horizontalMode?: string;
  verticalMode?: string;
}

export interface SnapshotResolvedShape {
  colorRoles?: Record<string, string> | null;
  textRole?: string | null;
  text?: string | null;
  fontSize?: number | null;
  fontWeight?: string | null;
  fontName?: string | null;
  textWidth?: number | null;
  color?: string | null;
  backgroundColor?: string | null;
  fillColor?: string | null;
  outlineColor?: string | null;
  outlineWidth?: number | null;
  opacity?: number | null;
  cornerRadius?: number | null;
}

export interface SnapshotNode {
  id: string;
  kind?: string;
  name?: string;
  type?: string;
  parentId?: string | null;
  siblingIndex?: number;
  active?: boolean;
  isView?: boolean;
  layer?: string | null;
  rect?: SnapshotRect | null;
  rectLocal?: SnapshotRect | null;
  anchor?: SnapshotAnchorShape | null;
  layout?: SnapshotLayoutShape | null;
  layoutElement?: SnapshotLayoutElementShape | null;
  contentSizeFitter?: SnapshotContentSizeFitterShape | null;
  data?: Record<string, unknown> | null;
  resolved?: SnapshotResolvedShape | null;
}

export interface SnapshotTextStyle {
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  fontName?: string;
  characterSpacing?: number;
  lineSpacing?: number;
}

export interface SnapshotTheme {
  seedColor?: string;
  isDark?: boolean;
  deviceType?: string;
  palette?: Record<string, string>;
  spacing?: Record<string, number>;
  sizing?: Record<string, number>;
  typography?: Record<string, SnapshotTextStyle>;
}

export interface SnapshotViewInfo {
  id?: string;
  name?: string;
  type?: string;
  layer?: string;
}

export interface SnapshotAppInfo {
  productName?: string;
  productVersion?: string;
  unityVersion?: string;
  platform?: string;
  deviceType?: string;
  sessionId?: string | null;
  screenWidth?: number;
  screenHeight?: number;
  scaleFactor?: number;
}

/** The parsed snapshot document consumed by the renderers (schema v2 / v1). */
export interface UISnapshot {
  schemaVersion: number;
  timestampUtc?: string | null;
  app?: SnapshotAppInfo | null;
  view?: SnapshotViewInfo | null;
  theme?: SnapshotTheme | null;
  nodes: SnapshotNode[];
  /** Client-ready hierarchy: siblingIndex-ordered children per node id. */
  childrenOf: Record<string, string[]>;
  rootId: string;
  warnings: string[];
}

export interface SnapshotRenderOptions {
  /** Root palette to apply: the snapshot's captured theme by default. */
  palette?: Record<string, string> | null;
  /** Root typography table to apply (snapshot's captured theme by default). */
  typography?: Record<string, SnapshotTextStyle> | null;
  /** Debug outlines for pure layout containers. */
  showLayoutOutlines?: boolean;
  /** Extra CSS class(es) on the stage element. */
  stageClassName?: string;
}
