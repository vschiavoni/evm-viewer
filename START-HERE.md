# Run Inside the EVM locally

Unzip the archive, then open a terminal inside the extracted `evm-animation` folder. Choose either option below. You do not need a wallet or private key.

## Option A — Node.js

Install Node.js 24 (recommended; Node.js 22+ is supported) if needed. Then:

```sh
cd evm-animation
npm ci
npm start
```

If your terminal is already inside the extracted folder, omit the `cd` line.

Open **http://127.0.0.1:8765** in your browser. Keep the terminal running; press **Ctrl+C** to stop. To start again, run `npm start`; dependency installation is only needed after extracting a fresh copy or changing dependencies.

## Option B — Docker Compose

Install and start Docker Desktop (or Docker Engine with the Compose plugin). You do not need Node.js on your host.

```sh
cd evm-animation
docker compose up --build
```

Open **http://127.0.0.1:8765**. Press **Ctrl+C** to stop, then run `docker compose down` to remove the stopped container. For subsequent starts, `docker compose up` reuses the built image.

The container runs as the unprivileged `node` user. Port 8765 is published only to your computer's loopback address.

### Docker without Compose

From inside the extracted folder:

```sh
docker build -t evm-animation .
docker run --rm --init -p 127.0.0.1:8765:8765 evm-animation
```

Stop with **Ctrl+C**. Run only one of the Node or Docker versions at a time; both use port 8765.

## First run

1. The included Counter execution is ready to play immediately.
2. Click **Load contract**.
3. Upload `.sol` file(s), choose **Compile source**, select a function, enter its arguments as a JSON array, then choose **Run & animate**. Try `examples/Counter.sol`, function `increment(uint256)`, arguments `["1"]`.
4. Alternatively choose **Ethereum contract address**, enter its mainnet address and your RPC URL, and fetch bytecode. Provide a function signature/ABI or raw calldata. Fetched contracts use **empty local storage**, as requested.
5. Use **Save offline HTML** to download a self-contained replay. It plays without Node, Docker, or internet access. For Keynote, record fullscreen playback as a movie and insert the movie into your slide.

## Internet access

The first `npm ci` or Docker build downloads dependencies. After installation/build, local Solidity compilation and execution work offline. Loading code from an Ethereum address needs internet access to your RPC endpoint. RPC URLs are entered in the browser and excluded from exports.

## Troubleshooting

- **Port already in use:** stop any existing copy of this app before starting another. This chat may already have a local preview running on port 8765.
- **Docker cannot connect to the daemon:** start Docker Desktop / Docker Engine first.
- **Loading directly from `file://`:** replay works, but loading new contracts requires opening the local HTTP address above.
- **Missing Solidity imports:** upload the imported files too. npm package imports and library linking are not resolved automatically.
- **Incompatible Solidity version:** the bundled compiler is solc 0.8.30 targeting Cancun. See compiler diagnostics and `README.md`.
- **Address-loaded contract returns zero / reverts:** its storage, dependencies, and chain environment are deliberately absent. Proxies typically need on-chain state and implementation code.
- **RPC node runs on the host while the app is in Docker:** on Docker Desktop, use `http://host.docker.internal:8545` instead of `localhost:8545` as the RPC URL. Ensure the node accepts the container connection. The normal browser app URL remains `http://127.0.0.1:8765`.

## Tests

```sh
npm test
```

Or, with Docker Compose:

```sh
docker compose run --rm evm-animation npm test
```

See `README.md` for input formats, simulation limits, and presentation controls. Source, tests, examples, dependency lockfile, Dockerfile and Compose configuration are included. Installed dependencies are excluded from this source archive.

## Historical block explorer

Choose **Block explorer** in the app header. The Historical RPC URL starts with `https://docs-demo.quiknode.pro/`, which was tested successfully with opcode traces. You can replace it with your own Ethereum mainnet RPC URL. Then browse a block by number/hash (or `latest`), and select **Replay** beside a transaction. You can also paste a transaction hash directly and choose **Load & replay**.

Block browsing uses standard read-only Ethereum JSON-RPC. Opcode replay requires `debug_traceTransaction` with Geth-style `structLogs` and memory/stack/storage recording. Your provider must retain or reconstruct the transaction's historical state. Some public endpoints do not expose tracing, and an archive endpoint alone does not guarantee debug tracing support. Unsupported tracing is reported explicitly; the app does not substitute empty-state simulation.

Historical replays preserve original transaction context and show receipt status, gas used, block and transaction metadata, stack/memory, and provider-reported storage snapshots. Final storage diffs, source code, ABI decoding and nested call addresses are not fetched. The replay limit remains 6,000 opcodes; larger traces are rejected rather than truncated. Simple transfers can have zero opcodes. Replay data can be exported to offline HTML/JSON without the RPC URL.
