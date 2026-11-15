#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
node --test port2/tests/gpu.test.js port2/tests/media.test.js
# Word splitting is intentional for pkg-config's compiler/linker flags.
gcc -O2 -pthread -o "$test_dir/video_shader" port2/tests/video_shader.c $(pkg-config --cflags --libs sdl2) -lGLESv2 -lm
SDL_VIDEODRIVER=offscreen "$test_dir/video_shader"
