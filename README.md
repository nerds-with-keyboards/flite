# flite

One file. No dependencies. Just bash.

## Install

```bash
npm i -g @nwk/flite
```

## Setup

1. Obtain an OpenRouter API key
2. Set the API key for `flite` by either:
   - `export OPENROUTER_API_KEY=sk-or-...`
   - create a config at `~/.flite/config.json` with your API key: `{"apiKey": "OPENROUTER_API_KEY=sk-or-...", "defaultModel": "openrouter/sonoma-sky-alpha"}`
     Note: `defaultModel` is optional.

## Use

### Interactive Mode

```bash
flite
```

### CLI Mode (Non-interactive)

```bash
# One-shot command
flite "what is 2+2"

# Pipe to file
flite "list files in current directory" > files.txt

# Use in scripts
result=$(flite "get current time")

# Multi-word prompts (no quotes needed)
flite what is the weather today
```

## Features

- **Interactive mode**: Full REPL with confirmation prompts
- **CLI mode**: One-shot execution for scripting
- **Bash execution**: All commands with automatic output capture
- **Smart confirmations**: Yes/No/Always per command (interactive only)
- **Piping friendly**: Clean output for `>`, `|`, and `$()`
- That's it

## Commands (Interactive Mode Only)

- `/help` - Show commands
- `/model` - Current model
- `/cost` - Session cost
- `/clear` - Clear chat
- `/exit` - Quit

## How AI Executes Commands

The AI uses a special format to request command execution:

Single command:

```
fff/execute:ls -la
```

Multiple commands:

````
```fff/execute:
ls -la
echo "Done"
````

```

**Interactive mode**: You'll be prompted to confirm each command:
- `y` - Execute once
- `n` - Skip this command
- `a` - Always allow this exact command (this session only)

**CLI mode**: Commands execute automatically without confirmation

## Philosophy

Every line of code is a liability. This is what happens when you actually follow that principle.

No:
- Classes
- Config files
- Dependencies
- Fancy UI
- Caching
- Metrics
- Tests

Just:
- One file
- Direct API calls
- Basic tools
- Simple REPL




## When to use

**Use flite when:**
- You want simplicity
- You need scripting/automation
- You're building pipelines
- You're debugging
- You're learning


## License

MIT - Because even the license should be simple.
```
