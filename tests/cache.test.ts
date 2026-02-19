import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTLCache } from "../src/cache.js";

describe("TTLCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new TTLCache<string, number>(1000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("returns undefined for missing keys", () => {
    const cache = new TTLCache<string, number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("has() returns true for existing keys", () => {
    const cache = new TTLCache<string, string>(1000);
    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
    expect(cache.has("nope")).toBe(false);
  });

  it("expires entries after TTL", () => {
    const cache = new TTLCache<string, string>(5000);
    cache.set("key", "value");

    vi.advanceTimersByTime(4999);
    expect(cache.get("key")).toBe("value");

    vi.advanceTimersByTime(2);
    expect(cache.get("key")).toBeUndefined();
  });

  it("has() returns false for expired keys", () => {
    const cache = new TTLCache<string, string>(1000);
    cache.set("key", "value");

    vi.advanceTimersByTime(1001);
    expect(cache.has("key")).toBe(false);
  });

  it("clear() removes all entries", () => {
    const cache = new TTLCache<string, string>(10000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("size reflects stored entries", () => {
    const cache = new TTLCache<string, string>(1000);
    expect(cache.size).toBe(0);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("set() sweeps expired entries", () => {
    const cache = new TTLCache<string, string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);

    // Expire both entries
    vi.advanceTimersByTime(1001);

    // Setting a new key should sweep the expired ones
    cache.set("c", "3");
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("size excludes expired entries", () => {
    const cache = new TTLCache<string, string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(1001);
    // size should reflect 0 after expiry, not 2
    expect(cache.size).toBe(0);
  });

  it("overwriting resets TTL", () => {
    const cache = new TTLCache<string, string>(1000);
    cache.set("key", "v1");

    vi.advanceTimersByTime(800);
    cache.set("key", "v2");

    vi.advanceTimersByTime(800);
    expect(cache.get("key")).toBe("v2");

    vi.advanceTimersByTime(201);
    expect(cache.get("key")).toBeUndefined();
  });
});
