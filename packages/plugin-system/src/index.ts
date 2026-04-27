/**
 * @s0nderlabs/anima-plugin-system: battery-included filesystem + shell + skills tools.
 *
 * Native plugin shape: exports a default `register(ctx)` consumed by anima's
 * loader. The ctx exposes `registerTool`, `registerListener`, `addHook`. Tools
 * registered here ride through the same approval/permission floor as any other
 * registered tool; chat.tsx hooks `pre_tool_call` to enforce.
 */

import type { NativePlugin, ToolDef } from '@s0nderlabs/anima-core'
import {
  makeBrowserBack,
  makeBrowserClick,
  makeBrowserConsole,
  makeBrowserGetImages,
  makeBrowserNavigate,
  makeBrowserPress,
  makeBrowserScroll,
  makeBrowserSnapshot,
  makeBrowserType,
  makeBrowserVision,
} from './browser'
import { makeCodeExecute } from './code-execute'
import { makeDelegateTask, makeVisionAnalyze } from './delegate'
import { makeFsPatch, makeFsRead, makeFsSearch, makeFsWrite } from './fs'
import { makeSessionSearch } from './session-search'
import { makeShellRun } from './shell'
import { makeShellProcess } from './shell-process'
import { makeSkillsList, makeSkillsView } from './skills'
import { makeSkillsManage } from './skills-manage'
import { makeClarify, makeTodo } from './todo'

export {
  makeFsRead,
  makeFsWrite,
  makeFsPatch,
  makeFsSearch,
  makeShellRun,
  makeShellProcess,
  makeTodo,
  makeClarify,
  makeSkillsList,
  makeSkillsView,
  makeSkillsManage,
  makeSessionSearch,
  makeCodeExecute,
  makeDelegateTask,
  makeVisionAnalyze,
  makeBrowserNavigate,
  makeBrowserSnapshot,
  makeBrowserClick,
  makeBrowserType,
  makeBrowserScroll,
  makeBrowserBack,
  makeBrowserPress,
  makeBrowserGetImages,
  makeBrowserVision,
  makeBrowserConsole,
}
export { killAllProcesses } from './shell-process'

const plugin: NativePlugin = {
  name: 'system',
  register: ctx => {
    const workspaceRoot = ctx.workspaceRoot ?? process.cwd()
    const fsDeps = { workspaceRoot, agentDir: ctx.agentDir }
    const skillsDeps = {
      importsClaudeCode: ctx.imports.claudeCode,
      disabled: ctx.skillsDisabled.current,
    }
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
      makeSkillsManage({
        importsClaudeCode: ctx.imports.claudeCode,
        configPath: ctx.configPath,
        disabledRef: ctx.skillsDisabled,
      }) as ToolDef,
      makeSessionSearch({ activityLogPath: ctx.activityLogPath }) as ToolDef,
      makeCodeExecute({ cwd: workspaceRoot }) as ToolDef,
      makeShellProcess({ cwd: workspaceRoot }) as ToolDef,
      makeVisionAnalyze({
        supportsVision: ctx.brainSupportsVision,
        modelLabel: ctx.brainModelLabel ?? undefined,
      }) as ToolDef,
      makeBrowserNavigate({}) as ToolDef,
      makeBrowserSnapshot({}) as ToolDef,
      makeBrowserClick({}) as ToolDef,
      makeBrowserType({}) as ToolDef,
      makeBrowserScroll({}) as ToolDef,
      makeBrowserBack({}) as ToolDef,
      makeBrowserPress({}) as ToolDef,
      makeBrowserGetImages({}) as ToolDef,
      makeBrowserConsole({}) as ToolDef,
      makeBrowserVision({
        supportsVision: ctx.brainSupportsVision,
        modelLabel: ctx.brainModelLabel ?? undefined,
      }) as ToolDef,
    ]
    if (ctx.delegateFactory) {
      tools.push(
        makeDelegateTask({
          makeBrain: ctx.delegateFactory,
          agents: ctx.claudeAgents,
        }) as ToolDef,
      )
    }
    for (const t of tools) ctx.registerTool(t)
  },
}

export default plugin
