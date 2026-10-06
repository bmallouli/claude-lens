# claude-lens
Explore your Claude Code sessions in the browser: cost, tokens, tools and time per session, and search across transcripts. Nothing leaves your machine.

Run `pnpm build`, then `node dist/cli.js sessions <dir>` to list all `.jsonl` transcripts under a directory. Each tab-separated row contains session ID, working directory, cost in dollars, total tokens, tool calls, and elapsed time, ordered by cost (highest first). Unreadable transcripts are reported to stderr and omitted. Pass `--limit <n>` (a positive whole number) to print only the first n rows, i.e. the n costliest sessions; any other value exits with status 2 and a usage line on stderr.

Costs sum non-negative `costUSD` numbers on assistant records (missing amounts count as zero). Tokens sum assistant `message.usage` input, output, cache creation input, and cache read input tokens; tool calls count assistant `message.content` blocks of type `tool_use`.

## Browse sessions locally

Run `node dist/cli.js serve <dir>` to start a local web page listing every session under a directory: the same recursive discovery, the same six values and the same cost ordering as `sessions`, but always complete — the page has no `--limit`. It prints the URL to open, such as `http://127.0.0.1:4317/`. The port defaults to 4317; pass `--port <n>` (a whole number from 1 to 65535) to choose another. A missing, nonexistent or non-directory target, or any other port value, exits non-zero with a diagnostic on stderr.

The server binds only to the loopback address 127.0.0.1, so no other machine can reach it, and it answers only requests addressed to `127.0.0.1` or `localhost` at that port, so another web site cannot read the listing through DNS rebinding. Every page load rereads the transcripts, so new sessions appear on the next refresh; unreadable transcripts are reported on the server's stderr and omitted. The server never writes under the directory, shows transcript text literally, and the page loads nothing from any other origin. Stop it with Ctrl+C.
