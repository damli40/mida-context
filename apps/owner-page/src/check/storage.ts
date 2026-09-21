/**
 * The one thing the page remembers: which test passkey it created, so "Use my test passkey" can
 * ask for that credential again. The credential ID and the public key are public values — storing
 * them exposes nothing an attacker could use.
 */

export interface SavedTestCredential {
  credentialId: string
  transports?: string[]
  algorithm?: number
  x?: string
  y?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = "mida.owner-page.test-credential"

export function loadSaved(store: StorageLike): SavedTestCredential | null {
  try {
    const raw = store.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedTestCredential
    return typeof parsed.credentialId === "string" && parsed.credentialId.length > 0 ? parsed : null
  } catch {
    return null
  }
}

export function saveCredential(store: StorageLike, credential: SavedTestCredential): void {
  try {
    store.setItem(KEY, JSON.stringify(credential))
  } catch {
    // storage may be unavailable (private mode) — the check still runs, the credential just isn't remembered
  }
}

export function clearSaved(store: StorageLike): void {
  try {
    store.removeItem(KEY)
  } catch {
    // same as above
  }
}
