from flask import Flask, request, jsonify
from flask_cors import CORS
import requests, os, json

app = Flask(__name__)
CORS(app)

UPSTOX_API_KEY = os.getenv("UPSTOX_API_KEY")
UPSTOX_ACCESS_TOKEN = os.getenv("UPSTOX_ACCESS_TOKEN")

@app.route("/health")
def health():
    return jsonify({"ok": True})

@app.route("/subscribe", methods=["POST"])
def subscribe():
    data = request.get_json()
    symbols = data.get("symbols", [])
    return jsonify({"subscribed": symbols})

@app.route("/price/<symbol>")
def price(symbol):
    try:
        r = requests.get(
            f"https://api.upstox.com/v2/market/quote/ltp",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
            },
            params={"symbol": f"NSE_EQ|{symbol}"}
        )
        return jsonify(r.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
