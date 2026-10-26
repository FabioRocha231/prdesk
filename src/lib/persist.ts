import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";

/** Small app state that must survive restarts (snoozes, open tasks), next to the settings. */
export async function loadValue<T>(key: string, fallback: T): Promise<T> {
  const store = await load(STORE_FILE);
  return (await store.get<T>(key)) ?? fallback;
}

// The PR cache is big and rewritten every sync; it lives apart so settings.json stays small and readable.
const CACHE_FILE = "cache.json";

export async function loadCached<T>(key: string, fallback: T): Promise<T> {
  const store = await load(CACHE_FILE);
  return (await store.get<T>(key)) ?? fallback;
}

export async function saveCached(key: string, value: unknown): Promise<void> {
  const store = await load(CACHE_FILE);
  await store.set(key, value);
  await store.save();
}

export async function saveValue(key: string, value: unknown): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(key, value);
  await store.save();
}
