/**
 * @s0nderlabs/anima-plugin-system: battery-included filesystem + shell + skills tools.
 *
 * Native plugin shape: exports a default `register(ctx)` consumed by anima's
 * loader. The ctx exposes `registerTool`, `registerListener`, `addHook`. Tools
 * registered here ride through the same approval/permission floor as any other
 * registered tool; chat.tsx hooks `pre_tool_call` to enforce.
 */

import type { NativePlugin, ToolDef } from '@s0nderlabs/anima-core'
import { makeFsPatch, makeFsRead, makeFsSearch, makeFsWrite } from './fs'
import { makeShellRun } from './shell'
import { makeSkillsList, makeSkillsView } from './skills'
import { makeClarify, makeTodo } from './todo'

export {
  makeFsRead,
  makeFsWrite,
  makeFsPatch,
  makeFsSearch,
  makeShellRun,
  makeTodo,
  makeClarify,
  makeSkillsList,
  makeSkillsView,
}

const plugin: NativePlugin = {
  name: 'system',
  register: ctx => {
    const workspaceRoot = process.cwd()
    const fsDeps = { workspaceRoot, agentDir: ctx.agentDir }
    const skillsDeps = { importsClaudeCode: true }
    const tools: ToolDef[] = [
      makeFsRead(fsDeps) as ToolDef,
      makeFsWrite(fsDeps) as ToolDef,
      makeFsPatch(fsDeps) as ToolDef,
      makeFsSearch(fsDeps) as ToolDef,
      makeShellRun({ cwd: workspaceRoot }) as ToolDef,
      makeTodo() as ToolDef,
      makeClarify() as ToolDef,
      makeSkillsList(skillsDeps) as ToolDef,
      makeSkillsView(skillsDeps) as ToolDef,
    ]
    for (const t of tools) ctx.registerTool(t)
  },
}

export default plugin
