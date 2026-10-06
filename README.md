# claude-lens
Explore your Claude Code sessions in the browser: cost, tokens, tools and time per session, and search across transcripts. Nothing leaves your machine.

Run `pnpm build`, then `node dist/cli.js sessions <dir>` to list all `.jsonl` transcripts under a directory. Each tab-separated row contains session ID, working directory, cost in dollars, total tokens, tool calls, and elapsed time, ordered by cost (highest first). Unreadable transcripts are reported to stderr and omitted. Pass `--limit <n>` (a positive whole number) to print only the first n rows, i.e. the n costliest sessions; any other value exits with status 2 and a usage line on stderr.

Costs sum non-negative `costUSD` numbers on assistant records (missing amounts count as zero). Tokens sum assistant `message.usage` input, output, cache creation input, and cache read input tokens; tool calls count assistant `message.content` blocks of type `tool_use`.

## Browse sessions locally

Run `node dist/cli.js serve <dir>` to start a local web page listing every session under a directory: the same recursive discovery, the same six values and the same cost ordering as `sessions`, but always complete — the page has no `--limit`. It prints the URL to open, such as `http://127.0.0.1:4317/`. The port defaults to 4317; pass `--port <n>` (a whole number from 1 to 65535) to choose another. A missing, nonexistent or non-directory target, or any other port value, exits non-zero with a diagnostic on stderr.

The server binds only to the loopback address 127.0.0.1, so no other machine can reach it, and it answers only requests addressed to `127.0.0.1` or `localhost` at that port, so another web site cannot read the listing through DNS rebinding. Every page load rereads the transcripts, so new sessions appear on the next refresh; unreadable transcripts are reported on the server's stderr and omitted. The server never writes under the directory, shows transcript text literally, and the page loads nothing from any other origin. Stop it with Ctrl+C.

### Read a session

Each session ID on the page links to that transcript's own page at `/sessions/<path>`, where `<path>` is the transcript's path under the directory, so two transcripts sharing a session ID, or carrying none, still open separately; any other `/sessions/` address answers 404. A session page shows the same six values as its row, then the main conversation's messages in recorded order, each with its timestamp and role (`user` or `assistant`). A message is one user or assistant record carrying text or a tool call; a tool call reads as its name followed by its JSON input. Meta records, sidechain (subagent) records, and records holding only tool results or only thinking are left out, and thinking and tool results are never shown, even inside a record that is. Records Claude Code split from one turn stay separate messages. Leaving messages out never changes the six values, which count every record as `sessions` does. Every request rereads the transcript, so new messages appear on the next refresh; text is shown literally.

### Search messages

The sessions page has a search field; submitting it opens `/search?q=<phrase>`, which searches every session the page lists — the same discovery and omissions, never limited — for the phrase. Only the text a session page displays is searched: message text plus each tool call's name and JSON input. Tool results, thinking, meta and sidechain records never match. The phrase is matched literally (no regular expressions or wildcards), ignoring case, anywhere inside a displayed message.

Each matching session links to its `/sessions/<path>` page and shows how many of its messages match — a message counts once however often it contains the phrase — and the full text of its first matching message in recorded order. Sessions with the most matching messages come first. When nothing matches, the page reads `no session matches "<phrase>"`; an empty phrase redirects to the sessions page. Every search rereads the transcripts, so new sessions and messages are searchable on the next request, and the phrase and message text are shown literally.
