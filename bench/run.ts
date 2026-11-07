#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { grade, openPages, type Page } from './grade.ts';

const BENCH = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(BENCH, '..');
const WORK = process.env.BENCH_WORK ?? join(BENCH, '.work');
const TOOLS_DIR = join(WORK, 'tools');
const RUNS = process.env.BENCH_RUNS ?? '/tmp/bcb';
const MODEL = process.env.BENCH_MODEL ?? 'claude-sonnet-5-5';
const BUDGET = Number(process.env.BENCH_BUDGET_USD ?? 60);
const RUN_TIMEOUT_MS = Number(process.env.BENCH_RUN_TIMEOUT_S ?? 900) * 1000;
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const spec = JSON.parse(readFileSync(join(BENCH, 'tasks.json'), 'utf8')) as {
  suffix: string;
  isolationSuffix: string;
  tasks: { id: string; host: string; prompt: string; marks: string[] }[];
  isolation: string[];
};

function chromeBinary(): string {
  const fromEnv = process.env.BENCH_CHROME;
  if (fromEnv) return fromEnv;
  const file = join(TOOLS_DIR, 'chrome-path');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  throw new Error('No Chrome for Testing: run bench/setup.sh or set BENCH_CHROME');
}

const sh = (cmd: string[], env?: Record<string, string>) => {
  const r = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  return (r.stdout.toString() + r.stderr.toString()).trim();
};

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => ok(port));
    });
    srv.on('error', fail);
  });
}

async function waitForCdp(port: number, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser: string };
      return v.Browser;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`Chrome on port ${port} did not answer`);
}

const CHROME_FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--window-size=1512,982',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--ozone-platform=headless', '--use-angle=swiftshader-webgl',
];

async function launchChrome(dir: string): Promise<{ port: number; version: string; dir: string; stop: () => void }> {
  const port = await freePort();
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn(
    [chromeBinary(), '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, ...CHROME_FLAGS, 'about:blank'],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const version = await waitForCdp(port);
  return { port, version, dir, stop: () => proc.kill('SIGKILL') };
}

const chromeVersion = () => sh([chromeBinary(), '--version']);

type Ctx = { id: string; dir: string; home: string; bin: string; port: number };

type Tool = {
  name: string;
  cmd: string;
  version: () => string;
  skill: () => string;
  env: (ctx: Ctx) => Record<string, string>;
  real: () => string;
  setup?: (ctx: Ctx, run: (args: string[]) => string) => void;
  probe: string;
};

const venvBin = (venv: string, name: string) => join(TOOLS_DIR, venv, 'bin', name);
const sitePackages = (venv: string) => {
  const lib = join(TOOLS_DIR, venv, 'lib');
  return join(lib, readdirSync(lib).find((d) => d.startsWith('python'))!, 'site-packages');
};

const TOOLS: Record<string, Tool> = {
  'browser-cli': {
    name: 'browser-cli',
    cmd: 'browser',
    real: () => {
      const dist = join(REPO, 'dist', `${process.platform}-${process.arch}`, 'browser');
      if (!existsSync(dist)) throw new Error(`no local build at ${dist}: run scripts/build.sh --skip-tests`);
      return dist;
    },
    version: () => {
      const dirty = sh(['git', '-C', REPO, 'status', '--porcelain', '--', 'src', 'skills']) ? '+dirty' : '';
      return `${sh([TOOLS['browser-cli'].real(), '--version'])} (${sh(['git', '-C', REPO, 'rev-parse', '--short', 'HEAD'])}${dirty})`;
    },
    skill: () => join(REPO, 'skills', 'browser'),
    env: (ctx) => ({ HOME: ctx.home, BROWSER_SKILLS_DIR: join(REPO, 'skills') }),
    setup: (ctx, run) => {
      run(['profiles', 'add', 'bench', '--browser', 'custom', '--binary', chromeBinary(), '--endpoint', `http://127.0.0.1:${ctx.port}`, '--attach-only']);
      run(['use', 'bench']);
    },
    probe: 'browser start --url https://example.com/ && browser text',
  },
  'browser-use': {
    name: 'browser-use',
    cmd: 'browser-use',
    real: () => venvBin('browser-use', 'browser-use'),
    version: () => sh([venvBin('browser-use', 'python'), '-c', 'import importlib.metadata as m; print(m.version("browser-use"))']),
    skill: () => join(sitePackages('browser-use'), 'browser_use', 'skills', 'browser-use'),
    env: (ctx) => ({ HOME: ctx.home, BU_CDP_URL: `http://127.0.0.1:${ctx.port}`, ANONYMIZED_TELEMETRY: 'false' }),
    probe: "browser-use <<'PY'\nnew_tab('https://example.com/')\nprint(page_info())\nPY",
  },
  'browser-harness': {
    name: 'browser-harness',
    cmd: 'browser-harness',
    real: () => venvBin('browser-harness', 'browser-harness'),
    version: () => sh([venvBin('browser-harness', 'python'), '-c', 'import importlib.metadata as m; print(m.version("browser-harness"))']),
    skill: () => join(sitePackages('browser-harness'), 'browser_harness', 'SKILL.md'),
    env: (ctx) => ({ HOME: ctx.home, BU_CDP_URL: `http://127.0.0.1:${ctx.port}`, ANONYMIZED_TELEMETRY: 'false' }),
    probe: "browser-harness <<'PY'\nnew_tab('https://example.com/')\nprint(page_info())\nPY",
  },
  'agent-browser': {
    name: 'agent-browser',
    cmd: 'agent-browser',
    real: () => join(TOOLS_DIR, 'agent-browser', 'node_modules', '.bin', 'agent-browser'),
    version: () => sh([TOOLS['agent-browser'].real(), '--version']).replace(/^agent-browser\s*/, ''),
    skill: () => join(TOOLS_DIR, 'agent-browser', 'node_modules', 'agent-browser', 'skills', 'agent-browser'),
    env: (ctx) => ({ HOME: ctx.home, AGENT_BROWSER_CDP: String(ctx.port) }),
    probe: 'agent-browser open https://example.com/ && agent-browser get title',
  },
};

function pickTools(arg?: string): Tool[] {
  const names = arg ? arg.split(',') : ['browser-cli', 'browser-use', 'browser-harness', 'agent-browser'];
  return names.map((n) => {
    const tool = TOOLS[n];
    if (!tool) throw new Error(`unknown tool ${n}; known: ${Object.keys(TOOLS).join(', ')}`);
    return tool;
  });
}

function prepare(tool: Tool, id: string, port: number): Ctx {
  const dir = join(RUNS, id);
  rmSync(dir, { recursive: true, force: true });
  const ctx: Ctx = { id, dir, home: join(dir, 'home'), bin: join(dir, 'bin'), port };
  for (const d of [ctx.home, ctx.bin, join(dir, 'project', '.claude', 'skills')]) mkdirSync(d, { recursive: true });
  const env = { ...tool.env(ctx), BENCH_RUN: id };
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
    .join('\n');
  writeFileSync(join(ctx.bin, tool.cmd), `#!/bin/sh\n${exports}\nexec '${tool.real()}' "$@"\n`, { mode: 0o755 });
  const skillDir = join(dir, 'project', '.claude', 'skills', tool.cmd === 'browser' ? 'browser' : tool.name);
  const skill = tool.skill();
  cpSync(skill, skill.endsWith('.md') ? join(skillDir, 'SKILL.md') : skillDir, { recursive: true });
  tool.setup?.(ctx, (args) => sh([join(ctx.bin, tool.cmd), ...args]));
  return ctx;
}

function reap(id: string) {
  if (!existsSync('/proc')) return;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`BENCH_RUN=${id}`)) process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
type AgentResult = {
  exit: number | null;
  timedOut: boolean;
  startedAt: string;
  seconds: number;
  turns: number | null;
  costUsd: number | null;
  tokens: { input: number; cacheCreation: number; cacheRead: number; output: number; total: number } | null;
  answer: string;
  claudeVersion: string;
  skills: string[];
  plugins: string[];
  toolOutputs: { command: string; output: string }[];
  error: string | null;
  tools: string[];
  permissionDenials: unknown[];
};

async function runAgent(tool: Tool, ctx: Ctx, prompt: string): Promise<AgentResult> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const transcript = join(ctx.dir, 'transcript.jsonl');
  const proc = Bun.spawn(
    [
      CLAUDE, '-p', prompt,
      '--model', MODEL,
      '--output-format', 'stream-json', '--verbose',
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--allowedTools', `Bash(${tool.cmd}:*)`, 'Skill',
      '--disallowedTools', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Write', 'Edit', 'NotebookEdit',
      '--max-turns', '60',
    ],
    {
      cwd: join(ctx.dir, 'project'),
      env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), proc.kill('SIGKILL')), RUN_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(timer);
  writeFileSync(transcript, out);
  writeFileSync(join(ctx.dir, 'stderr.txt'), err);
  const seconds = (performance.now() - t0) / 1000;

  const events = out.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
  const result = events.findLast((e) => e.type === 'result');
  const commands = new Map<string, string>();
  const toolOutputs: { command: string; output: string }[] = [];
  for (const e of events) {
    for (const block of e.message?.content ?? []) {
      if (block.type === 'tool_use') commands.set(block.id, String(block.input?.command ?? JSON.stringify(block.input)));
      if (block.type === 'tool_result') {
        const text = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? '').join('\n') : String(block.content ?? '');
        toolOutputs.push({ command: commands.get(block.tool_use_id) ?? '', output: text });
      }
    }
  }
  const u: Usage = result?.usage ?? {};
  const tokens = result
    ? {
        input: u.input_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        total: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
      }
    : null;
  return {
    exit,
    timedOut,
    startedAt,
    seconds,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    tokens,
    answer: String(result?.result ?? '').slice(0, 4000),
    claudeVersion: String(init.claude_code_version ?? ''),
    skills: (init.skills ?? []).map(String),
    plugins: (init.plugins ?? []).map((p: { name?: string }) => String(p.name ?? p)),
    toolOutputs,
    error: timedOut ? null : !result ? `no result event (exit ${exit}): ${err.slice(-300)}` : result.is_error && result.subtype !== 'error_max_turns' ? String(result.result ?? result.subtype).slice(0, 300) : null,
    tools: (init.tools ?? []).map(String),
    permissionDenials: result?.permission_denials ?? [],
  };
}

function args(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
  return out;
}

function readResults(dir: string): any[] {
  if (!existsSync(dir)) return [];
  const out: any[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith('.json') && statSync(join(dir, entry)).isFile()) out.push(JSON.parse(readFileSync(join(dir, entry), 'utf8')));
  }
  return out;
}

const costOf = (r: any): number => r.costUsd ?? r.agents?.reduce((sum: number, a: any) => sum + (a.costUsd ?? 0), 0) ?? 0;
const KINDS = ['suite', 'isolation', 'errors'];

function overBudget(outDir: string, remaining: number): string | undefined {
  const spent = KINDS.flatMap((k) => readResults(join(dirname(outDir), k))).map(costOf).reduce((a, b) => a + b, 0);
  const same = readResults(outDir).map(costOf);
  const mean = same.length ? same.reduce((a, b) => a + b, 0) / same.length : 0;
  const projected = spent + mean * remaining;
  if (projected > BUDGET) return `projected $${projected.toFixed(2)} (spent $${spent.toFixed(2)}) passes the $${BUDGET} budget`;
}

async function suite(opts: Record<string, string>) {
  const tools = pickTools(opts.tools);
  const runs = Number(opts.runs ?? 5);
  const tasks = opts.tasks ? spec.tasks.filter((t) => opts.tasks.split(',').includes(t.id)) : spec.tasks;
  const outDir = resolve(opts.out ?? join(BENCH, 'results', new Date().toISOString().slice(0, 10), 'suite'));
  const plan: { trial: number; task: (typeof tasks)[number]; tool: Tool }[] = [];
  for (let trial = 1; trial <= runs; trial++)
    tasks.forEach((task, i) => {
      for (let k = 0; k < tools.length; k++) plan.push({ trial, task, tool: tools[(k + i + trial) % tools.length] });
    });
  const versions = Object.fromEntries(tools.map((t) => [t.name, t.version()]));
  for (const [n, { trial, task, tool }] of plan.entries()) {
    const file = join(outDir, tool.name, `${task.id}-${trial}.json`);
    if (existsSync(file)) continue;
    const stop = overBudget(outDir, plan.length - n);
    if (stop) return console.log(`Stopping: ${stop}`);
    const id = `s${Date.now().toString(36)}`;
    const chrome = await launchChrome(join(RUNS, `${id}-chrome`));
    const ctx = prepare(tool, id, chrome.port);
    try {
      const r = await runAgent(tool, ctx, `${task.prompt} ${spec.suffix}`);
      const pages = await openPages(chrome.port).catch((): Page[] => []);
      const g = await grade(task.id, pages, r.answer);
      const record = {
        kind: 'suite', tool: tool.name, toolVersion: versions[tool.name], task: task.id, trial, model: MODEL,
        chrome: chromeVersion(),
        correct: g.correct, grade: g.detail, ...stripOutputs(r),
        openTabs: pages.map((p) => p.url),
      };
      save(outDir, file, record, r.error ?? (g.error ? g.detail : null));
      console.log(`${tool.name} ${task.id} #${trial}: ${g.correct ? 'correct' : 'WRONG'} ${r.turns} turns ${r.seconds.toFixed(1)} s $${(r.costUsd ?? 0).toFixed(4)} (${g.detail})`);
    } finally {
      reap(id);
      chrome.stop();
      rmSync(chrome.dir, { recursive: true, force: true });
    }
  }
}

function save(outDir: string, file: string, record: object, failure: string | null) {
  const target = failure ? join(dirname(outDir), 'errors', `${relative(outDir, file).replace(/[\\/]/g, '-').replace(/\.json$/, '')}-${Date.now()}.json`) : file;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, scrub(JSON.stringify(failure ? { ...record, failure } : record, null, 2)) + '\n');
  if (failure) console.log(`  not counted: ${failure}`);
}

const LOCAL_PATHS: [string, string][] = [[RUNS, '<run>'], [REPO, '<checkout>'], [process.env.HOME ?? '', '~']];
const scrub = (text: string) => LOCAL_PATHS.reduce((t, [path, name]) => (path ? t.split(path).join(name) : t), text);

function stripOutputs(r: AgentResult) {
  const { toolOutputs, ...rest } = r;
  return { ...rest, toolCalls: toolOutputs.length };
}

async function isolation(opts: Record<string, string>) {
  const tools = pickTools(opts.tools);
  const runs = Number(opts.runs ?? 10);
  const outDir = resolve(opts.out ?? join(BENCH, 'results', new Date().toISOString().slice(0, 10), 'isolation'));
  const tasks = spec.isolation.map((id) => spec.tasks.find((t) => t.id === id)!);
  const plan: { trial: number; tool: Tool }[] = [];
  for (let trial = 1; trial <= runs; trial++) tools.forEach((_, k) => plan.push({ trial, tool: tools[(k + trial) % tools.length] }));
  for (const [n, { trial, tool }] of plan.entries()) {
    const file = join(outDir, tool.name, `trial-${trial}.json`);
    if (existsSync(file)) continue;
    const stop = overBudget(outDir, plan.length - n);
    if (stop) return console.log(`Stopping: ${stop}`);
    const id = `i${Date.now().toString(36)}`;
    const chrome = await launchChrome(join(RUNS, `${id}-chrome`));
    const ctx = prepare(tool, id, chrome.port);
    const projectFor = (task: string) => {
      const dir = join(ctx.dir, `agent-${task}`);
      cpSync(join(ctx.dir, 'project'), join(dir, 'project'), { recursive: true });
      return { ...ctx, dir };
    };
    try {
      const t0 = Date.now();
      const results = await Promise.all(tasks.map((task) => runAgent(tool, projectFor(task.id), `${task.prompt} ${spec.isolationSuffix} ${spec.suffix}`)));
      const wall = (Date.now() - t0) / 1000;
      const pages = await openPages(chrome.port).catch((): Page[] => []);
      const agents = [];
      const graderErrors: string[] = [];
      for (const [i, task] of tasks.entries()) {
        const r = results[i];
        const others = tasks.filter((t) => t.id !== task.id).flatMap((t) => t.marks);
        const leaks = r.toolOutputs.filter((o) => others.some((h) => o.output.includes(h)));
        const g = await grade(task.id, pages, r.answer);
        if (g.error) graderErrors.push(`${task.id}: ${g.detail}`);
        agents.push({
          task: task.id, correct: g.correct, grade: g.detail, ...stripOutputs(r),
          sawOtherAgentsTab: leaks.length > 0,
          leakingCommands: leaks.map((l) => ({ command: l.command.slice(0, 300), seen: others.filter((h) => l.output.includes(h)) })),
        });
      }
      const failure = results.map((r) => r.error).find(Boolean) ?? graderErrors[0] ?? null;
      const record = { kind: 'isolation', tool: tool.name, toolVersion: tool.version(), trial, model: MODEL, wallSeconds: wall, agents };
      save(outDir, file, record, failure);
      console.log(`${tool.name} isolation #${trial}: solved ${agents.filter((a) => a.correct).length}/3, saw another tab ${agents.filter((a) => a.sawOtherAgentsTab).length}/3, ${wall.toFixed(0)} s`);
    } finally {
      reap(id);
      chrome.stop();
      rmSync(chrome.dir, { recursive: true, force: true });
    }
  }
}

async function check(opts: Record<string, string>) {
  for (const tool of pickTools(opts.tools)) {
    const id = `c${Date.now().toString(36)}`;
    let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
    try {
      chrome = await launchChrome(join(RUNS, `${id}-chrome`));
      const ctx = prepare(tool, id, chrome.port);
      const out = sh(['bash', '-c', tool.probe], { PATH: `${ctx.bin}:${process.env.PATH}` });
      const pages = await openPages(chrome.port).catch((): Page[] => []);
      const ok = pages.some((p) => p.url.startsWith('https://example.com') && /Example Domain/.test(p.title + p.text));
      console.log(`${tool.name} ${tool.version()}: ${ok ? 'ok' : 'FAILED'} (${chromeVersion()}, ${pages.length} open tab(s))`);
      if (!ok) console.log(out.slice(0, 2000), JSON.stringify(pages).slice(0, 1000));
      reap(id);
    } catch (error) {
      console.log(`${tool.name}: FAILED ${(error as Error).message}`);
    } finally {
      chrome?.stop();
      if (chrome) rmSync(chrome.dir, { recursive: true, force: true });
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function summary(opts: Record<string, string>) {
  const root = resolve(opts.out ?? join(BENCH, 'results', new Date().toISOString().slice(0, 10)));
  const suiteRuns = readResults(join(root, 'suite'));
  const lines: string[] = [];
  if (suiteRuns.length) {
    lines.push('| Tool | Version | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |', '|---|---|---:|---:|---:|---:|---:|');
    const by = Object.groupBy(suiteRuns, (r) => r.tool);
    for (const [tool, rs] of Object.entries(by)) {
      const ok = rs!.filter((r) => r.costUsd != null);
      lines.push(
        `| ${tool} | ${rs![0].toolVersion} | ${rs!.filter((r) => r.correct).length}/${rs!.length} | ${mean(ok.map((r) => r.turns)).toFixed(2)} | ${mean(rs!.map((r) => r.seconds)).toFixed(1)} | ${(mean(ok.map((r) => r.tokens.total)) / 1000).toFixed(0)}k | $${mean(ok.map((r) => r.costUsd)).toFixed(4)} |`,
      );
    }
    lines.push('', '| Task | ' + Object.keys(by).join(' | ') + ' |', '|---|' + Object.keys(by).map(() => '---|').join(''));
    for (const task of spec.tasks.map((t) => t.id)) {
      const cells = Object.keys(by).map((tool) => {
        const rs = suiteRuns.filter((r) => r.tool === tool && r.task === task);
        return rs.length ? `${rs.filter((r) => r.correct).length}/${rs.length}, ${mean(rs.map((r) => r.turns)).toFixed(1)} turns, ${mean(rs.map((r) => r.seconds)).toFixed(0)} s` : '';
      });
      lines.push(`| ${task} | ${cells.join(' | ')} |`);
    }
  }
  const iso = readResults(join(root, 'isolation'));
  if (iso.length) {
    lines.push('', '| Tool | Version | Tasks solved | Agent runs that saw another agent\'s tab | Wall seconds/trial |', '|---|---|---:|---:|---:|');
    for (const [tool, rs] of Object.entries(Object.groupBy(iso, (r) => r.tool))) {
      const agents = rs!.flatMap((r) => r.agents);
      lines.push(
        `| ${tool} | ${rs![0].toolVersion} | ${agents.filter((a) => a.correct).length}/${agents.length} | ${agents.filter((a) => a.sawOtherAgentsTab).length}/${agents.length} | ${mean(rs!.map((r) => r.wallSeconds)).toFixed(0)} |`,
      );
    }
  }
  const spent = [...suiteRuns.map((r) => r.costUsd ?? 0), ...iso.flatMap((r) => r.agents.map((a: any) => a.costUsd ?? 0))].reduce((a, b) => a + b, 0);
  lines.push('', `Runs: ${suiteRuns.length} suite, ${iso.length} isolation trials. Model spend reported by Claude Code: $${spent.toFixed(2)}.`);
  const text = lines.join('\n');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'summary.md'), text + '\n');
  console.log(text);
}

const [command, ...rest] = process.argv.slice(2);
const opts = args(rest);
mkdirSync(WORK, { recursive: true });
if (command === 'suite') await suite(opts);
else if (command === 'isolation') await isolation(opts);
else if (command === 'check') await check(opts);
else if (command === 'summary') summary(opts);
else {
  console.log('Usage: bun bench/run.ts check|suite|isolation|summary [--tools a,b] [--runs n] [--tasks a,b] [--out dir]');
  process.exit(command ? 1 : 0);
}
