// Every operator address that registered agents on the Mida contracts before this repo
// went public, read from Monad testnet on Sep 30, 2026 (AgentRegistered events from
// block 65178864 to 66812312: 44 agents, 8 operators). All of them are ours, so the index
// never counts them as outside teams. When we set up a new Mida home, add its operator
// here and redeploy the index.
export const KNOWN_OUR_OPERATORS: readonly string[] = [
  "0x097f1fa75c499ec9ce114ca6e5b79c46713a5d92",
  "0x130b5ff3386f4a056ede5a4d3336f6080dd86dae",
  "0x1984f50d22c1913070f9334282a19b7e3b9e53ac",
  "0x57aa727ba4a1c6603e9d8edaee2112ff1b1e09e4",
  "0x60ebdf6ad432e7a8660072bc745529e61ff58b83",
  "0x77defc83faf44f5d1dbfbff4f1b2a9af4c989f93",
  "0x8ab027c642dad1ef94651167eea1ef90b9cf89bb",
  "0xe36e9079eec8a46df83a905065d0f3bd12bdd20a",
]
