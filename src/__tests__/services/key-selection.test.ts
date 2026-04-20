import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { aiProviderKeys } from "../../db/schema.js";
import { selectKeyForTask } from "../../services/key-selection.js";

describe("selectKeyForTask", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => testDb.sqlite.close());

  it("throws when no keys are available", async () => {
    await expect(selectKeyForTask({})).rejects.toThrow("No available AI keys");
  });

  it("returns the first active key", async () => {
    testDb.db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "anthropic-messages",
      label: "Primary",
      keyValue: "sk-ant-api-test-key",
      priority: 0,
      isActive: true,
    }).run();

    const key = await selectKeyForTask({});
    expect(key.provider).toBe("anthropic");
    expect(key.keyValue).toBe("sk-ant-api-test-key");
    expect(key.providerType).toBe("anthropic-messages");
  });

  it("respects priority ordering", async () => {
    testDb.db.insert(aiProviderKeys).values({
      provider: "openai",
      providerType: "openai-chat",
      label: "Lower priority",
      keyValue: "sk-openai-test",
      priority: 10,
      isActive: true,
    }).run();

    // Should still return the anthropic key (priority 0)
    const key = await selectKeyForTask({});
    expect(key.provider).toBe("anthropic");
  });

  it("uses assigned key when specified", async () => {
    const inserted = testDb.db.insert(aiProviderKeys).values({
      provider: "google",
      providerType: "google-generativeai",
      label: "Assigned",
      keyValue: "google-key-123",
      priority: 99,
      isActive: true,
    }).returning().get();

    const key = await selectKeyForTask({ assignedKeyId: inserted!.id });
    expect(key.provider).toBe("google");
    expect(key.keyValue).toBe("google-key-123");
  });

  it("skips inactive keys", async () => {
    testDb.db.insert(aiProviderKeys).values({
      provider: "mistral",
      providerType: "openai-chat",
      label: "Inactive",
      keyValue: "mistral-key",
      priority: -1, // Would be first if active
      isActive: false,
    }).run();

    const key = await selectKeyForTask({});
    // Should not return the inactive mistral key
    expect(key.provider).not.toBe("mistral");
  });

  it("skips failed keys", async () => {
    // Get the anthropic key ID
    const allKeys = testDb.db.select().from(aiProviderKeys).all();
    const anthropicKey = allKeys.find(k => k.provider === "anthropic")!;

    const key = await selectKeyForTask({ failedKeyIds: JSON.stringify([anthropicKey.id]) });
    // Should not return the anthropic key since it's marked as failed
    expect(key.id).not.toBe(anthropicKey.id);
  });

  it("filters to allowed keys only", async () => {
    const allKeys = testDb.db.select().from(aiProviderKeys).all();
    const openaiKey = allKeys.find(k => k.provider === "openai")!;

    const key = await selectKeyForTask({ allowedKeyIds: JSON.stringify([openaiKey.id]) });
    expect(key.id).toBe(openaiKey.id);
    expect(key.provider).toBe("openai");
  });

  it("throws when all candidates are excluded", async () => {
    const allKeys = testDb.db.select().from(aiProviderKeys).all();
    const activeIds = allKeys.filter(k => k.isActive).map(k => k.id);

    await expect(
      selectKeyForTask({ failedKeyIds: JSON.stringify(activeIds) })
    ).rejects.toThrow("No available AI keys");
  });

  it("skips keys disabled until future time", async () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    testDb.db.insert(aiProviderKeys).values({
      provider: "cohere",
      providerType: "openai-chat",
      label: "Disabled for now",
      keyValue: "cohere-key",
      priority: -2, // Would be first if not disabled
      isActive: true,
      disabledUntil: futureDate,
    }).run();

    const key = await selectKeyForTask({});
    expect(key.provider).not.toBe("cohere");
  });
});
