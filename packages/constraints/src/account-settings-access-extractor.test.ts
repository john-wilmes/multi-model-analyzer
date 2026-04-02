import { describe, it, expect, beforeAll } from "vitest";
import { extractAccountSettingsAccesses } from "./account-settings-access-extractor.js";
import { initTreeSitter } from "@mma/parsing";
import type { CredentialAccess } from "./types.js";

function access(
  accesses: readonly CredentialAccess[],
  field: string,
): CredentialAccess | undefined {
  return accesses.find((a) => a.field === field);
}

describe("extractAccountSettingsAccesses", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractAccountSettingsAccesses([]);
    expect(result.accesses).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.filesScanned).toBe(0);
    expect(result.stats.filesWithAccesses).toBe(0);
    expect(result.stats.totalAccesses).toBe(0);
  });

  it("skips files with no account settings accesses", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/foo.js",
        content: `
          function handler(req) {
            return req.body.name;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(0);
    expect(result.stats.filesWithAccesses).toBe(0);
  });

  it("detects user.settings.X", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/scheduling.js",
        content: `
          function getTimezone(user) {
            return user.settings.timezone;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "timezone")!;
    expect(a).toBeDefined();
    expect(a.accessKind).toBe("read");
    expect(a.file).toBe("routes/scheduling.js");
  });

  it("detects session.user.settings.X", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/appointments.js",
        content: `
          function handler(session) {
            const duration = session.user.settings.scheduler.appointmentDuration;
            return duration;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "scheduler.appointmentDuration")!;
    expect(a).toBeDefined();
    expect(a.accessKind).toBe("read");
  });

  it("detects req.user.settings.X", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/cancel.js",
        content: `
          function handler(req) {
            if (req.user.settings.cancellation.shadowAppointment) {
              createShadow();
            }
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "cancellation.shadowAppointment")!;
    expect(a).toBeDefined();
    expect(a.guardConditions).toHaveLength(1);
    expect(a.guardConditions[0]!.operator).toBe("truthy");
  });

  it("detects facility.settings.X", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/facility.js",
        content: `
          function getHours(facility) {
            return facility.settings.communication.smsEnabled;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "communication.smsEnabled")!;
    expect(a).toBeDefined();
  });

  it("handles optional chaining", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/settings.js",
        content: `
          function check(user) {
            return user?.settings?.scheduler?.bufferTime;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    expect(access(result.accesses, "scheduler.bufferTime")).toBeDefined();
  });

  it("skips integrator sub-paths", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/integrator.js",
        content: `
          function check(user) {
            const a = user.settings.integrator.syncEnabled;
            const b = user.settings.integrator;
            const c = user.settings.timezone;
          }
        `,
      },
    ]);
    // Only timezone should be captured, not integrator sub-paths
    expect(result.accesses).toHaveLength(1);
    expect(access(result.accesses, "timezone")).toBeDefined();
  });

  it("detects default fallback with || operator", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/settings.js",
        content: `
          function getDuration(user) {
            return user.settings.scheduler.appointmentDuration || 30;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "scheduler.appointmentDuration")!;
    expect(a.accessKind).toBe("default-fallback");
    expect(a.hasDefault).toBe(true);
  });

  it("detects write access (assignment)", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/admin.js",
        content: `
          function setTimezone(user) {
            user.settings.timezone = 'US/Eastern';
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "timezone")!;
    expect(a.accessKind).toBe("write");
  });

  it("resolves variable aliases", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/handler.js",
        content: `
          function handler(user) {
            const userSettings = user.settings;
            const tz = userSettings.timezone;
            const dur = userSettings.scheduler.appointmentDuration;
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(2);
    expect(access(result.accesses, "timezone")).toBeDefined();
    expect(access(result.accesses, "scheduler.appointmentDuration")).toBeDefined();
  });

  it("detects lodash _.get with settings path", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/util.js",
        content: `
          function getVal(user) {
            return _.get(user, 'settings.scheduler.bufferTime', 0);
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    const a = access(result.accesses, "scheduler.bufferTime")!;
    expect(a).toBeDefined();
    expect(a.accessKind).toBe("default-fallback");
    expect(a.hasDefault).toBe(true);
  });

  it("lodash _.get skips integrator paths", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/util.js",
        content: `
          function getVal(user) {
            const a = _.get(user, 'settings.integrator.syncEnabled', false);
            const b = _.get(user, 'settings.timezone', 'UTC');
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    expect(access(result.accesses, "timezone")).toBeDefined();
  });

  it("strips method calls from field extraction", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/format.js",
        content: `
          function format(user) {
            return user.settings.timezone.toLowerCase();
          }
        `,
      },
    ]);
    expect(result.accesses).toHaveLength(1);
    expect(access(result.accesses, "timezone")).toBeDefined();
  });

  it("counts patterns correctly across files", async () => {
    const result = await extractAccountSettingsAccesses([
      {
        path: "routes/a.js",
        content: `
          function a(user) { return user.settings.timezone; }
        `,
      },
      {
        path: "routes/b.js",
        content: `
          function b(req) { return req.user.settings.timezone; }
        `,
      },
      {
        path: "routes/c.js",
        content: `
          function c(facility) { return facility.settings.locale; }
        `,
      },
    ]);
    expect(result.stats.filesScanned).toBe(3);
    expect(result.stats.filesWithAccesses).toBe(3);
    expect(result.stats.totalAccesses).toBe(3);
    expect(result.stats.byPattern["user.settings"]).toBe(1);
    expect(result.stats.byPattern["req.user.settings"]).toBe(1);
    expect(result.stats.byPattern["facility.settings"]).toBe(1);
  });
});
