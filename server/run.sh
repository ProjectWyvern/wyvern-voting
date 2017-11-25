#!/bin/sh

while true; do
  node server.js | bunyan -o short
  sleep 1
done
