# fastdata-drag-and-drop — minimal plan

a drag-and-drop file upload app for **FastFS** on NEAR.

we are building the same app as the reference —
<https://github.com/fastnear/fastdata-drag-and-drop> — but with
**different tools**. the reference is React + `@near-wallet-selector`
+ `react-files` + bootstrap. ours is **Preact** +
**`@near-kit-tool-box/web`** + native drag-and-drop.

---

## 1. the reference

- upstream: <https://github.com/fastnear/fastdata-drag-and-drop>
- local clone (read-only reference, not a dependency):
  `../fastdata-drag-and-drop-reference`
- the format spec: <https://hackmd.io/@fastnear/fastfs-docs>

we also read the open-source pieces that actually implement FastFS,
because they are the real contract our app has to satisfy — the
prose spec is thinner than the code:

| repo | what it is | what we read it for |
| --- | --- | --- |
| `fastnear/fastdata-indexer` | watches the chain, decodes the args, stores them | the schema, the validation rules, **and the proof that the args must be raw bytes** |
| `fastnear/fastfs-server` | serves the files over http | what it takes for a file to actually be served |

the reference is `fastfs-upload-demo`. it:

1. lets you drop files on a zone (via `react-files`)
2. encodes them with **borsh** into the FastFS schema
3. calls `__fastdata_fastfs` on `fastfs.near`
4. links the result at `https://{account}.fastfs.io/{contract}/{path}`

### what we take from the reference

| reference | file | what we keep |
| --- | --- | --- |
| the FastFS borsh schema | `src/hooks/fastfs.js` | the exact schema + `encodeFfs` |
| the `__fastdata_fastfs` call | `src/Upload/Upload.jsx` | method name + borsh args |
| the file URL shape | `src/Upload/Upload.jsx` | `https://{account}.fastfs.io/...` |
| the ui shape | `src/Upload/Upload.jsx` | drop zone, relative path, file list, progress |
| the size caps | `src/Upload/Upload.jsx` | 32 MB drop zone, 10 files per drop |
| the editable relative path | `src/Upload/Upload.jsx` | keep it — the path is part of the served url. it concatenates with no separator, like the reference |
| the chunking rules | `src/Upload/Upload.jsx` | **not** — we use `simple` only (section 2) |
| the mime type handling | `src/Upload/Upload.jsx` | **not** — it passes `file.type` through with no fallback, so an unclassifiable file fails on chain (section 2) |

### what we change

| reference | ours | why |
| --- | --- | --- |
| react + `@near-wallet-selector` | preact + `@near-kit-tool-box/web` | our tool chain |
| `useWalletSelector()` | `near_kit_client()` / `near_connect_client()` | our tool chain |
| hardcoded `mainnet` in `constants.js` | `toggle_network()` | network toggle |
| `react-files` | native HTML5 drag-and-drop | fewer deps, preact-friendly |
| bootstrap css | own css | no bootstrap dependency |
| `callFunction` from wallet-selector | `near.call(...)` | near-kit |

---

## 2. the FastFS contract — there is none

this is the most important correction over the reference.

**FastFS has no contract.** the upload is a plain function call to a
*receiver* account, and the FastFS indexer watches the chain for
function calls named `__fastdata_fastfs` and serves the bytes it finds.

from the spec (<https://hackmd.io/@fastnear/fastfs-docs>):

> - **receiver_id**: The contract account that will serve as the
>   namespace
> - **Receiver**: The contract account that will serve as the namespace

and the learnnear writeup:

> - **receiver_id** (can be any account)

so `fastfs.near` is **not a contract we call a method on** — it is just
the receiver id used as the namespace in the url. we checked it on
chain and it has **no contract code deployed** (`view_code` returns
`NO_CONTRACT`, `code_hash` is all zeros).

### what this means for us

- **we do not need a contract at all.** any account id works as the
  receiver/namespace. we can use the uploader's own account id, so the
  url becomes `https://{account}.fastfs.io/{account}/{path}`.
- the method `__fastdata_fastfs` is never called *on a contract*. it is
  a function call action whose receiver is the namespace account. the
  account does not need to implement anything.
- **the receiver must be an account that exists.** a function call to a
  non-existent account id fails on chain. so the receiver has to be a
  real account.

### verified on chain

we confirmed on mainnet that `fastfs.near` has **no contract code**:

```
view_code(fastfs.near)      -> NO_CONTRACT
view_account(fastfs.near)   -> code_hash 1111...1111 (all zeros)
```

and yet a real upload through it **works** — the spec's own example
`mob.near` -> `fastfs.near` with the path `fastnear.png` serves a
live 121 KB png at
`https://mob.near.fastfs.io/fastfs.near/fastnear.png`.

so `fastfs.near` is used purely as a **namespace string**, and the
FastFS indexer is what turns the transaction into a served file.

### the one trap

`outcomes.status` comes back **`false`** on *every* fastfs upload —
the ones that worked and the ones that did not. we verified this on
the `mob.near` transaction that produced the live png: same
`status: false`, working file.

a function call to an account with no contract has no successful
"method return" to report, so the receipt reads as unsuccessful even
though the transaction was included and the file was indexed.

**we must not treat `status: false` as an upload error — and we must
not treat it as success either.** the receipt status tells us
nothing. the only trustworthy success signal is **fetching the file
url back and checking the bytes match**. that is how the ui decides
success.

(there is a *second* trap here, and it is the important one: the
args encoding. a transaction can have the same `status: false`, the
same gas and the same everything, and still not land, purely because
the args went out in a shape the indexer cannot borsh-decode. we hit
that twice. see section 3b.)

### decision needed

which receiver id do we use?

**decided: `fastfs.near` on mainnet, `fastfs.testnet` on testnet.**
both accounts exist on their networks (we verified both on chain), and
both work as namespaces. we follow the near convention of
`<name>.testnet` for the testnet one, same as the reference's
commented-out `ConstantsTestnet`.

| network | receiver id | url |
| --- | --- | --- |
| mainnet | `fastfs.near` | `https://{me}.fastfs.io/fastfs.near/{path}` |
| testnet | `fastfs.testnet` | `https://{me}.fastfs.io/fastfs.testnet/{path}` |

the receiver id is resolved from the current network, so the network
toggle moves both the chain we talk to and the namespace in the url.

### the method name and args

| | |
| --- | --- |
| method | `__fastdata_fastfs` |
| args | the borsh-encoded `FastfsData` enum, as **raw bytes** |
| receiver | the namespace account (see above) |
| deposit | `0` |

### how we know the args must be raw bytes

the indexer is open source (`fastnear/fastdata-indexer`). we read how
it actually consumes the transaction, and it settles the question
completely.

**1. the indexer picks up any method with the `__fastdata_` prefix**
(`main-indexer/src/main.rs:12`):

```rust
const FASTDATA_PREFIX: &str = "__fastdata_";
```

**2. it takes the action's args as raw bytes, untouched**
(`main-indexer/src/main.rs:133-143`):

```rust
if let ActionView::FunctionCall { method_name, args, .. } = action {
    if method_name.starts_with(FASTDATA_PREFIX) {
        data.push(FastData {
            ...
            data: args.to_vec(),   // <- the raw bytes, verbatim
            ...
        });
    }
}
```

**3. it borsh-decodes them straight into the schema**
(`fastfs-sub-indexer/src/main.rs:97`):

```rust
if let Ok(value) = borsh::from_slice(&fastdata.data) {
    match value {
        FastfsData::Simple(simple_fastfs) => { ... }
        FastfsData::Partial(partial_fs) => { ... }
    }
}
```

`borsh::from_slice` on a JSON-wrapped base64 string **fails**, so the
`if let Ok(value)` is false and the action is **dropped without a
trace**. the transaction still succeeds, the file never appears, and
the url 404s.

**this is the exact mechanism behind the failed `sleet.near`
transaction.** it is not a gas problem, not a receiver problem and not
a status problem. the args were a string, `borsh::from_slice` failed,
and the indexer threw the action away.

so the rule is now backed by the consumer's own code, not just by
observation:

> **the args must be the raw borsh bytes. a JSON-wrapped base64
> string is silently discarded by the indexer.**

**how the bytes get there is a separate question, and it is where all
the trouble was.** see section 3b — the wallet has two action paths
and only the native one can carry raw bytes.

### the borsh schema

**decided: the `simple` variant only.** no chunking.

```
FastfsData = enum {
  simple: SimpleFastfs {
    relativePath: string,
    content: option<FastfsFileContent { mimeType: string, content: u8[] }>,
  },
}
```

the reference also has a `partial` variant with `offset` / `fullSize` /
`contentChunk` / `nonce`, for files over 1 MiB. the spec does not
document `partial`.

we skip `partial`. one transaction per file, one `simple` entry. the
consequence is that a big file is one transaction carrying the whole
file, so NEAR's transaction size limit applies — we cap the file size
in the ui and say so, rather than chunking.

we keep the `partial` variant in the schema (`src/fastfs/schema.js`)
so the enum discriminant ordering stays identical to the working
transaction. `partial` is variant 1, `simple` is variant 0, and the
working upload's args start with `0x00` — so `simple` must stay
first in the enum.

### what we verified on chain about both variants

we pulled real `__fastdata_fastfs` transactions and decoded their args
by hand. both variants are real, and both appear in the wild:

| tx | variant | bytes | decoded | file serves? |
| --- | --- | --- | --- | --- |
| `5vUqtNhY...` | **simple** | 121512 | `fastnear.png`, `image/png`, 121477 B | **yes** — 200 |
| `AihzkJKoG...` | **simple** | 677305 | `524abc0d....wasm`, `application/wasm`, 677206 B | — |
| `Ho9MvXs21...` | **partial** | 1048679 | `3e1857b8....mp3`, `audio/mpeg`, offset 2097152, fullSize 6153298, chunk 1048576 B, nonce 3142720738 | 404 — see below |

the `partial` one decodes exactly like the reference builds it: a
**1 MiB chunk** (`1048576`), an **offset** that is a multiple of 1 MiB
(`2097152` = chunk 2), the **fullSize** of the whole file
(`6153298`), and a **nonce**.

its 404 is **correct**, not a bug: the file is 6153298 bytes, so it
needs 6 chunks, and that transaction only carried chunk 2. the file is
incomplete, so the server has nothing complete to serve.

**this tells us the `partial` format is real and the indexer reads
it.** we are still skipping it, because it doubles the code and the
nonce/offset bookkeeping for a case we do not need.

### the mime type — read from the indexer, not guessed

the reference passes `file.type` straight through with **no fallback**:

```js
mimeType: file.type,   // src/Upload/Upload.jsx:37 and :60
```

the browser leaves `file.type` as `""` for a file it cannot classify.
the spec says a non-empty mime type is required. so the reference has
a hole: an unclassifiable file produces an empty mime type, and the
transaction is rejected.

we read the indexer's own validation code
(`fastnear/fastdata-indexer`, `fastfs-sub-indexer/src/fastfs.rs`) to
settle what the rules actually are:

```rust
const MAX_RELATIVE_PATH_LENGTH: usize = 1024;
const MAX_MIME_TYPE_LENGTH: usize = 256;

impl SimpleFastfs {
    pub fn is_valid(&self) -> bool {
        if self.relative_path.len() > MAX_RELATIVE_PATH_LENGTH { return false; }
        if let Some(content) = &self.content {
            if content.mime_type.is_empty() || content.mime_type.len() > MAX_MIME_TYPE_LENGTH {
                return false;
            }
        }
        true
    }
}
```

so for a `simple` upload:

| field | rule |
| --- | --- |
| `relativePath` | max **1024** bytes |
| `mimeType` | must be **non-empty**, max **256** bytes |
| `content` | optional — `None` means **delete** the file |

and the server side (`fastnear/fastfs-server`, `src/main.rs`):

```rust
if first.offset == 0 {
    if let (Some(mime_type), Some(content)) = (first.mime_type, first.content) {
        // serve it
    }
}
HttpResponse::NotFound().finish()
```

**a `None` mime type or a `None` content means the url 404s.** the
indexer stores `mime_type: None` when the borsh `content` is `None`,
so a delete-by-upload produces a 404, which is the intended outcome.

### our mime type rule

**we only accept files whose mime type the browser recognises.** that
is the user's instruction, and it lines up exactly with what the
protocol requires — no fallback needed, no guessing.

- a file with an empty `file.type` is **rejected in the ui** with a
  clear message, before we ever build a transaction
- we show the detected mime type on the staged file, so the user can
  see what will be sent
- we do **not** guess from the extension. a wrong guess produces a
  wrong `Content-Type` on the served file, which is worse than a
  clear rejection

this also closes the reference's hole: it lets the user pick a file it
cannot classify, the transaction gets rejected on chain, and the app
shows nothing useful about why.

### the size limit, from the protocol

we confirmed the hard limit on live mainnet via
`EXPERIMENTAL_protocol_config`:

```
runtime_config.wasm_config.limit_config.max_transaction_size = 1572864
```

**1572864 bytes = exactly 1.5 MiB.** that is the total size of the
signed transaction, so the file's content has to fit inside it along
with the envelope (signer id, public key, nonce, receiver id, block
hash, signature — roughly 300 bytes) and the borsh header for the
path and mime type (tens of bytes).

**so with `simple` only, the usable file size is about 1.5 MB.** a
file bigger than that cannot be sent in one transaction at all — the
network rejects it before it is signed.

this also explains the reference's design: its 1 MiB chunk size sits
inside the 1.5 MiB limit with ~512 KB to spare, which is exactly why
it chunks at 1 MiB.

### what "small like the reference" means for us

- **per-file cap: 1 MB** (1048576 bytes). that is under the 1.5 MiB
  protocol limit with a wide margin, it matches the reference's own
  chunk boundary, and it is comfortably above the largest `simple`
  upload we found on chain (677 KB).
- **outer drop-zone cap: 32 MB**, same as the reference, so a drag
  that includes a huge file is rejected with a clear message rather
  than silently failing.
- **max 10 files per drop**, same as the reference.
- the ui says which limit was hit, per file.

we support: **small files, one transaction each, `simple` only.** that
is exactly what the reference does for anything under 1 MiB, and it is
the only path we have verified end to end (a served file).

### the `partial` path — real, but skipped

for completeness, since we found it on chain: `partial` is a real
format that the indexer reads, and the reference implements it
correctly. its 404 on chain was correct behaviour — that transaction
carried chunk 2 of 6, so the file was incomplete.

we skip it. it doubles the code (offset bookkeeping, the shared
nonce, the last-chunk detection) for a case we do not need, and the
`simple` path is the one we have seen produce a served file. if we
ever want big files, this is the design to follow, and the schema is
already in place for it.

### validation rules

from the indexer's own code, not the prose spec:

- `relativePath` max **1024** bytes
- `mimeType` must be **non-empty**, max **256** bytes
- `content` may be `None` — that **deletes** the file (and the url
  then 404s, which is correct)
- a path over 1024 bytes or an empty mime type means the indexer
  **drops the action silently** — the transaction still succeeds, the
  file just never appears

### the file url

```
https://{predecessor_id}.fastfs.io/{receiver_id}/{relative_path}
```

`predecessor_id` is the uploader. `receiver_id` is the namespace. so
with the reference's `fastfs.near`:

```
https://{my_account}.fastfs.io/fastfs.near/{relative_path}
```

---

## 3. our tools

### `@near-kit-tool-box/web@0.3.0`

the only new dependency. it bundles `near-kit@0.20.2` and
`@hot-labs/near-connect@0.12.0`.

```js
import {
  near_kit_client,        // -> Near instance for the current network
  near_connect_client,    // -> NearConnector for the current network
  toggle_network,         // -> flips mainnet/testnet in localStorage
  get_stored_network_id,  // -> "mainnet" | "testnet"
  set_network_mainnet,
  set_network_testnet,
  near_kit_client_archival,
} from "@near-kit-tool-box/web";
```

how it works under the hood (`packages/web/src/new-hot.ts`):

- the network lives in `localStorage` under the key `network_id`
  (`NETWORK_STORAGE_KEY`)
- `get_stored_network_id()` normalizes it — anything that is not
  exactly `"testnet"` reads as `"mainnet"`
- **there is one `Near` instance and one `NearConnector` instance per
  network**, both built at module load with a fixed `network`:
  `near_kit_mainnet` / `near_kit_testnet` and `near_connect_mainnet` /
  `near_connect_testnet`
- `near_kit_client()` picks the right one from the stored network id
- `near_connect_client()` picks the right connector the same way
- `toggle_network()` writes the other network id back to `localStorage`.
  it does **not** reload the page and does **not** touch the instances

### `near-kit@0.20.2` (transitive)

we use it through `near_kit_client()`:

```js
await near.call(receiverId, "__fastdata_fastfs", argsBytes, { gas: "1" });
```

- `args` may be a `Uint8Array` — that is how we pass the borsh payload.
  the reference passes borsh bytes to wallet-selector's
  `callFunction`; we pass the same bytes to `near.call`.
- the signer is resolved by `near.call` itself: `options.signerId`, else
  the default signer, else the connected wallet's first account. we do
  not have to pass the account id.

---

## 3b. the transaction path — the part that has to be right

this is the core of the app. a file upload is a NEAR transaction whose
args must be **raw borsh bytes** on chain, so the indexer can
borsh-decode them.

**this took four attempts, and each wrong attempt looked plausible.**
we now have the answer verified against the wallet's own Rust
deserializer, compiled and run locally.

### what the indexer needs

the indexer is open source (`fastnear/fastdata-indexer`):

```rust
// main-indexer/src/main.rs
data: args.to_vec(),          // the raw bytes, verbatim

// fastfs-sub-indexer/src/main.rs
if let Ok(value) = borsh::from_slice(&fastdata.data) { ... }
```

`borsh::from_slice` on anything that is not valid borsh FAILS, the
`if let Ok` is false, and the action is **dropped without a trace**.
the transaction still succeeds, the file never appears, and the url
404s.

### the wallet has two paths, and only one can carry bytes

from the wallet's own source (`INTEARnear/wallet`, `web/src/utils.rs`):

```rust
#[derive(Deserialize)]
#[serde(untagged)]
pub enum SendTransactionsAction {
    Native(NearAction),              // tried FIRST
    WalletSelector(WalletSelectorAction),
}
```

**the native path** (`near-min-api/src/types.rs`):

```rust
pub struct FunctionCallAction {
    pub method_name: String,
    #[serde_as(as = "Base64")]
    pub args: Vec<u8>,       // base64 in json -> RAW BYTES on chain
    pub gas: Gas,
    pub deposit: NearToken,
}
```

**the wallet-selector path** — what near-kit's adapter produces:

```rust
FunctionCall {
    method_name: String,
    args: serde_json::Value,          // a JSON VALUE
    ...
}
// and the conversion:
args: serde_json::to_vec(&args).unwrap_or_default(),
```

`serde_json::to_vec` of a `Value` **always** produces JSON text. so
whatever shape the args take, the on-chain args are JSON text:

| the args value | on-chain args | first byte | borsh |
| --- | --- | --- | --- |
| a base64 string | `"ABEAAA..."` | `0x22` | fails |
| a byte-indexed object | `{"0":0,"1":9,...}` | `0x7b` | fails |
| a byte array | `[0,9,0,...]` | `0x5b` | fails |
| **raw bytes (native path)** | **the bytes themselves** | **`0x00`** | **parses** |

**the wallet-selector path cannot carry raw bytes. only the native
path can.**

### reaching the native path — and why it is blocked

near-connect's conversion is the gate:

```js
const nearActionsToConnectorActions = (actions) => actions.map((action) => {
  if ("type" in action) return action;      // <-- passthrough
  if (action.functionCall) { ...convert... }
  throw new Error("Unsupported action type");
});
```

so an action with a top-level `type` passes through **unchanged**. but
the wallet's native variant is an **externally tagged** enum, so it
must be exactly `{"FunctionCall": {...}}` — and a sibling `type` key
makes serde look for a variant named `type`:

```
unknown variant `type`, expected `FunctionCall`
```

we verified this by compiling the wallet's exact serde types and
running them. the results:

```
native, no type key            -> OK Native, 46 raw bytes, first 0x00
native WITH type key           -> ERR unknown variant `type`
native, extra field INSIDE     -> OK Native, 46 raw bytes, first 0x00
wallet-selector, args a string -> OK WalletSelector (args become JSON text)
wallet-selector, args an array -> OK WalletSelector (args become JSON text)
```

so the native action needs **no top-level `type`** — and near-connect
**requires** one to pass through. the two requirements are
contradictory.

**and the conversion is inside `wallet.signAndSendTransaction`**, so
calling the wallet directly does not skip it:

```js
// @hot-labs/near-connect, SandboxedWallet/index.js
async signAndSendTransaction(params) {
  const actions = nearActionsToConnectorActions(params.actions);   // <-- here
  ...
}
```

### so the native path is unreachable from a browser dapp on this stack

with `@hot-labs/near-connect` + the Intear wallet, the args on chain
are **always** JSON text. that means `borsh::from_slice` always fails
and the FastFS indexer always drops the action.

**this is not something we can fix in our app.** it is a gap between
near-connect's action conversion and the FastFS format, which needs
raw bytes.

### the one way through: the wallet's executor

near-connect's conversion is inside `wallet.signAndSendTransaction`,
so calling the wallet does not skip it. BUT the wallet's `executor` is
a **public field**, and the executor posts its params straight to the
wallet iframe as JSON:

```js
// @hot-labs/near-connect, SandboxedWallet/executor.js
async call(method, params) {
  ...
  iframe.postMessage({ method, params, id });
}
```

so `wallet.executor.call("wallet:signAndSendTransaction", {...})` with
a NATIVE action would reach the wallet without the conversion.

**we have NOT verified this works** — the wallet's message handler for
that method name is inside the wasm, and the Intear wallet's
`send-transactions` flow signs a payload the wallet builds itself, not
one the dapp supplies. so this needs a real wallet to test.

### how the working reference transaction did it

the `mob.near` -> `fastfs.near` transaction landed **121512 raw bytes**
on chain. so whatever sent it used the native path — which means it
did NOT go through near-connect's conversion. it was almost certainly
sent by a CLI or a tool that builds the action natively.

the wallet's own approve screen even tells you the difference. it
prints the CLI command it would run, and picks the mode by trying to
parse the args as JSON:

```rust
if let Ok(value) = serde_json::from_slice::<serde_json::Value>(args) {
    ("json-args", serde_json::to_string(&value))
} else {
    ("base64-args", BASE64_STANDARD.encode(args))
}
```

so a wallet that received RAW BYTES shows `base64-args` — the mode
that puts the bytes on chain. one that received JSON text shows
`json-args`.

**the wallet screen is the diagnostic.** if it says `json-args`, the
args are JSON text and the upload will 404.

### the fix we shipped: the wallet's executor

near-connect's conversion is inside `wallet.signAndSendTransaction`,
so calling the wallet does not skip it. BUT the wallet's `executor` is
a **public field**, and the executor posts its params straight to the
wallet iframe as JSON:

```js
// @hot-labs/near-connect, SandboxedWallet/executor.js
async call(method, params) {
  ...
  iframe.postMessage({ method, params, id });
}
```

so `wallet.executor.call("wallet:signAndSendTransaction", {...})` with
a NATIVE action reaches the wallet without the conversion. that is
what we do now.

**this still needs a real wallet to confirm.** the wallet's
`send-transactions` flow signs a payload the wallet builds itself, so
we cannot be sure from the outside that it accepts a dapp-supplied
native action. the app's on-chain check will tell us: if the args come
back as our bytes, it worked; if they come back as JSON text, it did
not, and the app reports the upload as failed.

### IT WORKS — confirmed on mainnet

the executor route works. the real wallet received the native action,
the base64 args were decoded, and the raw borsh bytes went on chain.

the mainnet transaction `5GMKqNsx8Hg2HPnrHxiuF9H3nSkhnSS5jjATjGbqLdZN`:

```
signer:   sleet.near  ->  receiver: fastfs.near
method:   __fastdata_fastfs   gas: 1   deposit: 0

on-chain args: 46 bytes
  00 11 00 00 00 746573742e747874 48656c6c6f2e747874 01 0a 00 00 00
  746578742f706c61696e 05 00 00 00 68656c6c6f
  ^0   ^len 17    ^path           ^opt ^len 10   ^mime       ^len 5 ^body

first byte: 0x00        the `simple` enum discriminant
relativePath: 'test.txtHello.txt'
mimeType:     'text/plain'
content:      'hello'
consumed all 46 bytes: true
```

and the file is served:

```
$ curl -i https://sleet.near.fastfs.io/fastfs.near/test.txtHello.txt
HTTP/2 200
content-type: text/plain
content-length: 5
x-fastdata-tx-hash: 5GMKqNsx8Hg2HPnrHxiuF9H3nSkhnSS5jjATjGbqLdZN
x-fastdata-block-height: 223399962

hello
```

the wallet's approve screen showed it as **binary**, with the CLI
command in `base64-args` form:

```
binary:
000900000048656c6c6f2e747874010a000000746578742f706c61696e0500000068656c6c6f
```

which is the wallet telling us the args are NOT JSON — they are raw
bytes. that is the diagnostic we wanted, and it is the opposite of the
`json-args` we saw when it was broken.

### the path in that upload

the served path was `test.txtHello.txt` — because the relative path
field had `test.txt` typed into it and the file was `Hello.txt`. the
reference CONCATENATES the relative path and the file name with no
separator, and we mirror that exactly. it is not a bug on our side; it
is what the reference does, and the user controls the field.

### what we do about it

we have three options, and they are not equivalent:

1. **keep the app, and let the user send the transaction with the
   CLI.** the app builds the payload and shows the exact
   `near contract call-function ... base64-args '<base64>'` command.
   the wallet is not involved in sending at all, so the native path
   is available. this WORKS today.

2. **find a wallet that supports the native path.** the wallet's
   protocol doc says the transactions string "also accepts the real
   action syntax that is used in RPC communication" — so the WALLET
   supports it. it is near-connect that cannot produce it. a wallet
   with a native-capable connector would work.

3. **patch or fork near-connect** so the conversion passes a native
   action through. it is a small change — the conversion is one
   function — but it means carrying a fork.

we will do (1) as the immediate path and look at (2)/(3) properly.

### the verification we can do without a wallet

the app still verifies every upload by pulling the transaction back
and comparing the on-chain args to our bytes. with the current stack
that check will **fail** — and that is correct behaviour. it tells us
the upload did not land, instead of showing a link that 404s.

that check is what caught this. a "success" that was never verified
would have shipped silently.

## 4. the network toggle — no page reload

**we do not need a reload.** you were right to push back on that, and
the tool box source confirms why.

`@near-kit-tool-box/web` keeps a **separate connector per network** and
picks between them on every call:

```ts
// packages/web/src/new-hot.ts
const near_kit_mainnet = new Near({ network: "mainnet", wallet: ... });
const near_kit_testnet  = new Near({ network: "testnet",  wallet: ... });

export function near_kit_client() {
  const network_id = get_stored_network_id();
  return network_id === "testnet" ? near_kit_testnet : near_kit_mainnet;
}
```

so after `toggle_network()` the very next `near_kit_client()` /
`near_connect_client()` returns the **other** network's instance. the
instances are pre-built for both networks, so switching is just a
`localStorage` write plus a re-read.

### the one thing that does need care: listeners

this is the trap, and it is called out in the tool box's own code. from
`huggies-rex-engine/frontend/lib/ts/shared/auth_status.ts`:

> the wallet listeners are attached per connector, and
> `@near-kit-tool-box/web` keeps a SEPARATE NearConnector per network
> (mainnet / testnet) and picks between them from the stored network
> id. a boolean flag would skip the attachment for the second network's
> connector and that network would go deaf to wallet:signIn /
> wallet:signOut.

so our wallet listeners must be attached **per connector instance**,
keyed on the instance, not on a boolean:

```ts
const attached_connectors: Set<NearConnector> = new Set();

function attach_wallet_listeners(connector: NearConnector) {
  if (attached_connectors.has(connector)) return;
  attached_connectors.add(connector);
  connector.on("wallet:signIn", on_sign_in);
  connector.on("wallet:signOut", on_sign_out);
}
```

we re-run this after every toggle, because the other network's
connector has never had listeners on it.

### the toggle flow

```
user clicks the network button
  -> toggle_network()                      // writes the other id to localStorage
  -> we re-read get_stored_network_id()    // and update preact state
  -> we attach the listeners to the new connector (it is a new instance)
  -> the wallet session on the old network is left alone
```

### the wallet session caveat

the two connectors **share the wallet's storage namespace**, and
near-connect's `signOut()` wipes that whole namespace regardless of
network. so signing out on one network also ends the session on the
other. `huggies-rex-engine` sidesteps this by being mainnet-only.

for us: after a network switch the user is very likely **not signed in**
on the newly selected network, even if they were signed in on the old
one. the ui has to handle "signed in, but on the other network" — we
check the network of the connected account, and if it does not match
the current network we show the connect button again rather than
pretending the user is signed in.

we keep the account id in **preact state**, not a global store.
`near_kit_client()` reads the network from `localStorage` on every
call, so it always matches the current network.

---

## 5. the wallet connection flow

the reference uses `useWalletSelector()`, which is react-only and is
deprecated in favour of NEAR Connect. ours goes through the connector
directly.

```
user clicks "connect"
  -> near_connect_client().connect()      // opens the wallet picker
  -> connector event "wallet:signIn"      // payload.accounts[0].accountId
  -> we store accountId in preact state
  -> near_kit_client() is now a signed-in Near instance
```

sign out is the same path in reverse:

```
user clicks "disconnect"
  -> connector.disconnect()
  -> connector event "wallet:signOut"
  -> we clear accountId from state
```

**ordering matters.** `connect()` emits `wallet:signIn` *before* it
resolves, so a listener attached afterwards would never fire. we
attach the listeners at init, before any connect call. this is the
same note as in `auth_status.ts`:

> MUST run before any connect() — autoConnect defaults to true and an
> injected wallet can emit wallet:signIn during construction, so a
> listener attached afterwards would miss the very first event.

we do **not** need the signed-message / NEP-413 dance that
`auth_status.ts` does — that is for proving identity to a backend. we
have no backend, so a plain `connect()` is enough.

---

## 6. gas — `1`, verified

**the reference's `gas: "1"` is correct. we keep it.**

we checked this on chain rather than reasoning about it. the spec says
`gas: "300000000000000"` (300 TGas) and the reference says `1`, which
looks like a bug. it is not.

### the evidence

we pulled real `__fastdata_fastfs` transactions off mainnet through
the nearblocks api:

| tx | signer -> receiver | gas attached | gas used | args shape | file resolves? |
| --- | --- | --- | --- | --- | --- |
| `5vUqtNhYchWyrifviVZ9F6k4QprgfW9fjSAtcGMdQyRw` | `mob.near` -> `fastfs.near` | **1** | 7,485,986,585,821 | raw borsh, 121512 B | **yes** — 200, a real 121 KB png |
| `DoiiVsPGGteDcRgjhJBLBYnwLfcwEX3wd6DQ2hHodhyJ` | `sleet.near` -> `fastfs.near` | **1** | 1,423,844,250,559 | base64 string, 74 B | no (404) |
| `3e3KZu8Jqpj42wUehjHPMeizaLzQeDVGf7cyGyLYhfwe` | `nonresistant.near` -> `fastfs.near` | **1** | 1,441,415,967,007 | — | no (404) |

the **working** upload used `gas_attached: 1`.

note that the two failed ones also attached `1` — and one of them is
the *same* `fastfs.near` receiver. **the gas was never the problem.**
those two failed on the args encoding (section 3b), not on gas.

### why `1` is enough

the receiver has **no contract code** (`fastfs.near` -> `view_code`
returns `NO_CONTRACT`, `code_hash` is all zeros). a function call to an
account with no contract **executes no wasm**, so there is no wasm gas
to burn. the protocol charges the base action fee and refunds
everything attached that was not used.

so `1` is not "the gas the upload needs" — it is a nominal attached
amount that gets refunded. the real cost is the base action fee, and
that is charged no matter what you attach.

| | attached | actually burned |
| --- | --- | --- |
| reference | `1` | base action fee (~1.4 TGas for a small file) |
| spec | 300 TGas | base action fee, the rest refunded |

**attaching more gas does not cost more.** the only reason the spec
quotes 300 TGas is the general case, where the receiver may be a real
contract that has to execute something.

### two things worth noting

1. **`gas_used` scales with the file size**, not with the attached gas.
   the small payload used 1.42 TGas, the 121 KB png used 7.49 TGas.
   that is the receipt-conversion + storage cost of the payload. it is
   charged regardless.

2. **`outcomes.status` is `false` on working uploads too.** the
   `mob.near` tx that produced a live, served png also shows
   `status: false`. so a `false` status is **not** a failed upload —
   it is what a function call to a contractless account looks like. we
   must not treat it as an error in the ui.

   **and it is also `false` on the failed uploads.** so the status
   tells us nothing either way. the file url is the only signal.

### what we do

- attach **`"1"`**, same as the reference. it is the smallest possible
  and it is proven to work.
- **do not** read `status: false` as a failure. success is "the
  transaction was included and the file is served at the url".
- verify a real upload by **fetching the file url back** and checking
  the bytes match. that is the only trustworthy success signal.
- keep the value in one constant so it is one edit if the receiver ever
  becomes a real contract.

> **note:** if we ever use a receiver that *does* deploy a contract
> (a dedicated namespace account implementing `__fastdata_fastfs`),
> the gas has to cover that contract's execution and `1` will fail
> with `GasLimitExceeded`. tied to the open question in section 2.

---

## 7. file layout

```
src/
  app.jsx                 the shell
  main.jsx                preact entry — unchanged
  index.css               the tokens (light + dark) — unchanged
  app.css                 the app's styles
  near/
    wallet.js             connector + per-connector listeners + sign in/out
    network.js            toggle + the network state + the receiver id
  fastfs/
    schema.js             the borsh schema
    validate.js           the per-file checks, before we build a tx
    upload.js             file -> borsh -> near.call, with progress
  components/
    Header.jsx            account button + network toggle
    DropZone.jsx          native html5 drag-and-drop
    FileList.jsx          the staged files + the uploaded results
verify/
  encoding.test.ts        pins the borsh bytes against the on-chain
                          transaction
  validate.test.ts        pins the rejection rules against the
                          indexer's own limits
  upload.test.ts          pins the encoding shape, the quote check and
                          the verification failure path
```

the reference uses `src/hooks/` and `src/Upload/`; ours uses
`src/near/`, `src/fastfs/` and `src/components/` because the preact
app has no `react-files` layer and no wallet-selector hook.

one function per file, `snake_case` function names, the file name
matching the function — the convention in your other repos.

`bun run test` runs the verify suite. it must stay green — it is what
guarantees the bytes we build are the bytes that land on chain.

---

## 8. steps

- [x] **1. wire the near tools.** add `@near-kit-tool-box/web` and
      `borsh`. create `src/near/wallet.js` and `src/near/network.js`.
      the network toggle and the connect button work against a real
      wallet, with the per-connector listener set.
- [x] **2. port the fastfs encoding, with a regression check.** create
      `src/fastfs/schema.js` with the borsh schema. then pin the
      encoding with a test that builds a payload with the **working**
      transaction's exact shape (`fastnear.png` / `image/png` /
      121477 bytes) and asserts it matches the on-chain bytes byte for
      byte. also assert the payload is **not** valid JSON (the chain
      depends on that `JSON.parse` branch failing) and that it starts
      with `0x00`, not with a `"` quote — the failed upload started
      with a quote and 404s. section 3b.
- [x] **3. port the upload.** create `src/fastfs/upload.js`. call
      `near.call(receiver, "__fastdata_fastfs", base64_string, { gas: "1" })`
      where `base64_string` is the base64 of the borsh bytes. section
      3b — this is the part that was wrong first time round.
- [x] **4. the validation layer.** `src/fastfs/validate.js`. size over
      1 MB, empty mime type, relative path over 1024 bytes, more than
      10 files. each rejection names the limit that was hit. this is
      what keeps a bad file from becoming a silent on-chain failure.
- [x] **5. build the ui.** the header (account + network toggle), the
      drop zone, the editable relative path, the file list and the
      results.
- [x] **6. wire it together.** the header's connect button gates the
      upload area, like the reference does. the ui shows which network
      the connected account is on.
- [x] **7. containerize + deploy.** the docker setup already exists
      in `DOCKER/`. the image is rebuilt and the site goes live behind
      the cloudflare tunnel.
- [ ] **8. the real upload.** the one thing we cannot do from here: a
      human connects a wallet and uploads a file. the app verifies the
      on-chain args by itself; the human opens the url and confirms the
      file is served.
- [ ] **9. testnet first, then mainnet.** switch the network to
      testnet, upload, and let the app's args check confirm the
      encoding. then switch to mainnet and open the url. section 3b.

### where the code is now

| file | what it does |
| --- | --- |
| `src/near/wallet.js` | the wallet connection, per-connector listeners |
| `src/near/network.js` | the network toggle, the receiver id, the rpc url |
| `src/fastfs/schema.js` | the borsh schema |
| `src/fastfs/validate.js` | the pre-flight checks |
| `src/fastfs/upload.js` | encode → send → verify |
| `src/components/Header.jsx` | the account button and the network toggle |
| `src/components/DropZone.jsx` | the native drag-and-drop, the drop validation |
| `src/components/FileList.jsx` | the staged files and the results |
| `src/app.jsx` | the shell |
| `src/app.css` | the styles |

`bun run test` runs the 54 tests. they must stay green — they are what
guarantees the bytes we build are the bytes that land on chain.

---

## 9. decisions and remaining questions

### decided

1. **receiver / namespace** — `fastfs.near` on mainnet,
   `fastfs.testnet` on testnet. both verified to exist on chain.
   section 2.
2. **schema** — `simple` only, no chunking. section 2.
3. **gas** — `"1"`, matching the reference and the working
   transaction. section 6.
4. **network toggle** — no page reload; per-connector listener set.
   section 4.
5. **size** — small files, like the reference does for anything under
   1 MiB. the `partial` chunking path exists and works on chain, but
   we skip it. per-file cap 1 MB, outer drop-zone cap 32 MB, max 10
   files per drop. section 2.
6. **mime type** — only accept files the browser can classify. a file
   with an empty `file.type` is rejected in the ui with a clear
   message. no extension-based guessing. section 2.
7. **relative path** — editable, like the reference. the path is part
   of the served url, so it is worth letting the user set it.
8. **verification** — one check in the app (compare the on-chain args
   to our bytes), and the final check is manual: open the url and see
   the file. no server. section 3b.
9. **testnet first** — the network toggle is there from the start, so
   the flow is: switch to testnet, upload, and the app's args check
   confirms the encoding. then switch to mainnet and open the url to
   confirm the file is served. the FastFS server does not serve
   testnet files, which is exactly why the args check is the one we
   automate.

### still open

nothing blocking. the remaining choices are cosmetic:

1. **the exact wording** of the ui messages for each rejection
   (too big, no mime type, too many files, path too long).
2. **the default relative path** — the reference uses `/` and strips
   the leading slash. we should match that.
3. **whether to show the mime type on the staged file.** the reference
   does (`<code>{file.type}</code>`), and it helps the user spot a
   misclassified file before uploading.

### verified against the real consumers

we read the open-source indexer and server rather than trusting the
prose spec:

- `fastnear/fastdata-indexer` — `main-indexer/src/main.rs` (how the
  action is picked up and the args are read) and
  `fastfs-sub-indexer/src/fastfs.rs` (the schema and the validation
  rules)
- `fastnear/fastfs-server` — `src/main.rs` (what it takes to serve a
  file)

these give us the exact contract our app has to satisfy. section 2.

---

## 10. done means

### the transaction path — this is the real done

- the user approves a wallet popup for a function call to
  `__fastdata_fastfs` on the namespace account, carrying the file's
  bytes
- the wallet signs with the connected account, and that account is the
  one in the resulting url
- the transaction is **included in a block**
- **the app pulls the tx back and compares the action's args to the
  bytes we built.** they match, byte for byte. this is the check that
  catches the silent failure
- **the decoded args start with `0x00`, not with `0x22` (`"`).** if
  they start with a quote, we sent a string and the upload will 404
- the app shows the url
- **a human opens the url on mainnet and sees the file.** that last
  step is manual on purpose — the app does not need a server to
  verify its own encoding, and the person testing checks the rest
- a `status: false` receipt is **not** treated as a failure, and not
  treated as success either — it tells us nothing. the args check is
  the signal
- if the args do not match, the ui reports the upload as failed. it
  does not show a success link

**the failure mode to avoid** is the one we found on chain: a
transaction with the right method, the right gas, the right receiver
and a `status: false` receipt, whose file 404s because the args were
sent as a base64 string instead of raw bytes. that failure is silent
— nothing errors, the tx succeeds, the file just never appears.

### the app around it

- the app loads over the cloudflare tunnel
- a user can connect a wallet from the picker
- the network toggle switches mainnet/testnet **without a page reload**,
  and the wallet listeners follow the connector
- the ui shows the network of the connected account
- dropping a file shows it staged with its size and mime type
- a file over 1 MB is rejected with a clear message naming the limit
- a file the browser cannot classify is rejected with a clear message
- a relative path over 1024 bytes is rejected with a clear message
- more than 10 files in one drop is rejected the same way
- a failed upload shows the error instead of silently failing

==========================
<br/>
copyright 2026 by sleet.near
