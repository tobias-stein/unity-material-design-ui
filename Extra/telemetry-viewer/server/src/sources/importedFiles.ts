/**
 * Imported-files source (P6): the explicit multi-file pick. A user selects
 * `.lp` files in the browser, the client posts their *contents* (the tool
 * never uploads anything to disk — everything lives in process memory) and
 * — while active — this provider alone defines the temporary session
 * universe (directory scan + InfluxDB are bypassed, §3.10).
 *
 * Strictly read-only toward every on-disk source; nothing is persisted.
 */
import type { RawEventResult, SourceProvider, SourceStatus } from "../domain.js";
import { parseLpDocuments } from "./lp.js";
import { projectSessions } from "../core/sessionProjection.js";

export interface ImportedLpFileInfo {
  name: string;
  bytes: number;
}

export class ImportedLpFilesSource implements SourceProvider {
  readonly id = "imported-files" as const;

  private readonly result: RawEventResult;
  private readonly infos: ImportedLpFileInfo[];
  private readonly sessionIds: string[];

  constructor(
    /** `name` is display-only; must not be used for any filesystem access. */
    documents: Array<{ name: string; content: string }>,
  ) {
    this.infos = documents.map((doc) => ({ name: doc.name, bytes: Buffer.byteLength(doc.content, "utf8") }));
    this.result = parseLpDocuments(documents.map((doc) => ({ file: doc.name, content: doc.content })));
    this.sessionIds = [...new Set(projectSessions(this.result.events).map((session) => session.id))];
  }

  get files(): ImportedLpFileInfo[] {
    return this.infos;
  }

  get eventCount(): number {
    return this.result.events.length;
  }

  get malformedCount(): number {
    return this.result.malformedCount;
  }

  get sessions(): string[] {
    return this.sessionIds;
  }

  async describe(): Promise<SourceStatus> {
    return {
      id: "imported-files",
      available: true,
      state: "ok",
      message: "In-memory imported .lp universe (session list shows only these files).",
      facts: {
        files: this.files.length,
        fileNames: this.files.map((file) => file.name).join(", "),
        events: this.eventCount,
        sessions: this.sessions.length,
        malformedLines: this.malformedCount,
      },
    };
  }

  async fetchEvents(): Promise<RawEventResult> {
    // Parse result is cached from construction: imports are immutable.
    return this.result;
  }
}
