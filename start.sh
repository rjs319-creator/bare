#!/bin/bash
echo "Starting Market News app at http://localhost:8080"
open "http://127.0.0.1:8080"
python3 -m http.server 8080 --directory "$(dirname "$0")"
