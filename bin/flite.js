#!/usr/bin/env node

/** flite - The minimal AI assistant */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { createInterface } from 'readline';

// ===== CONSTANTS =====
const VERSION = '0.0.1-lite';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_DIR = join(homedir(), '.flite');
const CONFIG_FILE = join(homedir(), '.flite', 'config.json');
const HISTORY_FILE = join(APP_DIR, 'history.json');
const MAX_HISTORY = 100;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_SAVED_MESSAGES = 20;
const COMMAND_TIMEOUT_MS = 30000;
const HISTORY_SIZE = 100;

// Tool patterns
const TOOL_PATTERNS = [
  /`fff\/execute:(.+?)`/g, // Single backtick format
  /```fff\/execute:\n([\s\S]*?)```/g, // Triple backtick with colon
];

// ===== LOAD CONFIG =====
function loadConfig() {
  let apiKey = null;
  let model = 'openrouter/sonoma-sky-alpha'; // default

  // First check environment variables
  if (process.env.OPENROUTER_API_KEY) {
    apiKey = process.env.OPENROUTER_API_KEY;
  }
  if (process.env.AI_MODEL) {
    model = process.env.AI_MODEL;
  }

  // Then check ~/.flite/config.json
  if (existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (!apiKey && config.apiKey) {
        apiKey = config.apiKey;
      }
      if (!process.env.AI_MODEL && config.defaultModel) {
        model = config.defaultModel;
      }
    } catch (e) {
      console.error('Config parse error:', e.message);
    }
  }

  return { apiKey, model };
}

const { apiKey: API_KEY, model: MODEL } = loadConfig();

// ===== ANSI COLORS =====
const shouldUseColors = !process.env.NO_COLOR && process.stdout.isTTY;
const colors = shouldUseColors
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      red: '\x1b[91m',
      green: '\x1b[92m',
      yellow: '\x1b[93m',
      cyan: '\x1b[96m',
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      red: '',
      green: '',
      yellow: '',
      cyan: '',
    };

// ===== GLOBAL STATE =====
let messages = [];
let history = [];
let sessionCost = 0;
let sessionTokens = 0;
let isRunning = true;
let rl;
const alwaysCommands = new Set(); // Track commands approved with "always"
let isNonInteractive = false; // CLI mode flag

// ===== UTILITIES =====
const print = (text, color = '') =>
  process.stdout.write(color + text + colors.reset);
const println = (text = '', color = '') => print(`${text}\n`, color);
const error = (text) => !isNonInteractive && println(`❌ ${text}`, colors.red);
const info = (text) => !isNonInteractive && println(`ℹ️  ${text}`, colors.cyan);

// ===== GET CONTEXT STATUS =====
function getContextStatus(shouldResume) {
  if (shouldResume && existsSync(HISTORY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      history = data.history || [];
      messages = data.messages || [];

      if (messages.length > 0) {
        const msgCount = messages.filter((m) => m.role === 'user').length;
        let status = `Resumed context with ${msgCount} previous exchange${
          msgCount !== 1 ? 's' : ''
        }`;

        // Add preview of last exchange
        const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
        const lastAssistantMsg = messages
          .filter((m) => m.role === 'assistant')
          .pop();

        if (lastUserMsg && lastAssistantMsg) {
          const userPreview = lastUserMsg.content
            .slice(0, 30)
            .replace(/\n/g, ' ');
          const assistantPreview = lastAssistantMsg.content
            .slice(0, 30)
            .replace(/\n/g, ' ');
          const userEllipsis = lastUserMsg.content.length > 30 ? '...' : '';
          const assistantEllipsis =
            lastAssistantMsg.content.length > 30 ? '...' : '';

          status += `\n${colors.dim}Last: "${userPreview}${userEllipsis}" → "${assistantPreview}${assistantEllipsis}"${colors.reset}`;
        }

        return status;
      }
    } catch (e) {
      console.error('History load error:', e.message);
    }
  }

  // Default: fresh context (no history loaded)
  history = [];
  messages = [];
  return 'Starting fresh context';
}

// ===== SETUP =====
function setup() {
  // Check API key
  if (!API_KEY) {
    error('Missing OpenRouter API key');
    println('\nTo get started:');
    println('1. Get an API key from https://openrouter.ai');
    println('2. Either:');
    println('   - Run: export OPENROUTER_API_KEY=sk-or-...');
    println('   - Or create a config at `~/.flite/config.json` with `apiKey`');
    println('                (you can also set `defaultModel` in the config)');
    println('3. Try again: flite');
    process.exit(1);
  }

  // Create app directory
  if (!existsSync(APP_DIR)) {
    mkdirSync(APP_DIR, { recursive: true });
  }

  // Setup readline
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.cyan}> ${colors.reset}`,
    terminal: true,
    historySize: HISTORY_SIZE,
  });

  // Apply history
  history.forEach((cmd) => rl.history.push(cmd));
}

// ===== SAVE STATE =====
function saveState() {
  // Don't save in non-interactive mode
  if (isNonInteractive) return;

  try {
    const data = {
      history: history.slice(-MAX_HISTORY),
      messages: messages.slice(-MAX_SAVED_MESSAGES),
      timestamp: Date.now(),
    };
    writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Save state error:', e.message);
  }
}

// ===== MAIN CONVERSATION LOOP =====
async function runConversation(userInput) {
  // Add user message
  messages.push({ role: 'user', content: userInput });

  let continueLoop = true;

  while (continueLoop) {
    // Get AI response
    const aiResponse = await callAI();

    if (!aiResponse) {
      break; // Error occurred
    }

    // Extract and execute commands
    const commands = extractCommands(aiResponse);

    if (commands.length > 0) {
      // Execute all commands
      for (const command of commands) {
        await executeWithConfirm(command);
      }
      // Continue loop - AI will respond again with the tool output in context
      // Show that we're processing the tool output
      if (!isNonInteractive) {
        println(); // Add spacing
        print(`${colors.dim}Thinking...${colors.reset}`);
      }
    } else {
      // No tools, we're done
      continueLoop = false;
    }
  }
}

// ===== AI INTERACTION =====
async function callAI() {
  // Prepare system prompt
  const systemPrompt = `You are flite, a minimal interactive AI CLI tool that helps with software engineering tasks. Use the instructions below and the tools available to you to assist the user. Current directory is \`${process.cwd()}\`
When you need to execute tools, use this format with none other than introductory text (likewise use backticks):
\`fff/execute:ls -la\`
Or for multiple commands:
\`\`\`fff/execute:
ls -la
cat README.md
\`\`\`

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are accurate.

If the user asks for help or wants to give feedback inform them of the following: To give feedback, users should report the issue at https://github.com/nerds-with-keyboards/flite/issues

# Tone and style

You should be concise, direct, and to the point. When you run a non-trivial bash command, you should first explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
Remember that your output will be displayed on a command line interface. Your responses can use Github-flavored markdown for formatting, and will be rendered in a monospace font.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless important for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Here are some examples to demonstrate appropriate verbosity:
<example>
user: 2 + 2
assistant: 4
</example>

<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: what command should I run to watch files in the current directory?
assistant: [use the ls tool to list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
npm run dev
</example>

<example>
user: How many golf balls fit inside a jetta?
assistant: 150000
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

# Proactiveness

You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:

1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
   For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

# Following conventions

When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.

- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style

- Code should be in modern (Node.js v22 or v24) JS style, using npm and standard JS/Node APIs
- Write JSDoc for ALL functions and components
- Use Node.js built-in test runner
- Format with Prettier. Lint with ESLint. Ensure code updates pass formatting/linting
- Never install or import additional libraries without extreme need and permission from the user, use standard Node.js features. Prioritize libs with no dependencies
- Follow the development recommendations in "A Philosophy of Software Design"
- Strictly avoid all Observables, Proxies, RxJS patterns, data fetching libraries, decorators, or exotic patterns
- Always use an options dictionary as a first parameter whenever you need more than one param
- Functions should do only one thing and should not have side-effects
- Constants should be in UPPER_SNAKE_CASE near the top of a file, or included in a constants file for re-used ones
- Prefer composition over inheritance (never use classes)
- Create simple APIs that hide complexity from users
- Provide sensible defaults, minimal configuration
- "It just works" philosophy - user shouldn't need to configure
  - Wrong example: \`terminal.createInterface().setPrompt().on('line', ...)\`
  - Right example: \`terminal.question(prompt)\`
- Keep functions focused on a single responsibility
- Use descriptive names that explain intent
- Handle errors gracefully with try/catch
- Write code that reads like documentation
- No comments unless absolutely necessary
- Frontend rules:
  * Styling:
    * Use DaisyUI + Tailwind CSS. PRIORITIZE DaisyUI classes
    * Use Tailwind CSS ONLY for layout, animations, or features DaisyUI lacks
    * Use ONLY DaisyUI theming system (themes, dark mode, theme colors like bg-neutral)
    * STRICTLY NO custom CSS
    * STRICTLY NO other CSS or CSS-in-JS libraries (Styled Components, Emotion, etc.)
    * NO other component libraries (EXCEPTION: single complex item like MUI X DataGrid, IF it responds to light/dark themes and is themable with TW/DaisyUI). 
    * NO Headless UI libraries (Radix, Headless UI, etc.) unless specifically approved under the single complex component exception.
  * Components:
    * AVOID over-componentization (no components for basic/re-usable items- ONLY complex components)
    * Use DaisyUI prose class for text styling instead
  * Code Practices:
    * Use standard DOM/Browser APIs, modern JavaScript (ES features), React primitives
    * Avoid Premature Optimization: Profile performance first. Use React.memo, useMemo, useCallback judiciously only when proven necessary, not by default.
    * Use semantic HTML elements correctly keeping in mind a11y best practices.
    * State: Use Redux Toolkit (RTK) for application-level state when necessary. NO other global state managers (Zustand, Jotai, Valtio, Recoil, etc.).
    * Hooks: Use custom hooks SPARINGLY, only for genuinely complex logic (not basic data fetching or simple state encapsulation).
    * Error Handling: Use an error boundary class like the one in Routerino. No additional libraries for error handling.
    * Accessibility: Follow a11y best practices. Use eslint-plugin-jsx-a11y for linting accessibility issues.
    * Testing: Use Node.js built-in test runner. Use React Testing Library ONLY IF needed for components. NO extra testing libraries.
  * STRICTLY AVOID:
    * Data Fetching / Server State Libraries (React Query/TanStack Query, SWR, Apollo Client, etc.). Use native fetch or simple wrappers + RTK/component state.
    * Form management libraries. Use native FormData API + Object.fromEntries. 
    * State Machines (XState, etc.).
    * Advanced Redux Middleware beyond RTK defaults (e.g., redux-saga).

# Doing tasks

The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:

- Use the available search tools to understand the codebase and the user's query.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.


# Tool usage policy

- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.
- If a tool fails, stop and investigate to fix the issue before moving on.

# Code References

When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>
`;

  // Build request
  const requestMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.slice(-MAX_CONTEXT_MESSAGES),
  ];

  try {
    if (isNonInteractive && process.stderr.isTTY) {
      process.stderr.write('Thinking...\r');
    }

    // Make API call
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: requestMessages,
        stream: true,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error: ${response.status} - ${text}`);
    }

    // Process streaming response
    let fullResponse = '';
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let hasStartedStreaming = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              // Clear thinking indicator on first content
              if (!hasStartedStreaming) {
                if (isNonInteractive && process.stderr.isTTY) {
                  process.stderr.write('\r           \r'); // Clear "Thinking..."
                } else if (!isNonInteractive) {
                  // In interactive mode, clear the "Thinking..." we showed
                  process.stdout.write('\r           \r');
                }
                hasStartedStreaming = true;
              }
              fullResponse += content;
              // In non-interactive mode, output without colors
              if (isNonInteractive) {
                process.stdout.write(content);
              } else {
                print(content);
              }
            }

            // Track usage
            if (parsed.usage) {
              sessionTokens += parsed.usage.total_tokens || 0;
              if (parsed.usage.total_cost) {
                sessionCost += parsed.usage.total_cost;
              }
            }
          } catch (e) {
            console.error('Stream parse error:', e.message);
          }
        }
      }
    }

    if (!isNonInteractive) println(); // New line after response in interactive mode only

    // Add assistant message
    messages.push({ role: 'assistant', content: fullResponse });

    return fullResponse;
  } catch (e) {
    error(`Failed: ${e.message}`);
    return null;
  }
}

// ===== EXTRACT COMMANDS =====
function extractCommands(text) {
  const commands = [];

  // Extract single-line commands
  let match;
  TOOL_PATTERNS[0].lastIndex = 0; // Reset regex
  while ((match = TOOL_PATTERNS[0].exec(text)) !== null) {
    commands.push(match[1].trim());
  }

  // Extract multi-line commands
  TOOL_PATTERNS[1].lastIndex = 0; // Reset regex
  while ((match = TOOL_PATTERNS[1].exec(text)) !== null) {
    // Keep the entire multi-line block as a single command
    const multiCommand = match[1].trim();
    if (multiCommand) {
      commands.push(multiCommand);
    }
  }

  return commands;
}

// ===== CONFIRM AND EXECUTE =====
async function executeWithConfirm(command) {
  // In non-interactive mode, auto-execute all commands
  if (isNonInteractive) {
    await executeBash(command);
    return;
  }

  // Check if this command was already approved with "always"
  if (alwaysCommands.has(command)) {
    info(`Auto-executing (previously approved): ${command}`);
    await executeBash(command);
    return;
  }

  // Ask for confirmation
  println(
    `${colors.yellow}Execute command: ${colors.bold}${command}${colors.reset}`
  );
  const answer = await new Promise((resolve) => {
    rl.question(
      `${colors.cyan}[y]es / [n]o / [a]lways for this command: ${colors.reset}`,
      resolve
    );
  });

  const normalized = answer.toLowerCase().trim();

  if (normalized === 'y' || normalized === 'yes') {
    await executeBash(command);
  } else if (normalized === 'a' || normalized === 'always') {
    alwaysCommands.add(command);
    info(`Will auto-execute "${command}" for this session`);
    await executeBash(command);
  } else {
    info('Command skipped');
    messages.push({
      role: 'system',
      content: `User declined to execute: ${command}`,
    });
  }
}

// ===== TOOL: BASH =====
async function executeBash(command) {
  if (!command) return;

  info(`Running: ${command}`);

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });

    let allOutput = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      allOutput += text;
      if (!isNonInteractive) print(text, colors.dim);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      allOutput += text;
      if (!isNonInteractive) print(text, colors.red);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        allOutput += `\n[Exit code: ${code}]`;
      }

      // Return ALL output to the agent
      messages.push({
        role: 'system',
        content: `Command: ${command}\nOutput:\n${allOutput}`,
      });
      resolve();
    });

    // Kill after timeout
    setTimeout(() => {
      child.kill();
      allOutput += `\n[Command timed out after ${
        COMMAND_TIMEOUT_MS / 1000
      } seconds]`;
    }, COMMAND_TIMEOUT_MS);
  });
}

// ===== COMMAND HANDLER =====
async function handleCommand(input) {
  const trimmed = input.trim();

  // Handle commands
  if (trimmed === '/exit' || trimmed === '/quit') {
    isRunning = false;
    return true;
  }

  if (trimmed === '/clear') {
    messages = [];
    info('Conversation cleared');
    return true;
  }

  if (trimmed === '/cost') {
    println(`Session cost: $${sessionCost.toFixed(4)}`);
    println(`Tokens used: ${sessionTokens}`);
    return true;
  }

  if (trimmed === '/help') {
    println(`${colors.bold}\nflite commands:${colors.reset}`);
    println('  /help   - Show this help');
    println('  /cost   - Show session cost');
    println('  /clear  - Clear conversation');
    println('  /exit   - Exit flite');
    println('\nJust type to chat with AI!');
    return true;
  }

  if (trimmed.startsWith('/')) {
    error(`Unknown command: ${trimmed}`);
    return true;
  }

  return false;
}

// ===== NON-INTERACTIVE MODE =====
async function runNonInteractive(prompt, shouldResume) {
  isNonInteractive = true;

  // Minimal setup - no readline needed
  if (!API_KEY) {
    console.error('Error: Missing OpenRouter API key');
    process.exit(1);
  }

  // Load context if --resume was passed
  if (shouldResume && existsSync(HISTORY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      messages = data.messages || [];
      // Don't load history array - not needed for CLI
    } catch (e) {
      console.error('History load error:', e.message);
    }
  } else {
    // Fresh context
    messages = [];
  }

  // Run conversation and output only the AI response
  await runConversation(prompt);

  // Save the updated context for potential future --resume
  if (existsSync(APP_DIR) || shouldResume) {
    // Create directory if needed
    if (!existsSync(APP_DIR)) {
      mkdirSync(APP_DIR, { recursive: true });
    }

    try {
      const data = {
        history: [], // No command history in CLI mode
        messages: messages.slice(-MAX_SAVED_MESSAGES),
        timestamp: Date.now(),
      };
      writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Save state error:', e.message);
    }
  }

  // Exit cleanly
  process.exit(0);
}

// ===== MAIN LOOP =====
async function main() {
  // Check for CLI arguments
  const args = process.argv.slice(2);

  // Check for --resume flag
  const resumeIndex = args.indexOf('--resume');
  const shouldResume = resumeIndex !== -1;

  if (shouldResume) {
    // Remove --resume from args
    args.splice(resumeIndex, 1);
  }

  // Non-interactive mode (if args remain after removing --resume)
  if (args.length > 0) {
    const prompt = args.join(' ');
    return runNonInteractive(prompt, shouldResume);
  }

  // Interactive mode
  println(`${colors.bold}\nflite${colors.reset}`);
  println(`${colors.dim}v${VERSION} | ${MODEL}`);

  // Get context status (pass shouldResume flag)
  const contextStatus = getContextStatus(shouldResume);

  // Setup readline and directories
  setup();

  // Show context status
  println(`${colors.yellow}${contextStatus}${colors.reset}`);

  if (!shouldResume && existsSync(HISTORY_FILE)) {
    // If not resuming but history exists, show hint
    println(
      `${colors.dim}Use --resume to continue previous conversation${colors.reset}`
    );
  }

  println(`${colors.dim}Type /help for commands\n`);

  // Main interaction loop
  rl.on('line', async (input) => {
    if (!input.trim()) {
      rl.prompt();
      return;
    }

    // Save to history
    history.push(input);

    // Handle commands
    const isCommand = await handleCommand(input);

    if (!isCommand) {
      // Process with AI
      await runConversation(input);
    }

    // Save state
    saveState();

    // Check if we should exit
    if (!isRunning) {
      // Show stats
      println(`${colors.dim}\nSession stats:`);
      println(`${colors.dim}  Tokens: ${sessionTokens}`);
      println(`${colors.dim}  Cost: $${sessionCost.toFixed(4)}`);

      rl.close();
      process.exit(0);
    }

    rl.prompt();
  });

  // Handle Ctrl+C
  let ctrlCCount = 0;
  let ctrlCTimer = null;

  rl.on('SIGINT', () => {
    ctrlCCount++;

    // Reset count after 2 seconds
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => {
      ctrlCCount = 0;
    }, 2000);

    if (ctrlCCount === 1) {
      println(`\n${colors.yellow}Press Ctrl+C again to exit${colors.reset}`);
      rl.prompt();
    } else {
      // Second Ctrl+C - exit immediately
      println(`\n${colors.dim}Exiting...${colors.reset}`);
      saveState();
      process.exit(0);
    }
  });

  // Start
  rl.prompt();
}

// ===== CLEANUP =====
process.on('exit', saveState);
process.on('SIGTERM', () => {
  saveState();
  process.exit(0);
});

// ===== ERROR HANDLING =====
process.on('uncaughtException', (err) => {
  error(`Unexpected error: ${err.message}`);
  saveState();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  error(`Unhandled promise rejection: ${err}`);
  saveState();
  process.exit(1);
});

// ===== START =====
main().catch((err) => {
  error(`Failed to start: ${err.message}`);
  process.exit(1);
});
