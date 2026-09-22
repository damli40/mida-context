import { describe, expect, it } from "vitest"
import { clearSaved, loadSaved, saveCredential } from "../src/check/storage.js"
import type { StorageLike } from "../src/check/storage.js"

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe("test-credential persistence", () => {
  it("round-trips a saved credential", () => {
    const store = memoryStorage()
    saveCredential(store, { credentialId: "abc123", transports: ["internal"], algorithm: -7, x: "aa", y: "bb" })
    expect(loadSaved(store)).toEqual({ credentialId: "abc123", transports: ["internal"], algorithm: -7, x: "aa", y: "bb" })
  })

  it("returns null when nothing is saved or the entry is corrupt", () => {
    const store = memoryStorage()
    expect(loadSaved(store)).toBeNull()
    store.data.set("mida.owner-page.test-credential", "not json")
    expect(loadSaved(store)).toBeNull()
    store.data.set("mida.owner-page.test-credential", JSON.stringify({ credentialId: "" }))
    expect(loadSaved(store)).toBeNull()
  })

  it("clears on forget", () => {
    const store = memoryStorage()
    saveCredential(store, { credentialId: "abc123" })
    clearSaved(store)
    expect(loadSaved(store)).toBeNull()
  })
})
