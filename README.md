# claude-lens
Explore your Claude Code sessions in the browser: cost, tokens, tools and time per session, and search across transcripts. Nothing leaves your machine.

Run `pnpm build`, then `node dist/cli.js sessions <dir>` to list all `.jsonl` transcripts under a directory. Each tab-separated row contains session ID, working directory, cost in dollars, total tokens, tool calls, and elapsed time, ordered by cost (highest first). Unreadable transcripts are reported to stderr and omitted.

Costs sum non-negative `costUSD` numbers on assistant records (missing amounts count as zero). Tokens sum assistant `message.usage` input, output, cache creation input, and cache read input tokens; tool calls count assistant `message.content` blocks of type `tool_use`.
