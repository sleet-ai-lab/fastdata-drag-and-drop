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

the reference is `fastfs-upload-demo`. it:

1. lets you drop files on a zone (via `react-files`)
2. encodes them with **borsh** into the FastFS schema
3. calls `__fastdata_fastfs` on `fastfs.near`
4. links the result at `https://{account}.fastfs.io/{contract}/{path}`

### what we take from the reference

| reference | file | what we keep |
| --- | --- | --- |
| the FastFS borsh schema | `src/hooks/fastfs.js` | the exact schema + `encodeFfs` |
| the chunking rules | `src/Upload/Upload.jsx` | 1 MiB chunks, `nonce`, part offsets |
| the `__fastdata_fastfs` call | `src/Upload/Upload.jsx` | method name + borsh args |
| the file URL shape | `src/Upload/Upload.jsx` | `https://{account}.fastfs.io/...` |
| the ui shape | `src/Upload/Upload.jsx` | drop zone, relative path, file list, progress |

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

`outcomes.status` comes back **`false`** even on uploads that
worked. we verified this on the `mob.near` transaction that produced
the live png — same `status: false`, working file.

a function call to an account with no contract has no successful
"method return" to report, so the receipt reads as unsuccessful even
though the transaction was included and the file was indexed.

**we must not treat `status: false` as an upload error.** the only
trustworthy success signal is **fetching the file url back and
checking the bytes match**. that is how the ui decides success.

### decision needed

which receiver id do we use?

| option | url | notes |
| --- | --- | --- |
| the uploader's own account | `https://{me}.fastfs.io/{me}/{path}` | no setup at all, but the url carries the account twice |
| a dedicated app account | `https://{app}.fastfs.io/{app}/{path}` | cleaner urls, needs one account created and its key kept |
| `fastfs.near` (the reference) | `https://{me}.fastfs.io/fastfs.near/{path}` | the reference's choice. it works as a namespace, but it is not a contract and we do not control it |

the reference uses `fastfs.near`. **we default to that for parity**, but
it is worth a second look — the account exists on mainnet (we verified
it), so a function call to it is a valid no-op call that the indexer
still picks up. the one risk is that the account could be deleted or
renamed.

> **open question for the user:** do we keep `fastfs.near` as the
> namespace, or use our own account? everything else in this plan is
> unaffected.

### the method name and args

| | |
| --- | --- |
| method | `__fastdata_fastfs` |
| args | the borsh-encoded `FastfsData` enum, as raw bytes |
| receiver | the namespace account (see above) |
| deposit | `0` |

### the borsh schema

the spec's schema is the **simple** variant only:

```
FastfsData = enum {
  simple: SimpleFastfs {
    relativePath: string,
    content: option<FastfsFileContent { mimeType: string, content: u8[] }>,
  },
}
```

the reference also has a `partial` variant with `offset` / `fullSize` /
`contentChunk` / `nonce`, used for files over 1 MiB. the spec does not
document `partial` — it says "File Size: Be mindful of NEAR transaction
size limits" and points at separate transactions per file instead.

> **open question for the user:** do we support the `partial` chunked
> path from the reference, or only the documented `simple` one? `simple`
> is what the spec guarantees. `partial` is what the reference actually
> ships, so it presumably works, but it is undocumented.

### validation rules (from the spec)

- `relativePath` max 1024 characters
- `mimeType` required, cannot be empty
- `content` may be `null` — that **deletes** the file
- a path over 1024 chars or an empty mime type fails the transaction

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
args are **raw borsh bytes**, not JSON. the bytes have to survive four
conversions unchanged, and every one of them has a branch that would
silently corrupt them.

we traced the whole path in the source and verified it byte-for-byte
against a real on-chain transaction. the chain below is the spec for
what we build.

### the four hops

```
1. borsh bytes          Uint8Array(52 bytes)   <- OUR code
        |
        |  near-kit TransactionBuilder.functionCall
        |  (core/transaction.js:204)
        |    args instanceof Uint8Array ? args : TextEncoder().encode(JSON.stringify(args))
        v
2. near-kit action      { functionCall: { methodName, args: Uint8Array, gas, deposit } }
        |
        |  near-kit wallets/adapters.js:21 convertActionToNearConnect
        |    try { args = JSON.parse(new TextDecoder().decode(args)) } catch { /* keep raw */ }
        v
3. near-connect action  { type: "FunctionCall", params: { methodName, args: Uint8Array, gas, deposit } }
        |
        |  the WALLET builds and signs the transaction, base64-encodes
        |  the args for the wire
        v
4. on-chain args        base64 of the SAME 52 raw bytes
```

### hop 1 — near-kit keeps raw bytes

`core/transaction.js:204`:

```js
const argsBytes = args instanceof Uint8Array
    ? args
    : new TextEncoder().encode(JSON.stringify(args));
```

`Uint8Array` is passed through untouched. **this is why we must pass a
`Uint8Array` and never a base64 string.** a base64 string would be
`JSON.stringify`'d into a JSON string and the file would be garbage.

### hop 2 — the JSON.parse branch (the dangerous one)

`wallets/adapters.js:26-35`:

```js
let args = fc.args;
if (args instanceof Uint8Array) {
    try {
        const argsString = new TextDecoder().decode(args);
        args = JSON.parse(argsString);
    } catch {
        // Non-JSON binary args — pass through as-is
    }
}
```

this **tries to parse the borsh bytes as JSON**. for our payload the
parse fails (borsh bytes are not valid JSON) and the catch keeps the raw
bytes. that is the correct outcome, but it depends on the payload
happening to be invalid JSON.

**this is the trap to be careful about.** a borsh payload that *did*
happen to parse as JSON would be converted to a JS object and the wallet
would sign a completely different transaction. our payload starts with
`0x00 0x0f 0x00 0x00 0x00` (the enum discriminant + string length),
which is never valid JSON, so we are safe — but the property we depend
on is "the bytes are not valid JSON", not "the code preserves bytes".

> **rule:** the payload must stay a `Uint8Array` end to end. never
> base64 it, never JSON it, never let it become a string. we add a
> regression check for this in step 2 (section 8).

### hop 3 — near-connect does the same check again

`@hot-labs/near-connect` `actions/index.js:5-10` has the identical
`deserializeArgs` logic. same outcome: the parse fails, the raw bytes
survive.

### hop 4 — what actually lands on chain

the wallet signs the transaction and base64-encodes the args for the
wire. we verified against a real mainnet transaction:

the `sleet.near` -> `fastfs.near` upload with path `notes/small.txt`
and content `hello fastfs\n` has these on-chain args:

```
AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg==
```

decoded, that is **52 bytes**, and it is exactly the borsh encoding of:

```
simple: {
  relativePath: "notes/small.txt",
  content: { mimeType: "text/plain", content: "hello fastfs\n" }
}
```

### the verification we ran

we reproduced the whole path locally with the real `borsh` package and
the real schema from the reference, and compared against the on-chain
bytes:

```
STEP 1 near-kit functionCall args is Uint8Array: true len: 52
STEP 2 JSON.parse failed -> passes through as raw bytes. type: Uint8Array len: 52
STEP 3 raw bytes preserved. type: Uint8Array len: 52
STEP 4 wire base64: AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg==
expected on-chain: AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg==
MATCH: true
```

**all 52 bytes survive all four hops unchanged.** this is the proof
that the encoding we build is the encoding the chain expects.

### what the wallet actually receives

`near-kit` calls `wallet.signAndSendTransaction` with:

```js
{
  signerId:   "<the connected account>",
  receiverId: "<the namespace account>",
  actions: [{
    type: "FunctionCall",
    params: {
      methodName: "__fastdata_fastfs",
      args:        Uint8Array(52),   // raw borsh, NOT json, NOT base64
      gas:        "1",
      deposit:    "0",
    },
  }],
}
```

`receiverId` is the transaction's receiver — the namespace account. the
wallet shows the user "call `__fastdata_fastfs` on `fastfs.near`". that
is the transaction the user is approving, and it is the transaction
that lands on chain.

### how the signer is picked

`near.call` resolves the signer itself (`core/near.js:169-185`):

1. `options.signerId`, if we pass one
2. the default signer, if configured
3. the connected wallet's **first account** (`wallet.getAccounts()`)

we do **not** pass `signerId`. we let it come from the wallet, so the
transaction is always signed by the account the user actually connected
with. if the wallet has several accounts, the first one signs.

we do pass the account id to the **url** builder (it is the
`predecessor_id` in `https://{predecessor_id}.fastfs.io/...`). that
must be the same account that signed, so we read it from the same
`wallet:signIn` event.

### how the result comes back, and what "success" means

`near.call` -> `TransactionBuilder.send()` (`core/transaction.js:1076`):

- the wallet returns a `FinalExecutionOutcome`
- if the wallet's own status already reached our `waitUntil`, it
  returns that
- otherwise it **reconciles by hash** — it takes
  `result.transaction.hash` and re-queries the RPC with
  `getTransactionStatus(hash, signer_id, waitUntil)`. it never asks the
  user to sign again.

so we get back a result we can inspect. but here is the trap we
already found in section 2:

> `outcomes.status` is **`false`** even on uploads that worked.

the reason is that the receiver has no contract, so the function call
has no successful return value to report. `near-kit`'s `send()` will
therefore look like a failure and fall through to the RPC reconcile
path, which is fine — but we must not treat the status as the success
signal.

**the success signal is the served file.** after the transaction is
included, we fetch the file url and compare the bytes to what we
uploaded. that is the only trustworthy end-to-end check, and it is
what "landed on chain" has to mean for us.

### what "done" means for the transaction path

1. the user sees a wallet popup showing a function call to
   `__fastdata_fastfs` on the namespace account, with the file's bytes
   in it
2. the user approves; the wallet signs with their account
3. the transaction is included in a block
4. the tx hash is on chain, and the receipt's args are **the same 52
   bytes** we built — we can verify this by fetching the tx and
   base64-decoding its args
5. the file is served at
   `https://{account}.fastfs.io/{namespace}/{path}` and the bytes match
   what we uploaded

step 4 is a direct, independent check of our encoding: pull the tx
back from the chain and compare its args to our local bytes. step 5 is
the end-to-end proof.

**if either fails, the upload did not land correctly** — and the ui
must say so, not show a success link.

### `@hot-labs/near-connect@0.12.0` (transitive)

we use it through `near_connect_client()`:

```js
const connector = near_connect_client();
await connector.connect();                // opens the wallet picker
connector.on("wallet:signIn", (p) => {}); // p.accounts[0].accountId
connector.on("wallet:signOut", () => {});
await connector.disconnect();
```

the wallet list it offers: HOT, Meteor, Intear, MyNearWallet, Nightly,
Near Mobile, Unity, OKX, Hana, Ethereum wallets, NEAR CLI.

### `borsh@2.0.0`

same version the reference uses, for the FastFS payload encoding.

### preact + vite

already in the project from `bun create vite`. no change.

---

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

| tx | signer -> receiver | gas attached | gas used | file resolves? |
| --- | --- | --- | --- | --- |
| `5vUqtNhYchWyrifviVZ9F6k4QprgfW9fjSAtcGMdQyRw` | `mob.near` -> `fastfs.near` | **1** | 7,485,986,585,821 | **yes** — 200, a real 121 KB png |
| `DoiiVsPGGteDcRgjhJBLBYnwLfcwEX3wd6DQ2hHodhyJ` | `sleet.near` -> `fastfs.near` | **1** | 1,423,844,250,559 | no (404) |
| `3e3KZu8Jqpj42wUehjHPMeizaLzQeDVGf7cyGyLYhfwe` | `nonresistant.near` -> `fastfs.near` | **1** | 1,441,415,967,007 | no (404) |

the **working** upload used `gas_attached: 1`.

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
   the small `notes/small.txt` used 1.42 TGas, the 121 KB png used
   7.49 TGas. that is the receipt-conversion + storage cost of the
   payload. it is charged regardless.

2. **`outcomes.status` is `false` on working uploads too.** the
   `mob.near` tx that produced a live, served png also shows
   `status: false`. so a `false` status is **not** a failed upload —
   it is what a function call to a contractless account looks like. we
   must not treat it as an error in the ui.

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
  app.jsx                 the shell — keep the vite boilerplate for now,
                          swap in the app once the plan is agreed
  main.jsx                preact entry — unchanged
  index.css / app.css    the vite boilerplate styles — keep
  near/
    wallet.js             connector + per-connector listeners + sign in/out
    network.js            toggle + the network state
  fastfs/
    schema.js             the borsh schema            (done)
    upload.js             file -> borsh -> near.call, with progress
  components/
    Header.jsx            account button + network toggle
    DropZone.jsx          native html5 drag-and-drop
    FileList.jsx          the staged files + the uploaded results
verify/
  encoding.test.ts        pins the borsh bytes against the on-chain
                          transaction (done)
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

- [ ] **1. wire the near tools.** add `@near-kit-tool-box/web` and
      `borsh`. create `src/near/wallet.js` and `src/near/network.js`.
      the network toggle and the connect button work against a real
      wallet, with the per-connector listener set. no upload yet.
- [ ] **2. port the fastfs encoding, with a regression check.** create
      `src/fastfs/schema.js` with the borsh schema. then pin the
      encoding with a test that asserts our bytes equal the on-chain
      bytes for `notes/small.txt` — the exact 52 bytes we verified
      against `sleet.near` -> `fastfs.near`:
      `AA8AAABub3Rlcy9zbWFsbC50eHQBCgAAAHRleHQvcGxhaW4NAAAAaGVsbG8gZmFzdGZzCg==`.
      also assert the payload is **not** valid JSON, because the whole
      chain depends on the `JSON.parse` branch failing (section 3b).
- [ ] **3. port the upload.** create `src/fastfs/upload.js`. call
      `near.call(receiver, "__fastdata_fastfs", bytes, { gas: "1" })`
      with `bytes` a `Uint8Array` — never a base64 string.
- [ ] **4. verify the transaction on chain.** after one real upload,
      fetch the tx back and **base64-decode its args**, then compare
      them byte-for-byte to our local bytes. that is the direct check
      that the bytes we built are the bytes that landed. section 3b.
- [ ] **5. verify the served file.** fetch the file url back and
      compare the bytes to what we uploaded. `status: false` on the
      receipt is expected and must not be read as a failure. this is
      section 6.
- [ ] **6. build the ui.** replace the boilerplate with the header
      (account + network toggle), the drop zone, the file list and
      the upload progress.
- [ ] **7. wire it together.** the header's connect button gates the
      upload area, like the reference does. the ui shows which network
      the connected account is on.
- [ ] **8. containerize + deploy.** the docker setup already exists
      in `DOCKER/`. rebuild the image, redeploy through the cloudflare
      tunnel, confirm the route.

---

## 9. open questions

1. **which receiver / namespace id?** `fastfs.near` (the reference) or
   our own account. affects the url. `fastfs.near` is proven to work
   as a namespace; using our own account is cleaner but untested.
   section 2.
2. **`simple` only, or also `partial` chunking?** the spec documents
   only `simple`. the reference ships `partial` for files over 1 MiB.
   section 2.
3. **do we support files over 1 MiB at all** — if `simple` only, a
   large file is one transaction with the whole file in it, and NEAR's
   transaction size limit applies.

---

## 10. done means

### the transaction path — this is the real done

- the user approves a wallet popup for a function call to
  `__fastdata_fastfs` on the namespace account, carrying the file's
  bytes
- the wallet signs with the connected account, and that account is the
  one in the resulting url
- the transaction is **included in a block**
- **pulling the tx back from the chain and base64-decoding its args
  gives byte-for-byte the same bytes we built.** this is the direct
  check that what we encoded is what landed
- the file is served at
  `https://{account}.fastfs.io/{namespace}/{path}` and the served
  bytes match what we uploaded
- a `status: false` receipt is **not** treated as a failure — the
  success signal is the served file
- if the tx args or the served bytes do not match, the ui reports the
  upload as failed. it does not show a success link

### the app around it

- the app loads over the cloudflare tunnel
- a user can connect a wallet from the picker
- the network toggle switches mainnet/testnet **without a page reload**,
  and the wallet listeners follow the connector
- the ui shows the network of the connected account
- dropping a file shows it staged with its size and type
- a failed upload shows the error instead of silently failing

==========================
<br/>
copyright 2026 by sleet.near
