# Vacuumflix
- Netflix with its original TV/console interface, made for **SteamOS** and **Bazzite**
- Runs on any Linux desktop and works with a game controller
- Uses **Widevine L3** and plays back at up to **1080p**, depending on your network
- Early version, may contain bugs. Feedback is welcome!

## Start

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/01d5e50c-dbda-460b-9ea3-1b9eb8c9be63" />

## Profile

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/d7b29c24-6df5-4e20-8773-f934e622f968" />

## Home

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/799ebd09-cc6e-432a-9759-3804e7352f15" />

## Player

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/1361ced6-efc0-41e9-bf30-a5ff547d3b10" />

## Installation

Download the Flatpak or the .tar.gz file from the [releases page](https://github.com/Ciphay/Vacuumflix/releases/tag/V1.0) and install it:

```sh
flatpak install --user Netflix.flatpak
flatpak run io.vacuumflix.Vacuumflix
```

This is the recommended way, especially on **SteamOS** and **Bazzite**, whose root file systems are read-only.

Or build it yourself:

```sh
git clone https://github.com/Ciphay/Vacuumflix.git
cd Vacuumflix
./build.sh            # builds the Flatpak and installs it
flatpak run io.vacuumflix.Vacuumflix
./build.sh package    # optional: standalone folder + single executable in dist/
```

Building needs `git`, `gcc`, `g++`, `pkg-config`, SDL2 and OpenGL ES development files, `node`, `ffmpeg`, `curl`, `xz`, `python3` with Pillow, the Noto fonts, and `flatpak` with the 25.08 runtimes:

```sh
flatpak install --user flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08
```

On Arch-based distros (tested on CachyOS):

```sh
sudo pacman -S git base-devel sdl2 nodejs ffmpeg curl python-pillow xz noto-fonts noto-fonts-cjk flatpak
```

Building on an immutable distro such as Bazzite has not been tested; use a `distrobox` container if you try.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:6c6f18855a3d24b07d2cc39344c22a1941accee893e450b74d066dc5c2955887 -->

## GPU acceleration

The UI, animations, video scaling and video colour conversion use OpenGL ES 3.
Video frames stay in planar YUV until the GPU shader draws them, reducing frame
transfer size from four bytes per pixel to approximately 1.5. The CPU still runs
application logic, image/text loading, audio and DRM.

VA-API decoding is enabled automatically for video decoded by FFmpeg. The app
tries available `/dev/dri/renderD*` devices, uses libva's selected driver, and
tries `i965` if automatic driver initialization fails. An unsupported codec or
decoder error retries the stream in software without replaying displayed frames.
Protected Netflix video currently uses Widevine's software decoder; it benefits
from GPU presentation but cannot use VA-API decoding through that CDM interface.
Widevine L3 and the existing playback quality limits are unchanged.

### Legacy Intel (i965/libva)

Install your distribution's **i965 VA-API driver** on the build machine to include
`i965_drv_video.so` and its dependencies in the package. On Debian/Ubuntu this is
`i965-va-driver`; on Arch it is `libva-intel-driver`. An FFmpeg build with VA-API
support and an OpenGL ES 3 driver are also required. Host/runtime drivers are
searched before the bundled fallback. Flatpak already grants GPU device access;
its runtime Intel VA-API extension can also supply the driver.

Force legacy Intel for a standalone install:

```sh
LIBVA_DRIVER_NAME=i965 ./netflix
```

Or for Flatpak:

```sh
flatpak run --env=LIBVA_DRIVER_NAME=i965 io.vacuumflix.Vacuumflix
```

Options (also accepted with Flatpak's `--env=NAME=value`):

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cbeeff17c9ab399a7bd9153187e6ee5667fd41aa3e0a944ae21e8caf91bd60a2 -->

- `VACUUMFLIX_HWACCEL=auto` (default): try VA-API, then software.
- `VACUUMFLIX_HWACCEL=vaapi`: require VA-API for FFmpeg video decoding; stop playback
  with the FFmpeg error if hardware initialization or decoding fails. This mode
  now forbids the software fallback that earlier versions allowed. It does not
  replace Widevine's own decoder. For legacy Intel, run
  `LIBVA_DRIVER_NAME=i965 VACUUMFLIX_HWACCEL=vaapi ./netflix` (or pass both variables
  with Flatpak's `--env=` option). Hardware decoding uses one decoder thread to
  limit surface demand. A successful device probe confirms initialization only;
  the app logs when FFmpeg actually produces video frames through VA-API.

<!-- /coderabbit-ai-generated:v1 -->
- `VACUUMFLIX_HWACCEL=off`: software decoding with GPU presentation.
- `VACUUMFLIX_VAAPI_DEVICE=/dev/dri/renderD128`: select a specific GPU.
- `LIBVA_DRIVER_NAME` and `LIBVA_DRIVERS_PATH`: standard libva overrides, preserved.
- `VACUUMFLIX_GPU_VIDEO=0`: use the original RGBA conversion path for diagnostics.

Startup logs show the OpenGL vendor/renderer and selected VA-API device/driver.
`llvmpipe` or `softpipe` in the renderer means Mesa is rendering on the CPU: check
your system's graphics driver and GPU permissions. `vainfo` with
`LIBVA_DRIVER_NAME=i965` can check which codecs your hardware supports.
The planar shader uses limited-range BT.709 for HD and BT.601 for SD; FFmpeg
normalizes clear streams to that format, and Widevine's I420 output is assumed
to use those TV colour conventions. Frames still pass through system memory;
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cf95f2d46f0eeef01e4d79611d9ff201f577e73375a0b8e928941abcea434602 -->

this is not a zero-copy DMA-BUF pipeline.

### Development checks

Run `./port2/tests/run_gpu.sh` with Node, FFmpeg (including libx264), GCC, SDL2
and GLES development files installed. It checks driver selection and video
fallbacks, and renders test pixels through the actual shader using SDL's
offscreen Mesa backend. Physical i965 decoding still needs an Intel GPU;
these tests can run with Mesa software rendering.


<!-- /coderabbit-ai-generated:v1 -->
## Disclaimer


<!-- /coderabbit-ai-generated:v1 -->
Vacuumflix is an unofficial client. It is not affiliated with, endorsed or supported by Netflix, Inc. "Netflix" is a trademark of Netflix, Inc.

- A valid Netflix subscription is required. Vacuumflix does not provide, unlock or bypass access to any content.
- Playback uses Widevine L3 (software DRM), so the maximum quality is 1080p. Vacuumflix does not remove, break or work around DRM.
- The Netflix TV interface scripts and the boot animation belong to Netflix, Inc.; the Widevine CDM belongs to Google. They are included only so the app works as tested, and their owners keep all rights.
- Netflix can change its servers or interface at any time, which may break parts of the app until it is updated.
