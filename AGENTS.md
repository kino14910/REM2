## Project Configuration

- **Language**: TypeScript
- **Package Manager**: pnpm
- **Add-ons**: vitest, tailwindcss, playwright, enhanced-img, sveltekit-adapter, paraglide, ai-tools

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Skeleton Documentation

- **Local Reference**: `.claude/references/skeleton-llms-svelte.txt`
- **Official Source**: https://www.skeleton.dev/llms-svelte.txt

When implementing or modifying Skeleton-related features:

1. Verify that the local documentation file exists.
2. Search for the relevant components, APIs, integration guides, and examples.
3. Read only the relevant documentation sections. Do not load the entire document into context unnecessarily.
4. Follow official usage patterns and component conventions.
5. Verify API compatibility against the installed Skeleton, Svelte, and Tailwind CSS versions.
6. Check the actual TypeScript definitions and installed package source when API behavior is unclear.
7. Never invent undocumented component properties, events, or behaviors.
