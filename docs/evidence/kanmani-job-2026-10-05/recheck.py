"""Second-reader recheck of Kanmani's 10 "not on any chain" payment claims (Oct 5, 2026).

For each claim: read the claim page only to learn which recording transaction, evidence URL and cited transaction
it names; then check each fact independently:
  1. the committed hash: read the recording transaction's receipt on Monad mainnet and find the hash in its logs;
  2. the evidence bytes: download the document, keccak256 it, compare with the hash read from the chain;
  3. the cited transaction: eth_getTransactionByHash on every chain below, recording each chain's head block at the
     time, so a "not found" names the block it was measured at.
Every chain's id is read from its RPC (eth_chainId), never assumed from the URL. Output: findings.json + findings.md.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request, concurrent.futures as cf
from datetime import datetime, timezone

OUT = sys.argv[1]
CLAIMS = """143_10180_0x103040545AC5031A11E8C03dd11324C7333a13C7_2
143_10180_0x103040545AC5031A11E8C03dd11324C7333a13C7_7
143_10181_0x103040545AC5031A11E8C03dd11324C7333a13C7_10
143_10181_0x103040545AC5031A11E8C03dd11324C7333a13C7_11
143_10182_0x09C32b8FC0a94A1EeD424499A42180e29667bEeE_4
143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_4
143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_30
143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_33
143_10182_0x103040545AC5031A11E8C03dd11324C7333a13C7_36
143_10221_0x103040545AC5031A11E8C03dd11324C7333a13C7_1""".split()

MONAD = "https://rpc.monad.xyz"
CHAINS = {
    "monad": MONAD, "monad-testnet": "https://testnet-rpc.monad.xyz",
    "ethereum": "https://ethereum-rpc.publicnode.com", "base": "https://base-rpc.publicnode.com",
    "optimism": "https://optimism-rpc.publicnode.com", "arbitrum": "https://arbitrum-one-rpc.publicnode.com",
    "polygon": "https://polygon-bor-rpc.publicnode.com", "bsc": "https://bsc-rpc.publicnode.com",
    "avalanche": "https://avalanche-c-chain-rpc.publicnode.com", "linea": "https://linea-rpc.publicnode.com",
    "scroll": "https://scroll-rpc.publicnode.com", "gnosis": "https://gnosis-rpc.publicnode.com",
    "celo": "https://forno.celo.org", "blast": "https://blast-rpc.publicnode.com",
    "mantle": "https://mantle-rpc.publicnode.com", "unichain": "https://unichain-rpc.publicnode.com",
    "sonic": "https://sonic-rpc.publicnode.com", "zksync-era": "https://mainnet.era.zksync.io",
    "sei": "https://evm-rpc.sei-apis.com", "hyperevm": "https://rpc.hyperliquid.xyz/evm",
    "skale-europa": "https://mainnet.skalenodes.com/v1/elated-tan-skat",
    "skale-calypso": "https://mainnet.skalenodes.com/v1/honorable-steel-rasalhague",
    "skale-nebula": "https://mainnet.skalenodes.com/v1/green-giddy-denebola",
    "skale-titan": "https://mainnet.skalenodes.com/v1/parallel-stormy-spica",
    "sepolia": "https://ethereum-sepolia-rpc.publicnode.com", "base-sepolia": "https://base-sepolia-rpc.publicnode.com",
    "arbitrum-sepolia": "https://arbitrum-sepolia-rpc.publicnode.com", "optimism-sepolia": "https://optimism-sepolia-rpc.publicnode.com",
    "polygon-amoy": "https://polygon-amoy-bor-rpc.publicnode.com", "bsc-testnet": "https://bsc-testnet-rpc.publicnode.com",
    "avalanche-fuji": "https://avalanche-fuji-c-chain-rpc.publicnode.com",
}
HASH = re.compile(r"0x[0-9a-fA-F]{64}")


def rpc(url, method, params, timeout=20):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "mida-recheck/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        reply = json.loads(r.read())
    if "error" in reply:
        raise RuntimeError(f"{reply['error'].get('code')}: {str(reply['error'].get('message'))[:120]}")
    return reply.get("result")


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"user-agent": "mida-recheck/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def keccak(data: bytes) -> str:
    out = subprocess.run([shutil.which("cast") or os.path.expanduser("~/.foundry/bin/cast"), "keccak", "0x" + data.hex()], capture_output=True, text=True, check=True)
    return out.stdout.strip().lower()


def chain_ids():
    ids = {}
    def one(name):
        try:
            return name, int(rpc(CHAINS[name], "eth_chainId", []), 16), None
        except Exception as e:  # noqa: BLE001 — recorded as "could not check" on that chain
            return name, None, str(e)[:120]
    with cf.ThreadPoolExecutor(16) as pool:
        for name, cid, err in pool.map(one, CHAINS):
            ids[name] = {"chainId": cid, "error": err}
    return ids


def search(tx, ids):
    def one(name):
        if ids[name]["chainId"] is None:
            return name, {"result": "could-not-check", "why": ids[name]["error"]}
        url = CHAINS[name]
        try:
            head = int(rpc(url, "eth_blockNumber", []), 16)
            found = rpc(url, "eth_getTransactionByHash", [tx])
            if found is None:
                return name, {"result": "not-found", "headBlock": head}
            block = found.get("blockNumber")
            return name, {"result": "found", "block": int(block, 16) if block else None, "from": found.get("from"), "to": found.get("to"), "headBlock": head}
        except Exception as e:  # noqa: BLE001
            return name, {"result": "could-not-check", "why": str(e)[:120]}
    with cf.ThreadPoolExecutor(16) as pool:
        return dict(pool.map(one, CHAINS))


def recheck(claim, ids):
    f = {"claim": claim, "url": f"https://kanmani.xyz/claim/{claim}", "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    page = get(f["url"]).decode("utf-8", "replace")
    rec = re.search(r"monadexplorer\.com/tx/(0x[0-9a-fA-F]{64})", page)
    ev = re.search(r"https://[^\"'<>\s\\]+\.json", page)
    f["recordingTx"] = rec.group(1) if rec else None
    f["evidenceUrl"] = ev.group(0) if ev else None
    # 1. the committed hash, read from the recording transaction on Monad mainnet
    onchain = set()
    if f["recordingTx"]:
        receipt = rpc(MONAD, "eth_getTransactionReceipt", [f["recordingTx"]])
        f["recordingBlock"] = int(receipt["blockNumber"], 16) if receipt else None
        for log in (receipt or {}).get("logs", []):
            for t in log.get("topics", []):
                onchain.add(t.lower())
            data = log.get("data", "0x")[2:]
            onchain.update("0x" + data[i:i + 64].lower() for i in range(0, len(data) - 63, 64))
    # 2. the evidence bytes against that hash
    if f["evidenceUrl"]:
        try:
            raw = get(f["evidenceUrl"])
            f["evidenceBytes"] = len(raw)
            f["evidenceKeccak"] = keccak(raw)
            f["evidenceHashOnChain"] = f["evidenceKeccak"] in onchain
            doc = json.loads(raw)
            proof = doc.get("proof_of_payment") or {}
            f["declaredNetwork"] = proof.get("network") or doc.get("network")
            f["citedTx"] = (proof.get("payment_tx") or (doc.get("transactions") or {}).get("payment_tx") or "").lower() or None
            f["evidenceComment"] = doc.get("comment")
        except Exception as e:  # noqa: BLE001
            f["evidenceError"] = str(e)[:160]
    if not f.get("citedTx"):
        m = re.search(r"cited transaction[^0]*(0x[0-9a-fA-F]{64})", re.sub(r"<[^>]+>", " ", page))
        f["citedTx"] = m.group(1).lower() if m else None
    # 3. the cited transaction, everywhere
    if f.get("citedTx"):
        f["search"] = search(f["citedTx"], ids)
        hits = {k: v for k, v in f["search"].items() if v["result"] == "found"}
        f["verdict"] = "found" if hits else "not-found"
        f["foundOn"] = hits
    else:
        f["verdict"] = "could-not-check"
        f["why"] = "no cited transaction hash in the evidence document or the claim page"
    return f


ids = chain_ids()
findings = []
for c in CLAIMS:
    try:
        findings.append(recheck(c, ids))
    except Exception as e:  # noqa: BLE001
        findings.append({"claim": c, "verdict": "could-not-check", "why": str(e)[:200]})
    time.sleep(0.5)
json.dump({"chains": ids, "findings": findings}, open(f"{OUT}/findings.json", "w"), indent=2)
print(json.dumps({k: v for k, v in ids.items() if v["chainId"] is None}, indent=1))
for f in findings:
    unreachable = [k for k, v in (f.get("search") or {}).items() if v["result"] == "could-not-check"]
    print(f"{f['claim'][-14:]:>14}  verdict={f['verdict']:<16} found={list((f.get('foundOn') or {}).keys())}  bytes-match={f.get('evidenceHashOnChain')}  net={f.get('declaredNetwork')}  unreachable={len(unreachable)}  comment={str(f.get('evidenceComment'))[:70]!r}")
