/**
 * Plugin system — folder-based.
 *
 * Each plugin is a .js file in the `plugins/` directory that exports:
 *   name        — string
 *   description — string
 *   tools       — array of OpenAI-format tool definitions
 *   execute(toolName, params) → Promise<object>
 *
 * Example plugin (plugins/example.js):
 *   export const name = 'example';
 *   export const description = 'Example plugin';
 *   export const tools = [{
 *     type: 'function',
 *     function: { name: 'greet', description: 'Greet someone',
 *       parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
 *     }
 *   }];
 *   export async function execute(toolName, params) {
 *     if (toolName === 'greet') return { message: `Hello, ${params.name}!` };
 *   }
 */

import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

export class PluginManager {
  constructor(workDir = process.cwd()) {
    this.workDir = workDir;
    this.plugins = new Map();
    this.tools = [];
  }

  async load() {
    const pluginsDir = resolve(this.workDir, 'plugins');
    if (!existsSync(pluginsDir)) return;

    let files;
    try {
      files = await readdir(pluginsDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      try {
        const url = pathToFileURL(join(pluginsDir, file)).href;
        const mod = await import(url);
        if (mod.name && Array.isArray(mod.tools) && typeof mod.execute === 'function') {
          this.plugins.set(mod.name, mod);
          this.tools.push(...mod.tools);
        }
      } catch (err) {
        // Non-fatal: just warn
        console.error(`  [plugin] Failed to load ${file}: ${err.message}`);
      }
    }
  }

  /** Returns result or null if no plugin owns this tool. */
  async tryExecute(toolName, params) {
    for (const plugin of this.plugins.values()) {
      const owns = plugin.tools.some(
        (t) => (t.function?.name ?? t.name) === toolName
      );
      if (owns) {
        return plugin.execute(toolName, params);
      }
    }
    return null;
  }

  allTools() {
    return this.tools;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      description: p.description ?? '',
      toolCount: p.tools.length,
    }));
  }
}
