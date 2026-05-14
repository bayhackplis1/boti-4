#!/bin/bash
echo "  Bot iniciando con reinicio automático..."
while true; do
    node src/index.js
    EXIT_CODE=$?
    echo ""
    echo "  ⚠ El bot se detuvo (código: $EXIT_CODE). Reiniciando en 5s..."
    sleep 5
done
