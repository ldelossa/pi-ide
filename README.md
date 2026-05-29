# pi-ide

Connects a Pi coding-agent session to a running editor over a local
WebSocket MCP server. Provides ambient editor context (current file,
cursor, selection), routes `write`/`edit` tool calls through the editor
as interactive diffs, and serves inline code completions (often called
"suggestions") to editors that request them. The wireformat is compatible
with Claude Code's editor integration.

## Install

```bash
pi install npm:@ldelossa/pi-ide
```

That writes to `~/.pi/agent/settings.json` and loads pi-ide on every pi
session. To scope it to one project instead of globally, add `-l`:

```bash
pi install -l npm:@ldelossa/pi-ide
```

Project installs land in `./.pi/settings.json` and can be checked in so
teammates pick the extension up automatically.

To try it without installing permanently:

```bash
pi -e npm:@ldelossa/pi-ide
```

To remove:

```bash
pi remove npm:@ldelossa/pi-ide
```

Git installs also work if you prefer pinning to a tag:

```bash
pi install git:github.com/ldelossa/pi-ide@v0.1.0
```

You also need an editor that speaks the protocol. The reference Neovim
implementation is at <https://github.com/ldelossa/pi-ide.nvim>.

Once both are running, use `/ide` inside pi to connect to the editor.

## Architecture

1. Editor starts a loopback MCP server on a free TCP port. Writes a lockfile to
   `$PI_IDE_LOCK_DIR` (default `~/.pi/ide/<port>.lock`). Removes it on exit.
2. User runs `/ide` in pi. Extension enumerates lockfiles, filters to entries
   whose `workspaceFolders` cover `cwd`, whose `pid` is alive, and whose port
   accepts connections. Prompts on multiple matches.
3. Extension opens `ws://127.0.0.1:<port>/` with header
   `x-pi-ide-authorization: <authToken>` and runs MCP `initialize`.
4. While connected:
   - Editor pushes `selection_changed` notifications. Extension caches
     `filePath`, cursor, selection. Renders a status widget.
   - Before each agent run, cached state is injected into the system prompt as
     an `<editor>` block.
   - On every `write` or `edit` tool call, extension calls `openDiff`. The call
     blocks until the editor returns `FILE_SAVED` (accept) or `DIFF_REJECTED`
     (reject). On reject, the tool call is blocked and the rejection is
     surfaced to the agent.
5. Session shutdown closes the socket.

## Lockfile

Path: `$PI_IDE_LOCK_DIR/<port>.lock` (default `~/.pi/ide/<port>.lock`).

```
{
  "pid": <int>,
  "workspaceFolders": ["<abs path>", ...],
  "ideName": "<display name>",
  "transport": "ws",
  "authToken": "<uuid>"
}
```

## Transport

- WebSocket on `127.0.0.1:<port>`, path `/`.
- Required header: `x-pi-ide-authorization: <authToken>`. Mismatches
  must be rejected before upgrade.
- Framing: JSON-RPC 2.0 in text frames. One message per frame.
- Protocol: MCP `2024-11-05`. Subset only. `resources/*`, `prompts/*`,
  `logging/*`, and sampling are not used. Server-reported capabilities are
  ignored by the client. Four methods carry the protocol: `initialize`,
  `notifications/initialized`, `tools/list`, `tools/call`.

## Editor-side contract

The editor must:

1. Serve MCP on loopback. Write the lockfile on start, remove on shutdown.
2. Authenticate the upgrade header against the lockfile's `authToken`.
3. Implement `initialize`, `tools/list`, `tools/call`.
4. Implement the tools below.
5. Emit the notifications below.

### Tool: `openDiff`

Input:

| field               | type   | description                                |
| ------------------- | ------ | ------------------------------------------ |
| `old_file_path`     | string | absolute path of the existing file         |
| `new_file_path`     | string | destination path (typically same as old)   |
| `new_file_contents` | string | proposed contents                          |
| `tab_name`          | string | stable id for this diff invocation         |

Behavior: open a two-pane diff between on-disk content and proposed content.
Block (suspend the JSON-RPC response) until the user accepts or rejects.

Response on accept:

```
{ "content": [
  { "type": "text", "text": "FILE_SAVED" },
  { "type": "text", "text": "<final contents>" }
]}
```

Final contents may differ from `new_file_contents` if the user edited the diff
before saving.

Response on reject:

```
{ "content": [
  { "type": "text", "text": "DIFF_REJECTED" },
  { "type": "text", "text": "<tab_name>" }
]}
```

### Tool: `close_tab`

Input: `tab_name` (string). Close the named diff if open. No-op otherwise.

Response:

```
{ "content": [ { "type": "text", "text": "TAB_CLOSED" } ] }
```

### Notification: `selection_changed`

JSON-RPC notification (no `id`). Sent on cursor move, mode change, buffer
enter, and text change. Debounce locally (~100ms recommended).

```
{
  "text": "<selected text, empty when no selection>",
  "filePath": "<abs path>",
  "fileUrl": "file://<abs path>",
  "selection": {
    "start": { "line": <0-based>, "character": <0-based> },
    "end":   { "line": <0-based>, "character": <0-based> },
    "isEmpty": <bool>
  }
}
```

Lines and characters are zero-based. The extension renders line numbers as
1-based.

## Editor-initiated requests

The editor may send JSON-RPC requests to the extension over the same
WebSocket. The extension processes them and returns responses.

### Request: `getSuggestions`

Returns inline code completions for the editor to render as ghost text or
equivalent. The extension calls the configured model (current session
model by default; see model precedence below), parses up to 3
`<SUGGESTION>...</SUGGESTION>` blocks from the response, and returns them.

Input:

| field             | type   | description                                  |
| ----------------- | ------ | -------------------------------------------- |
| `filePath`        | string | optional. absolute path of the cursor file   |
| `language`        | string | optional. filetype or language id            |
| `outline`         | string | optional. structural sketch of the file      |
| `enclosingScope`  | string | optional. surrounding function or class      |
| `cursorBefore`    | string | text before cursor (typically ~20 lines)     |
| `cursorAfter`     | string | text after cursor (typically ~10 lines)      |
| `suggestionCount` | int    | optional. cap on returned alternatives. Max 3. |
| `model`           | string | optional. preferred model "provider/id". CLI flag wins if set. |

`outline` is whatever structural sketch the editor produces with its native
source-analysis tool — treesitter sexpr (Neovim), document symbols from
LSP (VS Code), PSI tree (JetBrains), or omitted entirely. The model accepts
any text. Completion quality scales with the amount of structural context
provided. The minimal viable payload is `cursorBefore` and `cursorAfter`.

Response:

```
{ "suggestions": ["<text>", ...] }
```

Empty `suggestions` is valid and means the model declined to complete.

Cancellation: editor sends `request_cancelled` notification with
`{ "id": <request id> }`. The extension aborts the in-flight model call.

Model precedence: the CLI flag (`--pi-ide-suggestion-model <provider>/<id>`)
wins. Otherwise the editor-provided `model` field is used. If neither is
set, the current session's model is used.

## Reference editor implementation

Neovim: `pi-ide.nvim`. Implements both the editor-side contract (diffs,
diagnostics, selection notifications) and the `getSuggestions` client.
Suggestions always work; treesitter and LSP enrich the context but are
not required — the feature degrades gracefully to cursor-window-only
context when either is unavailable.
