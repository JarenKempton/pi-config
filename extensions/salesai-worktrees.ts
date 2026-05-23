import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = `${process.env.HOME}/.pi/agent/bin/salesai-worktree.sh`;

type Worktree = { path: string; branch: string };
type ProgressUpdate = { step: string; lines: string[]; index: number };

function run(command: string, args: string[], cwd = process.cwd()): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function worktrees(cwd = process.cwd()): Worktree[] {
  const raw = run('git', ['worktree', 'list', '--porcelain'], cwd);
  const items: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) items.push(current);
      current = { path: line.slice('worktree '.length), branch: '(unknown)' };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (current && line === 'detached') {
      current.branch = '(detached)';
    }
  }
  if (current) items.push(current);
  return items;
}

function label(wt: Worktree): string {
  return `${path.basename(wt.path)} — ${wt.branch} — ${wt.path}`;
}

function clip(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stepIndexFor(mode: 'create' | 'delete', step: string): number {
  const text = step.toLowerCase();
  const checks = mode === 'create'
    ? [
        /resolving|resolved branch|no existing branch|jira summary/,
        /target path|fetching/,
        /creating worktree|using existing|creating new branch|preparing worktree/,
        /copied .*\.env|installing dependencies|added .*packages|audited .*packages/,
        /generating api client|worktree_path=/,
      ]
    : [
        /checking worktree status/,
        /removing|force removing/,
        /leftover|pruning/,
        /checking whether branch|deleting .*branch|left local branch/,
        /removed worktree/,
      ];
  const index = checks.findIndex((pattern) => pattern.test(text));
  return index === -1 ? -1 : index;
}

function renderProgress(ctx: any, title: string, progress: ProgressUpdate, mode: 'create' | 'delete') {
  const steps = mode === 'create'
    ? ['Resolve branch', 'Choose path', 'Create worktree', 'Bootstrap dependencies', 'Finish']
    : ['Check status', 'Remove worktree', 'Clean directory', 'Clean branch', 'Finish'];
  const activeIndex = progress.index;

  ctx.ui.setWidget('worktrees-progress', (_tui: any, theme: any) => ({
    invalidate() {},
    render() {
      return [
        theme.fg('accent', `╭─ ${clip(title)}`),
        theme.fg('accent', '│ ') + theme.fg('success', clip(progress.step)),
        theme.fg('accent', '│'),
        ...steps.map((step, index) => {
          const marker = index < activeIndex ? theme.fg('success', '✓') : index === activeIndex ? theme.fg('accent', '●') : theme.fg('dim', '○');
          const label = index === activeIndex ? theme.fg('accent', step) : index < activeIndex ? theme.fg('success', step) : theme.fg('dim', step);
          return theme.fg('accent', '│ ') + `${marker} ${label}`;
        }),
        theme.fg('accent', '╰─'),
      ];
    },
  }));
  ctx.ui.setStatus('worktrees', '');
}

function clearProgress(ctx: any) {
  ctx.ui.setWidget('worktrees-progress', undefined);
  ctx.ui.setStatus('worktrees', '');
}

function finalPathFrom(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('WORKTREE_PATH='));
  if (marker) return marker.slice('WORKTREE_PATH='.length);
  return lines.find((line) => line.startsWith('/')) ?? output.trim();
}

function summarizeDelete(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const removed = [...lines].reverse().find((line) => line.startsWith('Removed worktree:'))?.replace('Removed worktree:', '').trim();
  const branchDeleted = [...lines].reverse().find((line) => line.startsWith('Deleted branch '));
  const branchKept = [...lines].reverse().find((line) => line.startsWith('Left local branch in place'));
  const branchFailed = lines.find((line) => line.includes('is not fully merged'));

  const summary = ['Worktree deleted.'];
  if (removed) summary.push(`Removed: ${removed}`);
  if (branchDeleted) summary.push(branchDeleted.replace(/ \(was [^)]+\)\.?$/, '.'));
  else if (branchKept) summary.push(branchKept);
  else if (branchFailed) summary.push('Local branch was left in place because it is not fully merged.');
  return summary.join('\n');
}

function runScript(
  mode: 'create' | 'delete',
  context = '',
  onProgress?: (line: string) => void,
): Promise<string> {
  const args = context ? [SCRIPT, mode, context] : [SCRIPT, mode];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, {
      cwd: process.cwd(),
      env: { ...process.env, SALES_WORKTREE_ASSUME_YES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';

    const handleProgress = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const clean = line.trim();
        if (clean) onProgress?.(clean);
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      handleProgress(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      handleProgress(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const cleanPending = pending.trim();
      if (cleanPending) onProgress?.(cleanPending);
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (code === 0) resolve(output);
      else reject(new Error(output || `worktree ${mode} failed`));
    });
  });
}

async function runWithProgress(ctx: any, mode: 'create' | 'delete', context: string) {
  const title = mode === 'create' ? 'Creating SalesAI worktree' : 'Deleting SalesAI worktree';
  const progress: ProgressUpdate = { step: `Starting ${mode}…`, lines: [], index: 0 };
  renderProgress(ctx, title, progress, mode);
  try {
    const output = await runScript(mode, context, (line) => {
      const nextIndex = stepIndexFor(mode, line);
      if (nextIndex >= 0) progress.index = Math.max(progress.index, nextIndex);
      progress.step = line;
      progress.lines.push(line);
      renderProgress(ctx, title, progress, mode);
    });
    if (mode === 'create') {
      const finalPath = finalPathFrom(output);
      ctx.ui.notify(`Worktree ready. Copy/paste:\n\ncd ${finalPath}`, 'success');
    } else {
      ctx.ui.notify(summarizeDelete(output), 'success');
    }
  } finally {
    clearProgress(ctx);
  }
}

function copyPath(value: string) {
  spawnSync('pbcopy', { input: value, encoding: 'utf8' });
}

export default function salesaiWorktrees(pi: ExtensionAPI) {
  pi.registerCommand('worktrees', {
    description: 'Select, copy path, delete, or create a SalesAI worktree',
    handler: async (_args, ctx) => {
      let list: Worktree[];
      try {
        list = worktrees(ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`Unable to list worktrees: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      }

      const create = '＋ Create worktree';
      const selected = await ctx.ui.select('SalesAI worktrees', [...list.map(label), create]);
      if (!selected) return;

      if (selected === create) {
        const input = await ctx.ui.input('Jira ticket / URL, PR URL, or branch name', 'CSU-1234');
        if (!input?.trim()) return;
        try {
          await runWithProgress(ctx, 'create', input.trim());
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
        return;
      }

      const wt = list.find((item) => label(item) === selected);
      if (!wt) return;
      const action = await ctx.ui.select(`Worktree: ${path.basename(wt.path)}`, ['Copy path', 'Delete worktree', 'Cancel']);
      if (action === 'Copy path') {
        copyPath(wt.path);
        ctx.ui.notify(`Copied path to clipboard:\n${wt.path}`, 'info');
      } else if (action === 'Delete worktree') {
        const ok = await ctx.ui.confirm('Delete worktree?', `${wt.path}\n\nThis may delete uncommitted files if you approve force deletion in the cleanup flow.`);
        if (!ok) return;
        try {
          await runWithProgress(ctx, 'delete', wt.path);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      }
    },
  });

  pi.registerCommand('create-worktree', {
    description: 'Create or reuse a SalesAI worktree from a Jira ticket / URL, PR URL, or branch name',
    handler: async (args, ctx) => {
      const context = args.trim() || (await ctx.ui.input('Jira ticket / URL, PR URL, or branch name', 'CSU-1234'))?.trim();
      if (!context) return;
      try {
        await runWithProgress(ctx, 'create', context);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  pi.registerCommand('delete-worktree', {
    description: 'Delete a SalesAI worktree by Jira ticket / URL, PR URL, branch name, or path',
    handler: async (args, ctx) => {
      const context = args.trim() || (await ctx.ui.input('Jira ticket / URL, PR URL, branch name, or path', 'CSU-1234'))?.trim();
      if (!context) return;
      const ok = await ctx.ui.confirm('Delete matching worktree?', context);
      if (!ok) return;
      try {
        await runWithProgress(ctx, 'delete', context);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
