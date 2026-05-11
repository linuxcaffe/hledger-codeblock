"""
demo/app.py — minimal Flask demo for hledger-codeblock

    pip install flask
    LEDGER_FILE=~/finances/main.journal python app.py
    open http://localhost:5050
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from flask import Flask, send_from_directory
from flask_route import hledger_bp

app = Flask(__name__)
app.register_blueprint(hledger_bp)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    # Serve JS/CSS from parent directory
    for base in ['.', '..']:
        path = os.path.join(os.path.dirname(__file__), base, filename)
        if os.path.exists(path):
            return send_from_directory(os.path.dirname(path), os.path.basename(path))
    return 'Not found', 404

if __name__ == '__main__':
    app.run(debug=True, port=5050)
