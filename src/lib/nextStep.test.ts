import { describe, expect, it } from "vitest";

import { nextStep, type StepInput } from "./nextStep";

const base: StepInput = {
  mine: true,
  closed: false,
  conflicting: false,
  pending: 0,
  mergeReady: false,
  draft: false,
  behind: false,
  blocked: false,
  drafts: 0,
  approved: false,
  onFilesTab: false,
  rereview: false,
  stale: false,
};

describe("nextStep", () => {
  it("on my PR, unblocks before it ships", () => {
    expect(nextStep({ ...base, conflicting: true, pending: 2, mergeReady: true })).toBe("conflicts");
    expect(nextStep({ ...base, pending: 2, mergeReady: true })).toBe("autopilot");
    expect(nextStep({ ...base, mergeReady: true, behind: true })).toBe("merge");
    expect(nextStep({ ...base, mergeReady: true, blocked: true })).toBeNull();
    expect(nextStep({ ...base, draft: true })).toBe("ready");
    expect(nextStep({ ...base, behind: true })).toBe("update-branch");
    expect(nextStep(base)).toBeNull();
  });

  it("on my PR, asks reviewers to come back", () => {
    expect(nextStep({ ...base, pending: 1, rereview: true })).toBe("autopilot");
    expect(nextStep({ ...base, rereview: true })).toBe("rereview");
    expect(nextStep({ ...base, rereview: true, draft: true })).toBe("ready");
    expect(nextStep({ ...base, stale: true, behind: true })).toBe("update-branch");
    expect(nextStep({ ...base, stale: true })).toBe("nudge");
  });

  it("on someone else's PR, leads to the review", () => {
    const theirs = { ...base, mine: false };
    expect(nextStep(theirs)).toBe("review-files");
    expect(nextStep({ ...theirs, onFilesTab: true })).toBeNull();
    expect(nextStep({ ...theirs, onFilesTab: true, drafts: 2 })).toBe("send-review");
    expect(nextStep({ ...theirs, approved: true })).toBeNull();
  });

  it("does nothing on a closed PR", () => {
    expect(nextStep({ ...base, closed: true, pending: 3 })).toBeNull();
  });
});
