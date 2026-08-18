<div align="center">

<img src="docs/assets/logo.svg" alt="qingagent" width="112">

# dsh-qingagent

**qingagent inside DeepSeek Harness**

A plugin built to the DSH spec: one command to install or remove, and you can write and review documents with qingagent right inside DSH.

[![npm](https://img.shields.io/npm/v/dsh-qingagent)](https://www.npmjs.com/package/dsh-qingagent)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

[qingagent repo](https://github.com/from-void/qingagent) · [qingagent.com](https://qingagent.com) · [中文](./README.md)

<img src="docs/assets/dsh-demo.gif" alt="Drafting in DSH with the paper panel filling in on the right" width="880">

</div>

---

## What is this

DeepSeek Harness (DSH) is DeepSeek's open-source "everything is a plugin" agent framework. Install dsh-qingagent and DSH gains a pen:

Describe what you want in the conversation, and the agent drafts, edits and submits reviews through the qingagent engine. A **paper panel** grows on the right — rendering from the same source as the qingagent desktop app: serif type, warm paper, square corners, with formulas, Mermaid, draw.io, tables, footnotes and a seal-stamped colophon.

**The chat keeps a summary; the manuscript is the real thing.**

### What you can do

- **Draft from one sentence**: the agent writes the finished piece into the paper panel; while the page is still empty you get qingagent's own "qing character diffusion" loading animation;
- **Per-change verdicts**: every AI edit is a candidate — walk through them on the page, accept or reject, commit to land. When the change ratio is high it switches to a full-document old/new comparison;
- **Annotation carousel**: review annotations sit in place on the page and can be flipped through one by one;
- **Selection chips**: select text on the page and it becomes a "selection" chip in the input box — multiple chips supported, hover for the full quote, and sent messages render them as chips too;
- **Review and export live on the page**: export to PDF / Word / HTML / Markdown / TXT and download directly;
- **Several drafts per session**: `qing_list_docs` / `qing_focus_doc` switch the preview on the right;
- **"Open in qingagent"**: a deep link launches the desktop client so you can keep editing — same local library.

---

## Relationship with the qingagent repo

This plugin is the DSH frontend of [**qingagent**](https://github.com/from-void/qingagent), not a standalone product.

**Because of the plugin's own complexity — the paper rendering is deeply coupled with the manuscript engine, and documents and versions live in a local database — the qingagent desktop client must be installed first for the plugin to work.** The client hosts the engine and the local library; the plugin wires it into DSH's conversation and UI.

That coupling buys you something: **a draft written in DSH can be opened and edited in the qingagent client**, and vice versa — one local library, not two copies.

---

## Install (three steps)

**① Start DeepSeek Harness** (Node.js 20+)

```bash
npx @deepseek-ai/dsh web
```

**② Install the qingagent plugin**

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-qingagent@latest
```

Restart `dsh web` afterwards.

**③ Download and launch qingagent once**

Get it from [qingagent.com](https://qingagent.com/#download) or [qingagent Releases](https://github.com/from-void/qingagent/releases). Launching it once starts the engine and writes credentials to `~/.qingagent/instance.json`; the plugin connects automatically.

> If qingagent is missing or not running, the panel shows an onboarding card: **not installed** → download instructions; **installed but not running** → a one-click "Launch qingagent"; **handshake failed** → the specific reason (a corrupted `instance.json`, for example). Once qingagent is up the plugin recovers on its own — no need to restart DSH.

Requirements: DSH `0.1.0-rc.6` as the baseline (peer dependency `^0.1.0-rc.6`), with a profile that already composes the storage hub, storage-domain and a KV backend (usually `@deepseek-ai/dsh-storage-json`).

---

## Supported setups

**Officially supported: dsh running on Windows with the Windows qingagent desktop client, same machine and same user.**

The implementation also includes macOS client detection (`mdfind` with an Applications-directory fallback), but it has not been fully validated — issues welcome.

**WSL and cross-OS setups are not supported**: the plugin reads `~/.qingagent/instance.json` from the current system's home directory, so dsh in WSL cannot see a client installed on Windows and cannot reach the engine.

---

## Capabilities

### Host tools (callable by the agent)

| Tool | Parameters | Purpose |
|---|---|---|
| `qing_write_draft` | `brief` required; `title?` `style?` `docRef?` | Generate a whole QingML document. Without `docRef` it creates a new draft; with a `docRef` bound to this session it rewrites the whole piece (requires explicit user authorisation) |
| `qing_edit_draft` | `docRef?`; `ops[]` required | Atomically submit a batch of structured local edits; refused while a review is in progress |
| `qing_read_draft` | `docRef?`; `mode` defaults to `outline` | Tiered reads: `outline` / `full` / `base` (committed baseline) / `lines` (numbered Markdown) / `blocks` (block ids) |
| `qing_review_commit` | `docRef?`; `action: accept_all \| reject_all` | Accept or reject the pending review wholesale; hard-limited to one call per turn |
| `qing_list_docs` | `scope: session \| library` | List drafts bound to this session; `library` lists recent documents from the whole qingagent library (max 50) |
| `qing_focus_doc` | `docRef` required | Switch the paper panel; unbound documents can be adopted by engine id or an exact unique title |

The eight `qing_edit_draft` operations:

| `kind` | Semantics |
|---|---|
| `strReplace` | `old` → `new`, optionally the `nth` match |
| `markText` | Add / remove inline marks on matches: `bold`, `italic`, `strike`, `underline`, `code`, `highlight(color)`, `textColor(color)`, `link(href,title?)`; supports `all`, `isRegex`, `withinRef` |
| `insertAfterLine` | Insert after line N of the committed Markdown |
| `insertAfterBlock` | Insert a block after a top-level block, or a sibling item after a list item |
| `appendSection` | Append a section |
| `deleteBlock` | Delete a whole top-level block |
| `deleteListItem` | Delete a list / task item; the engine cleans up the parent list after the last one |
| `setTitle` | Change the metadata title, leaving the body untouched |

> Request-level `opId` idempotency applies only to `deleteBlock`, `deleteListItem` and `insertAfterBlock`; every proposal also carries a random `clientMutationId`.

### The paper panel (client)

qingagent's web editor is compiled straight into the plugin from the `vendor/qingagent` submodule, so the look matches the desktop app:

- **Per-change verdicts**: `DocumentSnapshotView` takes the patch set; the PatchNav at the bottom handles previous/next, reject-all and settlement. After settlement a structured review-result message flows back **only when something was rejected**;
- **Whole-document review**: a high change ratio switches to old/new navigation with "apply new" / "revert to old";
- **Annotation carousel**: external annotations become the product's `AnnotationGroup`, decorated into ProseMirror and rendered with qingagent's native carousel; annotations hide themselves while body patches are under review;
- **Selection chips**: the selected text plus block coordinates go through the bridge and become an input-box reference — multiple, de-duplicated, with full quotes on hover;
- **Diagrams and export**: double-click a draw.io block to open the offline editor and write back; export supports PDF / DOCX / HTML / Markdown / TXT;
- **Deep link**: `qingjian://open?engineSessionId=<id>` launches the desktop client.

**Attribution**: every external write from this plugin is tagged `x-qa-client: deepseek` and shows up as a "DeepSeek Harness" source inside qingagent.

---

## Connection & self-healing

1. **Instance discovery**: reads `~/.qingagent/instance.json` for the current user, requires `schemaVersion=2`, and validates `port` / `pid` / `version` / `attachProtocolVersion` / `token` / `startedAt`;
2. **Port authority**: when an instance exists the configured `engineUrl` port is ignored and the plugin connects to `http://127.0.0.1:<instance.port>` (the desktop port defaults to 21823 and falls back to a random one when taken);
3. **Handshake**: checks the attach protocol and process liveness, then calls health with a Bearer token; on a 401 it re-reads the instance file and token once;
4. **Four states**: `online` / `offline` / `starting` / `handshake-failed`, each with a specific reason;
5. **Backoff**: retry intervals of 5s → 10s → 20s → 30s, then holding at 30s; back to a 5s health cadence once online;
6. **Client detection**: on Windows, the HKCU protocol registration plus HKCU/HKLM uninstall entries (including the `/reg:64` view); on macOS, `mdfind` by bundle id with `/Applications/青简.app` and the user Applications directory as fallbacks. Detection results are cached for 30 seconds. The launch endpoint only accepts paths resolved and `stat`-ed by the detector — never a path submitted by the browser.

> With `autoLaunch` and `engineCommand` configured, the wait budget for the engine to come up is 20 seconds.

---

## Configuration

| Field | Default | Notes |
|---|---|---|
| `engineUrl` | `http://127.0.0.1:8080` | **Fallback only** — used when no `instance.json` can be read; a live instance's port wins |
| `engineCommand` / `engineCwd` | unset | Optional launch command and working directory, executed only with `autoLaunch` |
| `autoLaunch` | `false` | Starts the engine detached when offline; removing the plugin never kills your engine |
| `sideModel.provider` / `.model` | unset | Fallback when the current agent does not expose a provider/model; the block is optional, but both fields are required if present |
| `workspaceProjection` | `true` | **Reserved field** — no runtime effect today |

---

## Security boundaries

- **The token never reaches the browser**: `instance.json` and its token are read only by the Node host, which attaches the Bearer header to health checks, external API calls and export requests. The bridge payload sent to the browser carries engine status, bindings, documents and selections — no token.
- **The bridge is loopback-only**: `/qingagent-bridge/*` and `/drawio` reject non-loopback addresses before any business logic (IPv4, IPv6 and IPv4-mapped loopback accepted).
- **Session isolation**: document reads/writes, assets, exports and reviews are all checked against the `dshSessionId + engineSessionId` binding. `focus` with `adopt:true` is the explicit adoption exception, which probes the engine document before joining it to the session.
- **Style isolation**: dynamically imported vendor CSS is wrapped in `@scope`, while the mechanically extracted `qingdoc.css` is rewritten with a `[data-qingagent-doc-panel]` selector prefix — neither leaks into the host UI.
- **QingML rendering**: production rendering goes through qingagent's `qingmlParse` with an explicit tag allowlist, allowlists for links and images, and a final Zod schema check before anything enters ProseMirror; `script` and `style` are dropped.
- **draw.io assets**: GET/HEAD only, directory traversal blocked, CSP and `SAMEORIGIN` on HTML; iframe messages validate both `event.source` and a same-origin origin.

Binding data lives in the `dsh_qingagent` v1 domain of `@deepseek-ai/dsh-storage-domain`.

---

## Developing from source

```bash
git clone --recursive https://github.com/from-void/dsh-qingagent.git
cd dsh-qingagent
npm install
npm run check   # CSS pinning check + typecheck + tests + build

# POSIX shell
npx @deepseek-ai/dsh plugin --profile web add link:$(pwd)
# Windows PowerShell
npx @deepseek-ai/dsh plugin --profile web add link:${PWD}
```

> Forgot `--recursive`? Run `git submodule update --init`. The build scripts use POSIX tools (`rm -rf` and friends), so on Windows run development builds in Git Bash or WSL.

The `dsh.bundle.patch` entry in `package.json` merges the in-repo `cordis.patch.yml`; do not keep a hand-written mount alongside the bundle mount or the plugin registers twice.

### Build-time dependency: the vendor/qingagent submodule

The paper rendering reuses qingagent's `apps/web` sources and CSS, read at build time from `QING_ROOT`:

- default `vendor/qingagent` (a submodule pinned to a verified commit);
- `QING_ROOT=/path/to/qingagent` overrides it (point it at your own qingagent worktree during development);
- the offline draw.io runtime is published from there too, with `QINGAGENT_DRAWIO_ROOT` as a separate override.

CSS is extracted mechanically by "file + line range" (`scripts/extract-qingdoc-css.mjs`). `npm run check:qingdoc-css` does a byte-level comparison and is wired into `check` and `prepack`: **run it right after upgrading the submodule** — drifting line numbers cut the extraction in the wrong place and produce a broken build. A red check means do not publish; realign the pinned ranges, then run the full check.

### Tests

```bash
npm run check   # everything: CSS pinning + typecheck + vitest + build
npm test        # unit tests only
```

Contract tests lock down: the 800px page width, serif type, square corners and warm palette applying only to the panel root; CSS extraction matching the pinned ranges; bridge loopback and session isolation; the QingML XSS allowlist; review-state interception and 401 token re-reads.

---

## Community

Scan to join the WeChat user group — report problems, request features, follow updates:

<!-- TODO: WeChat group QR code pending -->
<!-- <img src="docs/assets/wechat-group.png" alt="qingagent user group" width="220"> -->

---

## Contact

- Usage questions, bugs, feature requests: [GitHub Issues](https://github.com/from-void/dsh-qingagent/issues)
- Issues with qingagent itself: [qingagent Issues](https://github.com/from-void/qingagent/issues)

<!-- TODO: author contact pending -->

---

## License

[Apache-2.0](./LICENSE) for this repository. The `vendor/qingagent` submodule is [qingagent](https://github.com/from-void/qingagent), MIT.
