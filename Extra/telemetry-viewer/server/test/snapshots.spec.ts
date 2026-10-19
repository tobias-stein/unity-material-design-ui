/**
 * Snapshot parse tests (P2): schema-v2 YAML parsing, .gz sniffing, schema
 * drift warnings, the geometry warning (captured-before-layout), and
 * hierarchy derivation with the standalone viewer's id normalization.
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  geometryWarning,
  parseSnapshotBytes,
  parseSnapshotText,
  decodeSnapshotBytes,
  SnapshotParseError,
  type ParsedSnapshot,
} from "../src/snapshots/parse.js";

const baseSnapshot = {
  schemaVersion: 2,
  timestampUtc: "2026-10-18T10:28:00Z",
  app: { productName: "Unity-MaterialDesign-UI", sessionId: "abc", platform: "OSXEditor" },
  view: { id: "view1", name: "UIDemoMainMenu", type: "mdu.ui.UIDemoMainMenu", layer: "DEFAULT" },
  theme: { isDark: false, palette: { Primary: "#6750A4" } },
  nodes: [
    {
      id: "root",
      type: "mdu.ui.UIDemoMainMenu",
      name: "UIDemoMainMenu",
      kind: "ui",
      isView: true,
      active: true,
      siblingIndex: 0,
      rect: { x: 0, y: 0, width: 800, height: 600 },
    },
    {
      id: "btn",
      type: "mdu.ui.Button",
      name: "PlayButton",
      kind: "ui",
      parentId: "root",
      siblingIndex: 1,
      active: true,
      rect: { x: 100, y: 100, width: 120, height: 40 },
    },
    {
      id: "label",
      type: "mdu.ui.Text",
      name: "PlayLabel",
      kind: "ui",
      parentId: "root",
      siblingIndex: 0,
      active: true,
      rect: { x: 40, y: 80, width: 200, height: 24 },
    },
  ],
};

function yamlOf(doc: unknown): string {
  return `# generated test snapshot\n${JSON.stringify(doc)}\n`;
}

describe("snapshot parsing", () => {
  it("parses schema-v2 YAML and derives hierarchy", () => {
    const parsed = parseSnapshotText(yamlOf(baseSnapshot));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.rootId).toBe("root");
    expect(parsed.childrenOf["root"]).toEqual(["label", "btn"]);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.view?.["name"]).toBe("UIDemoMainMenu");
  });

  it("sniffs gzip by magic bytes and round-trips .yaml.gz bytes", () => {
    const gz = gzipSync(Buffer.from(yamlOf(baseSnapshot), "utf8"));
    expect(decodeSnapshotBytes(new Uint8Array(gz))).toBe(yamlOf(baseSnapshot));
    const parsed = parseSnapshotBytes(new Uint8Array(gz));
    expect(parsed.rootId).toBe("root");
  });

  it("accepts schema v1 with no warning and flags future versions", () => {
    const v1: Record<string, unknown> = { ...baseSnapshot, schemaVersion: 1 };
    const parsedV1 = parseSnapshotText(yamlOf(v1));
    expect(parsedV1.schemaVersion).toBe(1);
    expect(parsedV1.warnings).toEqual([]);

    const future = parseSnapshotText(yamlOf({ ...baseSnapshot, schemaVersion: 3 }));
    expect(future.warnings.some((w) => w.includes("schemaVersion 3"))).toBe(true);
  });

  it("surfaces the geometry warning for captured-but-unlaid-out snapshots", () => {
    // >20% of active nodes outside the 400×300 root (the exporter's classic
    // pre-layout capture), reusing the standalone viewer's exact wording.
    const doc = {
      ...baseSnapshot,
      nodes: [
        baseSnapshot.nodes[0], // root with 400x300
      ].concat(
        Array.from({ length: 3 }, (_, i) => ({
          id: `out${i}`,
          type: "mdu.ui.Button",
          kind: "ui",
          parentId: "root",
          siblingIndex: i,
          active: true,
          rect: { x: 700, y: 900, width: 100, height: 40 },
        })),
      ),
    } satisfies typeof baseSnapshot;
    const parsed = parseSnapshotText(yamlOf(doc));
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("capture likely ran before layout was applied");
  });

  it("geometryWarning is null when rects are inside the root", () => {
    const byId = new Map<string, ParsedSnapshot["nodes"][number]>(
      (parseSnapshotText(yamlOf(baseSnapshot)).nodes as Array<never>).map((node) => [String((node as never as Record<string, unknown>)["id"]), node]),
    );
    void byId;
    const parsed: ParsedSnapshot = parseSnapshotText(yamlOf(baseSnapshot));
    const map = new Map(parsed.nodes.map((node) => [String(node["id"]), node]));
    expect(geometryWarning(map, "root")).toBeNull();
  });

  it("normalizes missing and duplicate node ids exactly like the standalone viewer", () => {
    const doc = {
      ...baseSnapshot,
      nodes: [
        { ...baseSnapshot.nodes[0], id: "a" },
        { ...baseSnapshot.nodes[1], id: undefined }, // → anon:1 (viewer logic)
        { ...baseSnapshot.nodes[2], id: "a" }, // duplicate → a#2
      ],
    };
    const parsed = parseSnapshotText(yamlOf(doc));
    expect(parsed.nodes.map((node) => node["id"])).toEqual(["a", "anon:1", "a#2"]);
  });

  it("errors honestly on empty and non-mapping snapshots", () => {
    expect(() => parseSnapshotText("nodes: []")).toThrow(SnapshotParseError);
    expect(() => parseSnapshotText(yamlOf({ schemaVersion: 2, nodes: [] }))).toThrowError(/no nodes/);
    try {
      parseSnapshotText("- just\n- a\n- list");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotParseError);
      expect((error as SnapshotParseError).code).toBe("SNAPSHOT_YAML_INVALID");
    }
  });

  it("orphan nodes attach under the first root for rendering", () => {
    const doc = {
      ...baseSnapshot,
      nodes: [...baseSnapshot.nodes, { id: "orphan", type: "mdu.ui.Text", kind: "ui", active: true, siblingIndex: 7 }],
    };
    const parsed = parseSnapshotText(yamlOf(doc));
    expect(parsed.childrenOf["root"]).toContain("orphan");
    expect(parsed.nodes.find((node) => node["id"] === "orphan")?.["parentId"]).toBe("root");
  });
});
