import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { describeNow } from "../src/status-note.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** A run that only ends when it is aborted, with the session it reports. */
function hangingRun(session: any = { dispose: vi.fn(), subscribe: vi.fn() }) {
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
    options.onSessionCreated?.(session);
    return new Promise((resolve) => {
      options.signal.addEventListener("abort", () =>
        resolve({ responseText: "half done", session, aborted: false, steered: false }));
    });
  });
}

describe("time limit", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops a run at max_minutes and reports it as an error", async () => {
    manager = new AgentManager();
    hangingRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 0.001,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/^Stopped after 0.001 minutes, this agent's time limit \(max_minutes\)/);
    expect(record.result).toBe("half done");
  });

  it("takes the manager default, and 0 means no limit", async () => {
    manager = new AgentManager();
    manager.setDefaultMaxMinutes(0.001);
    hangingRun();
    const limited = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true,
    }))!;
    const unlimited = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 0,
    }))!;
    await limited.promise;
    expect(limited.status).toBe("error");
    expect(unlimited.maxMinutes).toBeUndefined();
    expect(unlimited.status).toBe("running");
    manager.abort(unlimited.id);
    await unlimited.promise;
    expect(unlimited.status).toBe("stopped");
  });

  it("stops a foreground resume at the time limit too", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: { dispose: vi.fn() }, aborted: false, steered: false } as any);
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 0.001,
    }))!;
    await record.promise;
    expect(record.status).toBe("completed");
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options: any) =>
      new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ text: "half" }));
      }));
    await manager.resume(record.id, "again");
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/^Stopped after 0.001 minutes/);
  });

  it("lets a stop reach a foreground resume", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: { dispose: vi.fn() }, aborted: false, steered: false } as any);
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true,
    }))!;
    await record.promise;
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options: any) =>
      new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ text: "half" }));
      }));
    const resumed = manager.resume(record.id, "again");
    expect(manager.abort(record.id)).toBe(true);
    await resumed;
    expect(record.status).toBe("stopped");
  });

  it("refuses a foreground resume of a running agent, keeping its limit and stop", async () => {
    manager = new AgentManager();
    hangingRun();
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 0.002,
    }))!;
    const controller = record.abortController;
    expect(await manager.resume(record.id, "again")).toBeUndefined();
    expect(record.abortController).toBe(controller);
    await record.promise;
    expect(record.error).toMatch(/^Stopped after 0.002 minutes/);
  });

  it("ignores a limit that is not positive", () => {
    manager = new AgentManager();
    hangingRun();
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: -5,
    }))!;
    expect(record.maxMinutes).toBeUndefined();
    manager.abort(record.id);
  });

  it("caps a huge limit at the longest timer Node keeps", async () => {
    manager = new AgentManager();
    hangingRun();
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 99_999,
    }))!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(record.status).toBe("running");
    manager.abort(record.id);
    await record.promise;
  });

  it("leaves a user stop a stop", async () => {
    manager = new AgentManager();
    hangingRun();
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true, maxMinutes: 60,
    }))!;
    manager.abort(record.id);
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });
});

describe("what a running agent is doing", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("tracks the oldest running tool, else the model since its last output", async () => {
    let listener: ((event: any) => void) | undefined;
    manager = new AgentManager();
    hangingRun({ dispose: vi.fn(), subscribe: (fn: any) => { listener = fn; return () => {}; } });
    const record = manager.getRecord(manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "d", isBackground: true,
    }))!;
    const at = (iso: string, event: any) => {
      vi.setSystemTime(new Date(iso));
      listener!(event);
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      at("2026-11-09T09:50:00", { type: "turn_start" });
      expect(record.now).toEqual({ since: new Date("2026-11-09T09:50:00").getTime() });
      at("2026-11-09T09:55:00", { type: "message_update" });
      at("2026-11-09T09:56:00", { type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
      at("2026-11-09T09:57:00", { type: "tool_execution_start", toolCallId: "b", toolName: "read" });
      at("2026-11-09T09:58:00", { type: "tool_execution_end", toolCallId: "b" });
      expect(describeNow(record, new Date("2026-11-09T14:10:00").getTime()))
        .toBe("running bash since 09:56 (4h 14m)");
      at("2026-11-09T14:10:00", { type: "tool_execution_end", toolCallId: "a" });
      expect(describeNow(record, new Date("2026-11-09T14:22:30").getTime()))
        .toBe("waiting on the model since 14:10 (12m)");
      at("2026-11-09T14:23:00", { type: "agent_end" });
      expect(record.now).toBeUndefined();
    } finally {
      vi.useRealTimers();
      manager.abort(record.id);
    }
  });

  it("says nothing for an agent that is not running", () => {
    const record = { status: "completed", now: { since: 0 } } as AgentRecord;
    expect(describeNow(record)).toBeUndefined();
  });
});
