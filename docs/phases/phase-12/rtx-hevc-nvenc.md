# Model Duel: test

Race of 2026-09-25 02:32 UTC, 2 rounds, state done.

## Comparison · medians of 2 rounds

| Metric | test |
| --- | --- |
| Encode time (lower is better) | 2313 ms<br>2308 ms to 2318 ms · sd 7.1 ms |
| Frames per second (higher is better) | 259.4 fps<br>258.8 fps to 260.0 fps · sd 0.8 fps |
| Speed (higher is better) | 8.6×<br>8.6× to 8.6× · sd 0.0× |
| Time to first progress with a frame | 353 ms<br>352 ms to 353 ms · sd 0.7 ms |
| Output size | 25.3 MB<br>25.3 MB to 25.3 MB · sd 0.00 MB |
| Energy per encode, approx. (lower is better) | 81.8 J<br>79.6 J to 84.1 J · sd 3.2 J |
| Mean CPU power, agent, approx. | n/a |
| Mean GPU power, agent, approx. | 34.4 W<br>31.6 W to 37.2 W · sd 3.9 W |
| Peak video encoder use | 100%<br>100% to 100% · sd 0.0% |
| Peak GPU | 9.5%<br>9.0% to 10% · sd 0.7% |

## Rounds

| Round | test | Flags |
| --- | --- | --- |
| Warm-up, not counted | 586 ms · 51.2 fps · 1.5× real time |  |
| Round 1 | 2308 ms · 260.0 fps · 8.6× real time |  |
| Round 2 | 2318 ms · 258.8 fps · 8.6× real time |  |

## Setup

| Setting | test |
| --- | --- |
| Encoder | hevc_nvenc |
| ffmpeg | 7.1.1-1ubuntu4.2 |
| Clip checksum | 3c69de52c335bed9… |
| Agent | 0.1.0 on linux x64, nvidia-smi |
| GPU | NVIDIA GeForce RTX 3060, 12 GB |
| System | Linux-6.17.0-41-generic-x86_64-with-glibc2.42 |
| Memory | 30.24 GB |
| Notes | n/a |
| Address | http://192.168.99.150:8888 |

## Settings

- Encode reference-1080p30.mp4 with HEVC hardware, 10 Mbit/s
- HEVC on the video encoder: NVENC on an NVIDIA GPU, VideoToolbox on a Mac. The comparison is the encoder hardware.
- Encode time is ffmpeg's own run on each machine, measured by the agent there; frames per second divide the frames by it, and speed is seconds of video per second.
- Every machine encodes the same clip, checked by its SHA-256 checksum before the race.
- Plan: 2 rounds, warm-up on, 2 s between rounds, machines together
- Telemetry: on, read twice a second

## How to read this

- Times are measured by Model Duel from the moment a request left it, so they include the network. "Unsloth" rows are what Unsloth measured on the machine itself.
- A machine wins a row only when its median is more than 10 percent better than the runner-up's, or its round-to-round range does not overlap the runner-up's. Otherwise the row is a tie. Failed rounds and the warm-up never count.
- Ratio headlines cover frames per second and energy per encode, for the same clip and settings.
- Energy is approximate: GPU board power on NVIDIA and the GPU rail on Apple, read twice a second and added up over the run.

Made with Model Duel.
