#!/bin/bash
# NorthStar Ledger — Start Script
# Run this on your Ubuntu VPS to start the app.

echo "Starting NorthStar Ledger..."

# Install dependencies if needed
pip install -r requirements.txt --break-system-packages --quiet

# Initialize the database (safe to run multiple times)
python3 database.py

# Start Flask (use gunicorn in production)
# For production: gunicorn -w 4 -b 0.0.0.0:5000 app:app
python3 app.py
