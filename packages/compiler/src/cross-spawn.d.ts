declare module "cross-spawn" {
  import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process"
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess
  namespace spawn {
    function sync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer | string>
  }
  export default spawn
}
