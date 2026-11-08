"""Capture public executable fixtures for offline DAMM -> Pump VM tests.

Only getGenesisHash/getMultipleAccounts are used. This helper cannot sign or
broadcast a transaction. It accepts a public RPC URL, never a wallet/key path.
Run manually when intentionally refreshing the frozen executable fixtures.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import struct
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_DEST = ROOT / "fixtures" / "damm-pump"
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
PROGRAMS = {
    "damm-v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    "pump-swap": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "pump-fees": "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
}
PUMP_GLOBAL = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
PUMP_TRADING = ["5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx", "C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw"]


def base58(raw):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, d = divmod(n, 58)
        out = alphabet[d] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def rpc(url, method, params):
    assert method in {"getGenesisHash", "getMultipleAccounts"}
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(f"Public RPC {method} failed: {result['error'].get('code')}")
    return result["result"]


def capture(url, dest):
    assert rpc(url, "getGenesisHash", []) == MAINNET, "Expected Solana mainnet fixtures"
    observed = rpc(url, "getMultipleAccounts", [list(PROGRAMS.values()) + [PUMP_GLOBAL] + PUMP_TRADING,
        {"encoding": "base64", "commitment": "finalized"}])
    pdas = []
    for name, account in zip(PROGRAMS, observed["value"]):
        assert account and account["executable"] and account["owner"] == LOADER, name
        raw = base64.b64decode(account["data"][0])
        assert len(raw) == 36 and struct.unpack_from("<I", raw)[0] == 2, name
        pdas.append(base58(raw[4:36]))
    data = rpc(url, "getMultipleAccounts", [pdas,
        {"encoding": "base64", "commitment": "finalized", "minContextSlot": observed["context"]["slot"]}])
    dest.mkdir(parents=True, exist_ok=True)
    manifest = {"capturedAt": datetime.now(timezone.utc).isoformat(), "rpc": url,
        "genesisHash": MAINNET, "commitment": "finalized", "programAccountSlot": observed["context"]["slot"],
        "programDataSlot": data["context"]["slot"], "realFundsUsed": False, "broadcast": False, "programs": []}
    for (name, address), pda, account in zip(PROGRAMS.items(), pdas, data["value"]):
        assert account and not account["executable"] and account["owner"] == LOADER, name
        raw = base64.b64decode(account["data"][0])
        assert len(raw) > 49 and struct.unpack_from("<I", raw)[0] == 3, name
        elf = raw[45:]
        assert elf[:4] == b"\x7fELF", name
        path = dest / (name + ".so")
        path.write_bytes(elf)
        manifest["programs"].append({"name": name, "programId": address, "programData": pda,
            "lastDeployedSlot": struct.unpack_from("<Q", raw, 4)[0], "file": path.name,
            "bytes": len(elf), "sha256": hashlib.sha256(elf).hexdigest()})
    global_account = observed["value"][len(PROGRAMS)]
    assert global_account and global_account["owner"] == PROGRAMS["pump-swap"]
    global_path = dest / "pump-global.json"
    global_path.write_text(json.dumps({"pubkey": PUMP_GLOBAL, "slot": observed["context"]["slot"],
        "account": global_account}, indent=2) + "\n")
    manifest["pumpGlobalSha256"] = hashlib.sha256(global_path.read_bytes()).hexdigest()
    trading_accounts = observed["value"][len(PROGRAMS)+1:]
    assert len(trading_accounts) == 2 and all(trading_accounts)
    trading_path = dest / "pump-trading-config.json"
    trading_path.write_text(json.dumps({"capturedAt": manifest["capturedAt"],
        "commitment": "finalized", "slot": observed["context"]["slot"],
        "accounts": dict(zip(PUMP_TRADING, trading_accounts))}, indent=2) + "\n")
    manifest["pumpTradingConfigSha256"] = hashlib.sha256(trading_path.read_bytes()).hexdigest()
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc", default="https://api.mainnet-beta.solana.com")
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_DEST)
    args = parser.parse_args()
    result = capture(args.rpc, args.out)
    print(json.dumps(result, indent=2))
