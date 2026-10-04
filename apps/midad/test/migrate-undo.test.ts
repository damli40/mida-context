import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MidaHome, migrateUndo } from "@mida/midad"

/**
 * `mida migrate --undo` restores the newest `migrate/backup-*` folder. Migrations before the
 * Windows port wrote the ISO stamp with ":" into the name; a Windows-legal name swaps ":" for
 * "-", and an upgraded home can hold both shapes. ":" sorts after "-" bytewise, so a raw name
 * sort takes an OLDER ":" backup as newest. The choice must order the stamps, not the bytes.
 */
describe("mida migrate --undo backup choice", () => {
  const made: string[] = []
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const tempHome = (): MidaHome => {
    const dir = mkdtempSync(join(tmpdir(), "mida-undo-"))
    made.push(dir)
    return new MidaHome(dir)
  }
  const seedBackup = (home: MidaHome, name: string, registry: string): void => {
    home.writeSecretJson(`migrate/${name}/network.json`, { chainId: 31337, deployment: { capabilityRegistry: registry } })
  }
  const undo = (home: MidaHome) => migrateUndo({ home, env: {}, print: () => {}, now: () => new Date() })

  it("picks the truly newest backup when an old ':' name sits next to a new '-' one", async () => {
    const home = tempHome()
    // the ':' name is OLDER (14:05 vs 14:30) but sorts last bytewise, so the bug picked it
    seedBackup(home, "backup-2026-09-23T14:05:00.000Z", "0x1111111111111111111111111111111111111111")
    seedBackup(home, "backup-2026-09-23T14-30-00.000Z", "0x2222222222222222222222222222222222222222")
    const result = await undo(home)
    expect(result.outcome).toBe("restored")
    expect(result.lines.at(-1)).toContain("migrate/backup-2026-09-23T14-30-00.000Z")
    expect(home.readJson<{ deployment: { capabilityRegistry: string } }>("network.json")!.deployment.capabilityRegistry).toBe(
      "0x2222222222222222222222222222222222222222",
    )
  })

  it("still picks a ':' name when it really is the newest backup", async () => {
    const home = tempHome()
    seedBackup(home, "backup-2026-09-23T14-30-00.000Z", "0x2222222222222222222222222222222222222222")
    seedBackup(home, "backup-2026-09-23T14:45:00.000Z", "0x3333333333333333333333333333333333333333")
    const result = await undo(home)
    expect(result.outcome).toBe("restored")
    expect(result.lines.at(-1)).toContain("migrate/backup-2026-09-23T14:45:00.000Z")
    expect(home.readJson<{ deployment: { capabilityRegistry: string } }>("network.json")!.deployment.capabilityRegistry).toBe(
      "0x3333333333333333333333333333333333333333",
    )
  })
})
