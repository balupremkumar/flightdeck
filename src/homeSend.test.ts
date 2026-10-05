import { describe, expect, it } from "vitest";
import { cardStateKey, effectiveSend, SEND_IDLE, sendReducer, sendsReducer, type SendState } from "./home";

describe("sendReducer", () => {
  it("walks idle -> sending -> sent", () => {
    let s: SendState = SEND_IDLE;
    s = sendReducer(s, { type: "start" });
    expect(s).toEqual({ phase: "sending" });
    s = sendReducer(s, { type: "ok", key: "needs|question|5" });
    expect(s).toEqual({ phase: "sent", key: "needs|question|5" });
  });

  it("a rejected send lands in failed with the message, and can be retried", () => {
    let s = sendReducer(sendReducer(SEND_IDLE, { type: "start" }), { type: "fail", error: "nope" });
    expect(s).toEqual({ phase: "failed", error: "nope" });
    s = sendReducer(s, { type: "start" });
    expect(s.phase).toBe("sending");
  });

  it("start while sending returns the same object (no double send state)", () => {
    const sending = sendReducer(SEND_IDLE, { type: "start" });
    expect(sendReducer(sending, { type: "start" })).toBe(sending);
  });

  it("ok and fail are ignored unless a send is in flight", () => {
    expect(sendReducer(SEND_IDLE, { type: "ok", key: "k" })).toBe(SEND_IDLE);
    expect(sendReducer(SEND_IDLE, { type: "fail", error: "x" })).toBe(SEND_IDLE);
  });

  it("reset returns to idle", () => {
    expect(sendReducer({ phase: "failed", error: "x" }, { type: "reset" })).toBe(SEND_IDLE);
  });
});

describe("effectiveSend", () => {
  it("Sent holds while the card's state key is unchanged, then clears on a state change", () => {
    const sent: SendState = { phase: "sent", key: "needs|question|5" };
    expect(effectiveSend(sent, "needs|question|5")).toBe(sent);
    expect(effectiveSend(sent, "working|null|9")).toBe(SEND_IDLE);
  });
  it("failed and sending are not cleared by a key change", () => {
    const failed: SendState = { phase: "failed", error: "x" };
    expect(effectiveSend(failed, "anything")).toBe(failed);
    expect(effectiveSend(undefined, "k")).toBe(SEND_IDLE);
  });
});

describe("sendsReducer (per pane)", () => {
  it("keeps panes independent", () => {
    let m = sendsReducer({}, { paneId: 1, type: "start" });
    m = sendsReducer(m, { paneId: 2, type: "start" });
    m = sendsReducer(m, { paneId: 1, type: "fail", error: "e" });
    expect(m[1]).toEqual({ phase: "failed", error: "e" });
    expect(m[2]).toEqual({ phase: "sending" });
  });
  it("returns the same map when nothing changes", () => {
    const m = {};
    expect(sendsReducer(m, { paneId: 1, type: "ok", key: "k" })).toBe(m);
  });
});

describe("cardStateKey", () => {
  it("changes with column, kind or since", () => {
    const base = { column: "needs" as const, kind: "question" as const, since: 1 };
    expect(cardStateKey(base)).not.toBe(cardStateKey({ ...base, since: 2 }));
    expect(cardStateKey(base)).not.toBe(cardStateKey({ ...base, kind: "permission" }));
    expect(cardStateKey(base)).not.toBe(cardStateKey({ ...base, column: "working", kind: null as never }));
  });
});
