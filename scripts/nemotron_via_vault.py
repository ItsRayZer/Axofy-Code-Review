# scripts/nemotron_via_vault.py — LLM call through the registered NVIDIA NIM
# credential WITHOUT ever exposing the key value.
# Reads JSON on stdin: {"messages": [...], "temperature": 0.1, "max_tokens": 4096}
# Prints JSON on stdout: {"content": "...", "model": "...", "usage": {...}}
# or {"error": "..."} on failure. The key is attached by
# dynamic_credentials.py as an hsurr surrogate; the runtime swaps in the
# real credential only for the registered host integrate.api.nvidia.com.
# Never print the key, never accept it as an argument.
import json, sys, urllib.request, urllib.error
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")

def main():
    try:
        req_in = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": "bad stdin JSON: " + str(e)}))
        sys.exit(1)
    payload = {
        "model": "nvidia/nemotron-3-ultra-550b-a55b",
        "messages": req_in.get("messages", []),
        "temperature": float(req_in.get("temperature", 0.1)),
        "top_p": 0.95,
        "max_tokens": int(req_in.get("max_tokens", 4096)),
    }
    url = "https://integrate.api.nvidia.com/v1/chat/completions"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    add_surrogate_to_request(req, "custom.nvidia-nim", allowed_hosts=["integrate.api.nvidia.com"])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=180) as r:
            data = read_json_response(r)
            print(json.dumps({"content": data["choices"][0]["message"]["content"],
                              "model": data.get("model"), "usage": data.get("usage")}))
    except urllib.error.HTTPError as e:
        print(json.dumps({"error": "HTTP " + str(e.code) + ": " + e.read().decode()[:500]}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)[:500]}))
        sys.exit(1)

main()
