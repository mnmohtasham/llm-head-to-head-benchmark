# Phase 20 record

- Date: 2026-09-27
- Commit and tag: branch `phase-20`.
- Asked by Mani: "Dockerize the app in a new branch and let's compare the numbers. I want to make
  this app open source so everyone can clone and run it on their machine to compare different
  machines head to head on their local network, so any person should be able to run it without
  hassle on any platform. Create the docker compose file to run the docker. Put every environment
  variable in the docker compose file."

## Gate

- [x] Clean start, dev and production builds. A copy of the repository without ignored files
      installs with `npm ci`, passes every check below and builds; `docker build` from that copy
      builds the image (262 MB).
- [x] Docker: `docker compose up -d --build` with the compose file as shipped, only moved to port
      3303 because Mani's own app had 3000. The container turns healthy, serves the page and the
      API, keeps an added machine through `docker compose down` and `up`, writes its files as the
      `node` user with mode 600, and cannot write outside its volume.
- [x] The same image built for arm64 under emulation, as on an Apple Silicon Mac or Windows on Arm,
      ran Node v22.22.2 on arm64 and served the page.
- [x] Demo on mocks: unchanged; the browser tests run it.
- [x] Typecheck, lint, unit, integration and end-to-end tests pass: 377 unit and integration
      tests, 57 browser tests.
- [ ] Real machines: the RTX machine was busy with another model during the comparison, so its
      races were stopped (below). The Lenovo was off the network. Round trips to the router stand in for a
      machine on the network.
- [x] No dead UI: nothing on screen changed but the hint for a refused loopback address.
- [x] Earlier data still opens: the data format is unchanged, and a native `data` folder can be
      mounted into the container.
- [x] README, PLAN.md (sections 3 and 8) and ROADMAP.md updated.

## What was added

- `Dockerfile`, in three stages: one builds the page and the controller, one installs only the four
  packages the controller loads at run time (fastify, @fastify/static, undici, zod), and the last
  holds just those, the built files and `package.json`. The base is `node:22.22.2-trixie-slim`: the
  same Node version as the native install on the RTX machine, on glibc like most Linux desktops, so
  the container runs the same JavaScript engine and allocator as `npm start`. The image is 262 MB. It
  runs as the unprivileged `node` user and checks `/api/health` every 30 seconds.
- `.dockerignore` keeps `data/`, `.env` files, `node_modules`, builds, tests, docs and fixtures out
  of the build context, so no machine, key or result can end up in an image.
- `docker-compose.yml`, with every setting as an environment variable and a comment saying what it
  does: `PORT`, `HOST`, `DUEL_DATA_DIR`, `DUEL_CLIENT_DIR`, `DUEL_ALLOW_HOSTS`, `LOG_LEVEL`,
  `DUEL_TELEMETRY_BASELINE_MS`, `DUEL_IN_CONTAINER` and `NODE_ENV`. Data lives in the named volume
  `model-duel-data`, which Docker creates writable for the app's user on every platform; a folder
  from the host would need matching ownership on Linux. Port 3000 is published on 127.0.0.1 only,
  like `npm start`; the comment says how to open it to the network. `host.docker.internal` is added
  for Linux, where Docker Desktop's name does not exist. The container has a read-only file system
  apart from the volume, no Linux capabilities and `no-new-privileges`.
- The server reads every option from the environment as well as the command line, and the command
  line wins. `DUEL_CLIENT_DIR` and `DUEL_ALLOW_HOSTS` (comma separated) are new;
  `MODEL_DUEL_TELEMETRY_BASELINE_MS` is renamed `DUEL_TELEMETRY_BASELINE_MS`. A port or baseline that
  is not a whole number in range stops the start with a message instead of starting on `NaN`.
  `npm start -- --help` lists them all.
- With `DUEL_IN_CONTAINER=1` the startup message says to open http://localhost:3000 and that the
  ports line decides who can, instead of warning about binding 0.0.0.0 inside the container.
- `host.docker.internal` counts as this computer when the app decides which machines share a
  computer, so two servers on the Docker host still take turns and LM Studio still borrows the
  hardware of the Unsloth beside it.
- When nothing answers at `127.0.0.1` or `localhost`, the hint adds that inside Docker localhost is
  the container itself, and to use `host.docker.internal`.

## Native and Docker, measured

Three controllers from the same build, each with its own copy of the data, raced the same machines
in turn: `npm start` on the host ("native"), the container on Docker's default bridge network as
`docker-compose.yml` runs it ("bridge"), and the container sharing the host's network ("host"). All
on the RTX machine (Linux 6.17, Docker 29.7), with Mani's own app idle.

**Two fake Unsloth machines**, racing together, 3 passes of 10 rounds per controller, the passes
alternating between controllers. The fakes ran on the host at 172.17.0.1, the same kind of path as
an Unsloth on the Docker host. Medians of 30 rounds per machine, with the middle half in brackets:

| Mock A | Native | Bridge | Host |
| --- | --- | --- | --- |
| First token, client | 202.97 ms [202.77–203.40] | 203.12 ms [202.85–203.35] | 203.12 ms [202.83–203.32] |
| Client minus server first token | 2.10 ms | 2.17 ms | 2.12 ms |
| Decode, client | 44.02 tok/s | 44.06 tok/s | 44.06 tok/s |
| Decode, client against server | −0.002 % | −0.004 % | −0.003 % |
| Total | 2,225 ms | 2,223 ms | 2,223 ms |
| Round trip (RTT) | 0.259 ms | 0.283 ms | 0.261 ms |
| Event-loop lag, max | 11.0 ms | 11.0 ms | 11.0 ms |

| Mock B | Native | Bridge | Host |
| --- | --- | --- | --- |
| First token, client | 202.76 ms [202.59–203.09] | 202.70 ms [202.53–203.01] | 202.79 ms [202.61–202.99] |
| Client minus server first token | 1.76 ms | 1.73 ms | 1.82 ms |
| Decode, client | 44.08 tok/s | 44.04 tok/s | 44.03 tok/s |
| Total | 2,222 ms | 2,224 ms | 2,224 ms |
| Round trip (RTT) | 0.240 ms | 0.252 ms | 0.230 ms |

Every difference is 0.1 % or less and inside the spread between rounds, in both directions. The time
the controller adds before the first token, client minus server, moves by at most 0.06 ms. The
bridge adds about 0.02 ms to a round trip.

**Another computer on the network.** 275 TCP connects each to the router (192.168.99.1), one
network round trip apiece, in five alternating blocks:

| | Median | 10th to 90th percentile |
| --- | --- | --- |
| Native | 1.398 ms | 1.197–3.035 ms |
| Bridge | 1.423 ms | 1.223–2.307 ms |
| Host | 1.411 ms | 1.196–2.489 ms |

The bridge adds 25 µs to a round trip on the network, and host networking 14 µs. A text race makes
one request per run, so the bridge adds about 0.03 ms to a first token of hundreds of milliseconds
and nothing to decode speed, which is measured between tokens.

**The RTX machine itself** was to run the same 10-round race through all three controllers, with a
check before each pass that Mani's app was not racing and the GPU had been quiet for 20 seconds.
During the comparison, Qwen3.8 27B was loaded in Unsloth Studio on the machine and kept its GPU at
98 % between passes, so the passes were stopped. The one pass that finished overlapped that use
(decode fell from 24 to 12 tok/s in the middle) and was discarded. The fake machines and the router already cover every part of the path
that Docker changes; a race on a real machine only adds the machine's own time, which is the same
whichever controller asks.

**Not measured:** Docker Desktop on macOS and Windows, which runs containers in a virtual machine
with its own network layer. Expect a little more per round trip than on Linux; the README says to
race once each way to check.

## Findings

- **Host firewalls.** On the RTX machine, of 13 ports tried, a container reached the host's 8888
  (Unsloth), 1234, 3000, 5000, 8000 and 11434; the others, 8080 and 18951 among them, timed out. A
  firewall on the host lets Docker's network in only where a port is open. A container reaching
  Unsloth or LM Studio on its own host needs that port open, just as other computers do. The README
  says so, and the fake machines in the comparison used open ports.
- **Host networking is not offered.** It saved 11 µs a round trip against the bridge, works only on
  Linux, and needs a different `HOST` and no `ports` line. One compose file that works everywhere is
  worth more.
- **A named volume, not `./data`.** Docker creates a missing bind-mounted folder as root, and on
  Linux an existing one must belong to the container's user id 1000. The named volume starts
  writable on every platform; the README says how to mount a native `data` folder instead.
- **Inside a container, `localhost` is the container.** An Unsloth or LM Studio on the Docker host
  is `host.docker.internal`, which Docker Desktop provides and the compose file adds on Linux. It
  counts as this computer when the app decides which machines share one.
- **`.gitattributes`** keeps LF line endings on Windows checkouts, so Prettier, the tests and the
  image see the same files everywhere. Every tracked file was already LF.
