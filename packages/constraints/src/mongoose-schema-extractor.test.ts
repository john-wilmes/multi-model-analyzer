import { describe, it, expect, beforeAll } from "vitest";
import {
  extractMongooseSettingsSchema,
  extractMongooseAccountSettingsSchema,
} from "./mongoose-schema-extractor.js";
import { initTreeSitter } from "@mma/parsing";
import type { ConfigField } from "./types.js";

function field(fields: readonly ConfigField[], name: string): ConfigField | undefined {
  return fields.find((f) => f.name === name);
}

describe("extractMongooseSettingsSchema", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractMongooseSettingsSchema([]);
    expect(result.schemas).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips files with no settings/integrator block", async () => {
    const result = await extractMongooseSettingsSchema([
      { path: "models/foo.ts", content: "export const something = {};" },
    ]);
    expect(result.schemas).toHaveLength(0);
  });

  it("extracts descriptor fields from integrator block", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  integrator: {
    requireLock: {
      type: Boolean,
      required: false,
      default: false,
    },
    lockExpiryInMinutes: {
      type: Number,
      required: false,
      default: 10,
    },
  },
};`,
      },
    ]);
    expect(result.schemas).toHaveLength(1);
    const schema = result.schemas[0]!;
    expect(schema.integratorType).toBe("__integrator_settings__");
    expect(schema.sourceFiles).toEqual(["models/setting.ts"]);

    const lock = field(schema.fields, "requireLock")!;
    expect(lock).toBeDefined();
    expect(lock.inferredType).toBe("boolean");
    expect(lock.required).toBe(false);
    expect(lock.hasDefault).toBe(true);
    expect(lock.defaultValue).toBe(false);

    const expiry = field(schema.fields, "lockExpiryInMinutes")!;
    expect(expiry.inferredType).toBe("number");
    expect(expiry.defaultValue).toBe(10);
  });

  it("extracts nested fields with dotted paths", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  integrator: {
    syncWindow: {
      earliest: {
        type: Number,
        required: true,
        default: 6,
      },
      latest: {
        type: Number,
        required: true,
        default: 20,
      },
      days: {
        type: Number,
        required: false,
        default: 180,
      },
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(field(schema.fields, "syncWindow.earliest")!.defaultValue).toBe(6);
    expect(field(schema.fields, "syncWindow.latest")!.defaultValue).toBe(20);
    expect(field(schema.fields, "syncWindow.days")!.defaultValue).toBe(180);
  });

  it("resolves shorthand property references to top-level consts", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const parallelSyncs = {
  enabled: {
    type: Boolean,
    required: false,
    default: true,
  },
  amount: {
    type: Number,
    required: false,
    default: 7,
  },
};

const settings = {
  integrator: {
    sync: {
      appointments: {
        parallelSyncs,
        cacheEffectiveDatesRanges: {
          type: Boolean,
          required: false,
          default: false,
        },
      },
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    const enabled = field(schema.fields, "sync.appointments.parallelSyncs.enabled")!;
    expect(enabled).toBeDefined();
    expect(enabled.inferredType).toBe("boolean");
    expect(enabled.defaultValue).toBe(true);

    const amount = field(schema.fields, "sync.appointments.parallelSyncs.amount")!;
    expect(amount).toBeDefined();
    expect(amount.inferredType).toBe("number");
    expect(amount.defaultValue).toBe(7);

    const cache = field(schema.fields, "sync.appointments.cacheEffectiveDatesRanges")!;
    expect(cache).toBeDefined();
    expect(cache.inferredType).toBe("boolean");
  });

  it("resolves identifier values referencing top-level consts", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const practiceResourceSyncExpiry = {
  expireAt: {
    type: String,
    enum: ['none', 'next-day-end-of-sync-window', 'next-day-end-of-day'],
    required: false,
    default: 'none',
  },
};

const settings = {
  integrator: {
    sync: {
      practiceResourcesCacheExpiry: {
        appointmentTypes: practiceResourceSyncExpiry,
        facilities: practiceResourceSyncExpiry,
        providers: practiceResourceSyncExpiry,
      },
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    const atExpiry = field(
      schema.fields,
      "sync.practiceResourcesCacheExpiry.appointmentTypes.expireAt",
    )!;
    expect(atExpiry).toBeDefined();
    expect(atExpiry.inferredType).toBe("string");
    expect(atExpiry.defaultValue).toBe("none");

    const facExpiry = field(
      schema.fields,
      "sync.practiceResourcesCacheExpiry.facilities.expireAt",
    )!;
    expect(facExpiry).toBeDefined();
  });

  it("handles enum metadata in descriptors", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  integrator: {
    strategy: {
      type: String,
      required: false,
      enum: ['offload-from-sync', 'schedule'],
      default: 'offload-from-sync',
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    const strategy = field(schema.fields, "strategy")!;
    expect(strategy.inferredType).toBe("string");
    expect(strategy.defaultValue).toBe("offload-from-sync");
    expect(strategy.metadata).toBeDefined();
    expect(strategy.metadata!.enum).toBeDefined();
  });

  it("handles deeply nested structures (3+ levels)", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  integrator: {
    sync: {
      schedule: {
        appointments: {
          create: {
            rateLimit: {
              enabled: {
                type: Boolean,
                required: false,
                default: true,
              },
            },
          },
        },
      },
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    const enabled = field(
      schema.fields,
      "sync.schedule.appointments.create.rateLimit.enabled",
    )!;
    expect(enabled).toBeDefined();
    expect(enabled.inferredType).toBe("boolean");
    expect(enabled.defaultValue).toBe(true);
  });

  it("handles mixed consts and inline descriptors together", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const freshnessMapExpiration = {
  historicalDataExpiration: {
    type: Number,
    required: false,
    default: 120,
  },
  firstDayExpiration: {
    type: Number,
    required: false,
    default: 15,
  },
};

const parallelSyncs = {
  enabled: {
    type: Boolean,
    required: false,
    default: true,
  },
  amount: {
    type: Number,
    required: false,
    default: 7,
  },
};

const settings = {
  integrator: {
    sync: {
      appointments: {
        freshnessMapExpiration,
        parallelSyncs,
        cacheEffectiveDatesRanges: {
          type: Boolean,
          required: false,
          default: false,
        },
      },
    },
    requireLock: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(
      field(schema.fields, "sync.appointments.freshnessMapExpiration.historicalDataExpiration"),
    ).toBeDefined();
    expect(
      field(schema.fields, "sync.appointments.parallelSyncs.enabled"),
    ).toBeDefined();
    expect(field(schema.fields, "sync.appointments.cacheEffectiveDatesRanges")).toBeDefined();
    expect(field(schema.fields, "requireLock")).toBeDefined();
  });

  it("ignores other top-level keys (not integrator)", async () => {
    const result = await extractMongooseSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  session: {
    logoutTimeout: {
      type: Number,
      default: 30,
    },
  },
  integrator: {
    lockExpiryInMinutes: {
      type: Number,
      required: false,
      default: 10,
    },
  },
  patients: {
    maxTokenAge: {
      type: Number,
      required: false,
    },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(schema.fields).toHaveLength(1);
    expect(schema.fields[0]!.name).toBe("lockExpiryInMinutes");
  });
});

describe("extractMongooseAccountSettingsSchema", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractMongooseAccountSettingsSchema([]);
    expect(result.schemas).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips files with no settings object", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      { path: "models/foo.ts", content: "export const something = {};" },
    ]);
    expect(result.schemas).toHaveLength(0);
  });

  it("extracts all top-level keys except integrator", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  session: {
    logoutTimeout: {
      type: Number,
      default: 30,
    },
  },
  integrator: {
    lockExpiryInMinutes: {
      type: Number,
      required: false,
      default: 10,
    },
  },
  patients: {
    maxTokenAge: {
      type: Number,
      required: false,
    },
  },
};`,
      },
    ]);
    expect(result.schemas).toHaveLength(1);
    const schema = result.schemas[0]!;
    expect(schema.integratorType).toBe("__account_settings__");
    expect(schema.sourceFiles).toEqual(["models/setting.ts"]);

    // Should have session.logoutTimeout and patients.maxTokenAge, NOT integrator fields
    const names = schema.fields.map((f) => f.name);
    expect(names).toContain("session.logoutTimeout");
    expect(names).toContain("patients.maxTokenAge");
    expect(names.some((n) => n.startsWith("integrator") || n === "lockExpiryInMinutes")).toBe(
      false,
    );
  });

  it("handles top-level descriptor fields (e.g., timezone)", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  timezone: {
    type: String,
    required: false,
    default: 'US/Pacific',
  },
  integrator: {
    enabled: { type: Boolean, default: true },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    const tz = field(schema.fields, "timezone")!;
    expect(tz).toBeDefined();
    expect(tz.inferredType).toBe("string");
    expect(tz.defaultValue).toBe("US/Pacific");
  });

  it("extracts nested sections with dotted paths", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  scheduler: {
    appointmentDuration: {
      type: Number,
      required: false,
      default: 30,
    },
    bufferTime: {
      type: Number,
      required: false,
      default: 0,
    },
  },
  cancellation: {
    shadowAppointment: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  integrator: {
    sync: { enabled: { type: Boolean, default: true } },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(field(schema.fields, "scheduler.appointmentDuration")!.defaultValue).toBe(30);
    expect(field(schema.fields, "scheduler.bufferTime")!.defaultValue).toBe(0);
    expect(field(schema.fields, "cancellation.shadowAppointment")!.defaultValue).toBe(false);
  });

  it("resolves shorthand property references", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const communication = {
  smsEnabled: {
    type: Boolean,
    required: false,
    default: true,
  },
  emailEnabled: {
    type: Boolean,
    required: false,
    default: true,
  },
};

const settings = {
  communication,
  integrator: {
    enabled: { type: Boolean, default: true },
  },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(field(schema.fields, "communication.smsEnabled")!.inferredType).toBe("boolean");
    expect(field(schema.fields, "communication.emailEnabled")!.defaultValue).toBe(true);
  });

  it("resolves identifier values referencing top-level consts", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const reminderConfig = {
  enabled: { type: Boolean, default: true },
  maxRetries: { type: Number, default: 3 },
};

const settings = {
  reminder: reminderConfig,
  integrator: { enabled: { type: Boolean, default: true } },
};`,
      },
    ]);
    const schema = result.schemas[0]!;
    expect(field(schema.fields, "reminder.enabled")!.inferredType).toBe("boolean");
    expect(field(schema.fields, "reminder.maxRetries")!.defaultValue).toBe(3);
  });

  it("returns empty schema when only integrator block exists", async () => {
    const result = await extractMongooseAccountSettingsSchema([
      {
        path: "models/setting.ts",
        content: `
const settings = {
  integrator: {
    lockExpiryInMinutes: { type: Number, default: 10 },
  },
};`,
      },
    ]);
    expect(result.schemas).toHaveLength(0);
  });
});
