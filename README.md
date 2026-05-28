# pi-ide

Connects a Pi coding-agent session to a running editor over a local
WebSocket MCP server. Provides ambient editor context (current file, cursor,
selection) and routes `write`/`edit` tool calls through the editor as
interactive diffs. The wireformat is compatible with Claude Code's editor
integration.

## Install

```bash
pi install git:github.com/ldelossa/pi-ide@v0.1.0
```

That writes to `~/.pi/agent/settings.json` and loads pi-ide on every pi
session. To scope it to one project instead of globally, add `-l`:

```bash
pi install -l git:github.com/ldelossa/pi-ide@v0.1.0
```

Project installs land in `./.pi/settings.json` and can be checked in so
teammates pick the extension up automatically.

To try it without installing permanently:

```bash
pi -e git:github.com/ldelossa/pi-ide@v0.1.0
```

To remove:

```bash
pi remove git:github.com/ldelossa/pi-ide
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

## Reference editor implementation

Neovim: `pi-ide.nvim`.
